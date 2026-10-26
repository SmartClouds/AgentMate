import type { Project } from '@runova/core';
import type { BrowserElementShot } from '@shared/apiTypes';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import { IDLE, type PickIntent, pickerReducer } from '@/lib/browser/pickerMachine';
import { copyElementContext, sendAnnotations } from '@/lib/browser/sendAnnotations';
import type { BrowserAnnotation, PickResult } from '@/lib/browser/types';
import { MAX_ANNOTATIONS_PER_TAB, markersFor, useBrowserStore } from '@/stores/browserStore';
import type { CommentDraft } from './CommentComposer';

/**
 * Drives the in-page picker of one browser tab: arms it, waits for picks, copies or opens the
 * comment card, takes the element's screenshot, and keeps the numbered pins on the page in step
 * with the tab's comments. The flow itself is the pure reducer in pickerMachine.ts.
 */

const NO_ANNOTATIONS: BrowserAnnotation[] = [];
/** How long Send waits for a screenshot still on its way, so the prompt can name it. */
const SHOT_WAIT_MS = 2500;

function noop(): void {
  // A page that went away mid-call; the next document gets the picker again.
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function usePagePicker({
  project,
  tabId,
  url,
  preset,
}: {
  project: Project;
  tabId: string;
  url: string;
  /** The device preset's label when one is on, for the prompt. */
  preset: string | null;
}) {
  const [state, dispatch] = useReducer(pickerReducer, IDLE);
  const [documentId, setDocumentId] = useState(0);
  const [shot, setShot] = useState<BrowserElementShot | null>(null);
  const shotRef = useRef<Promise<BrowserElementShot | null> | null>(null);
  const call = useCallback(
    <Result = unknown>(expression: string) => browserRuntime.picker<Result>(tabId, expression),
    [tabId],
  );

  // A new document has no picker in it yet: arm it again, and drop a card for the old page.
  useEffect(
    () =>
      browserRuntime.onDocumentReady(tabId, () => {
        setDocumentId((id) => id + 1);
        dispatch({ type: 'NAVIGATED' });
      }),
    [tabId],
  );

  const picking = state.mode === 'picking' ? state.intent : null;
  useEffect(() => {
    if (!picking) return;
    let live = true;
    const run = async (): Promise<void> => {
      await call('arm()');
      while (live) {
        const result = await call<PickResult>('awaitPick()');
        if (!live) return;
        if (!result || result.kind === 'cancel') {
          dispatch({ type: 'ESC' });
          return;
        }
        if (result.kind === 'copy' || picking === 'copy') {
          void copyElementContext(result.payload);
          continue;
        }
        dispatch({ type: 'PICKED', payload: result.payload, copy: false });
        return;
      }
    };
    run().catch(() => {
      if (live) dispatch({ type: 'STOP' });
    });
    return () => {
      live = false;
    };
    // documentId: a navigation needs the picker armed again in the new document.
  }, [picking, call, documentId]);

  // Picking stopped: take the picker's layer off the page so it can be used again.
  const active = state.mode !== 'idle';
  const activeRef = useRef(active);
  useEffect(() => {
    const was = activeRef.current;
    activeRef.current = active;
    if (was && !active) void call('disarm()').catch(noop);
  }, [active, call]);
  // The same when the tab goes off screen mid-pick, or the page would stay covered.
  useEffect(
    () => () => {
      if (activeRef.current) void browserRuntime.picker(tabId, 'disarm()').catch(noop);
    },
    [tabId],
  );

  // The element's screenshot, taken while the card is open and the highlight is held still.
  const payload = state.mode === 'composing' ? state.payload : null;
  useEffect(() => {
    if (!payload) return;
    setShot(null);
    const webContentsId = browserRuntime.state(tabId).webContentsId;
    const capture = async (): Promise<BrowserElementShot | null> => {
      await call('freeze()');
      if (webContentsId === null) return null;
      await call('setChromeHidden(true)');
      try {
        return await window.runova.browser.captureElement(
          webContentsId,
          payload.element.rectViewport,
          payload.page.viewport,
        );
      } catch {
        return null;
      } finally {
        await call('setChromeHidden(false)').catch(noop);
      }
    };
    const promise = capture().catch(() => null);
    shotRef.current = promise;
    let live = true;
    void promise.then((result) => {
      if (live) setShot(result);
    });
    return () => {
      live = false;
    };
  }, [payload, tabId, call]);

  // Pins for the comments on the page on screen.
  const annotations = useBrowserStore((s) => s.annotations[tabId]) ?? NO_ANNOTATIONS;
  const markers = useMemo(() => markersFor(annotations, url), [annotations, url]);
  const hadMarkers = useRef(false);
  useEffect(() => {
    if (markers.length === 0 && !hadMarkers.current) return;
    hadMarkers.current = markers.length > 0;
    void call(`setMarkers(${JSON.stringify(markers)})`).catch(noop);
  }, [markers, call, documentId]);

  // Esc while the app has focus (the page catches its own Esc while it has focus).
  useEffect(() => {
    if (state.mode !== 'picking') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isTyping(event.target)) return;
      dispatch({ type: 'ESC' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.mode]);

  const add = (draft: CommentDraft): string | null => {
    if (state.mode !== 'composing') return null;
    const { page, element } = state.payload;
    const store = useBrowserStore.getState();
    const id = store.addAnnotation({
      tabId,
      page,
      element,
      comment: draft.comment,
      intent: draft.intent,
      preset,
      screenshotPath: shot?.path ?? null,
      thumbDataUrl: shot?.thumbDataUrl ?? null,
    });
    if (!id) {
      toast.error(`A tab holds up to ${MAX_ANNOTATIONS_PER_TAB} comments`, {
        description: 'Send or clear the ones you have first.',
      });
      return null;
    }
    if (!shot) {
      void shotRef.current?.then((late) => {
        if (late) {
          useBrowserStore.getState().updateAnnotation(tabId, id, {
            screenshotPath: late.path,
            thumbDataUrl: late.thumbDataUrl,
          });
        }
      });
    }
    dispatch({ type: 'ADDED' });
    browserRuntime.focus(tabId);
    return id;
  };

  return {
    state,
    shot,
    start: (intent: PickIntent) => dispatch({ type: 'START', intent }),
    stop: () => dispatch({ type: 'STOP' }),
    cancelCard: () => {
      dispatch({ type: 'CANCEL' });
      browserRuntime.focus(tabId);
    },
    add,
    /** Adds the comment, then sends every comment of the tab. */
    sendNow: async (draft: CommentDraft): Promise<void> => {
      const pending = shotRef.current;
      if (!add(draft)) return;
      dispatch({ type: 'SENT' });
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, SHOT_WAIT_MS))]);
      await sendAnnotations(project, tabId);
    },
    flash: (id: string | null) => {
      if (id) void call(`flashMarker(${JSON.stringify(id)})`).catch(noop);
    },
    reveal: (id: string) => {
      void call(`reveal(${JSON.stringify(id)})`).catch(noop);
    },
  };
}
