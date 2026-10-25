import type {
  EditOp,
  EditResponse,
  LockHolderView,
  OpenVideoResult,
  StudioDocument,
  VideoStatusView,
  VideoSummary,
} from '@agentmat/studio';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioClient } from '../client';
import { errorMessage as message } from '../format';
import { toast } from '../kit';
import { studioKeys } from '../queryKeys';

/**
 * One open video in the editor: opens it (taking its folder's lock), applies edits in order, and
 * closes it when the editor goes away. Edits run one after another, each against the version the
 * last one produced, so a burst of typing never trips over itself; if something else changed the
 * video meanwhile (an AI edit), the editor takes the newer version and says so.
 */

export type VideoView =
  | { state: 'loading' }
  | { state: 'open'; video: VideoSummary; document: StudioDocument; status: VideoStatusView }
  | { state: 'locked'; holder: LockHolderView; stale: boolean }
  | { state: 'missing'; video: VideoSummary }
  | { state: 'error'; message: string };

export interface StudioVideo {
  view: VideoView;
  /** Resolves once the edit is saved, to false when it was refused or overtaken. */
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  restore: (seq: number) => Promise<void>;
  /** Takes in a version the service made on its own, like an applied AI proposal. */
  adopt: (result: EditResponse) => Promise<void>;
  takeOver: () => Promise<void>;
  reload: () => Promise<void>;
}

function toView(result: OpenVideoResult): VideoView {
  switch (result.state) {
    case 'open':
      return { state: 'open', ...result.session };
    case 'locked':
      return { state: 'locked', holder: result.holder, stale: result.stale };
    case 'missing':
      return { state: 'missing', video: result.video };
    case 'error':
      return { state: 'error', message: result.message };
  }
}

export function useStudioVideo(videoId: string): StudioVideo {
  const queryClient = useQueryClient();
  const [view, setView] = useState<VideoView>({ state: 'loading' });
  const viewRef = useRef(view);
  viewRef.current = view;
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const settle = useCallback(
    (document: StudioDocument, status: VideoStatusView) => {
      setView((current) => (current.state === 'open' ? { ...current, document, status } : current));
      void queryClient.invalidateQueries({ queryKey: studioKeys.history(videoId) });
    },
    [queryClient, videoId],
  );

  const open = useCallback(
    async (takeOver: boolean) => {
      try {
        const client = studioClient();
        setView(toView(await (takeOver ? client.takeOver(videoId) : client.open(videoId))));
      } catch (error) {
        setView({ state: 'error', message: message(error) });
      }
    },
    [videoId],
  );

  useEffect(() => {
    setView({ state: 'loading' });
    void open(false);
    return () => {
      // Closing writes the document and frees the folder for another copy of AgentMate.
      void studioClient()
        .close(videoId)
        .catch(() => undefined);
    };
  }, [open, videoId]);

  /** Runs `work` after every edit before it, so each one sees the version the last produced. */
  const enqueue = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(work, work);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const adopt = useCallback(
    (result: EditResponse) =>
      enqueue(async () => {
        const current = viewRef.current;
        if (current.state !== 'open' || result.seq < current.status.seq) return;
        settle(result.document, result.status);
        viewRef.current = { ...current, document: result.document, status: result.status };
      }),
    [enqueue, settle],
  );

  // A newer version made elsewhere (an AI scenario landing, mostly) is fetched and shown. The
  // editor's own edits announce themselves too; those are already in hand and are skipped.
  useEffect(() => {
    return studioClient().onEvent((event) => {
      if (event.type !== 'video-changed' || event.videoId !== videoId) return;
      void enqueue(async () => {
        const current = viewRef.current;
        if (current.state !== 'open' || current.status.seq >= event.seq) return;
        try {
          const result = await studioClient().open(videoId);
          if (result.state !== 'open') return;
          const { document, status } = result.session;
          settle(document, status);
          viewRef.current = { ...current, document, status };
        } catch {
          // The next change or a reload brings it in.
        }
      });
    });
  }, [enqueue, settle, videoId]);

  const apply = useCallback(
    (ops: EditOp[], label: string) =>
      enqueue(async () => {
        const current = viewRef.current;
        if (current.state !== 'open' || ops.length === 0) return false;
        try {
          const result = await studioClient().applyEdits({
            videoId,
            baseSeq: current.status.seq,
            ops,
            label,
          });
          settle(result.document, result.status);
          viewRef.current = { ...current, document: result.document, status: result.status };
          if (!result.ok)
            toast.info('The video changed in the meantime, so that last change was not applied.');
          return result.ok;
        } catch (error) {
          toast.error(message(error));
          return false;
        }
      }),
    [enqueue, settle, videoId],
  );

  const step = useCallback(
    (which: 'undo' | 'redo' | { restore: number }) =>
      enqueue(async () => {
        const current = viewRef.current;
        if (current.state !== 'open') return;
        try {
          const client = studioClient();
          const result =
            which === 'undo'
              ? await client.undo(videoId)
              : which === 'redo'
                ? await client.redo(videoId)
                : await client.restore(videoId, which.restore);
          if (!result) return;
          settle(result.document, result.status);
          viewRef.current = { ...current, document: result.document, status: result.status };
        } catch (error) {
          toast.error(message(error));
        }
      }),
    [enqueue, settle, videoId],
  );

  return {
    view,
    apply,
    undo: () => step('undo'),
    redo: () => step('redo'),
    restore: (seq) => step({ restore: seq }),
    adopt,
    takeOver: () => open(true),
    reload: () => open(false),
  };
}
