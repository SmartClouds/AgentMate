import { BROWSER_PARTITION } from '@shared/browserGuest';
import pickerSource from './guest/picker.js?raw';
import { fitViewport, type ViewportPresetId } from './viewportPresets';

/**
 * Owns the webview of every browser tab, for as long as the tab exists.
 *
 * A webview reloads its page whenever it is taken out of the DOM or moved within it, and panes
 * remount their bodies on every tab switch, split and drag. So the webviews never live in a pane:
 * they sit in one fixed layer on the body, and a pane that shows a browser tab attaches its body
 * element as a slot, which the tab's webview is then laid over. With no slot the webview is
 * hidden, still loaded, which is what keeps a form half filled in or a dev server's HMR state
 * across tab switches. The same idea as the terminal parking in terminalRuntime.ts.
 */

export interface BrowserPage {
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface BrowserNavState extends BrowserPage {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set once the guest is attached; main identifies pages by it. */
  webContentsId: number | null;
  error: { code: number; description: string; url: string } | null;
}

type WebviewElement = Electron.WebviewTag;

interface Entry {
  tabId: string;
  wrapper: HTMLDivElement;
  webview: WebviewElement;
  overlay: HTMLDivElement;
  slot: HTMLElement | null;
  observer: ResizeObserver | null;
  viewport: ViewportPresetId;
  /** Where the page sits in the pane, and its scale, as last laid out. */
  frame: { left: number; top: number; scale: number };
  attached: boolean;
  /** Bumped on every new document, so the picker is injected again after a navigation. */
  documentId: number;
  pickerDocument: number;
  state: BrowserNavState;
  listeners: Set<() => void>;
  readyListeners: Set<() => void>;
}

const EMPTY: BrowserNavState = {
  url: '',
  title: '',
  faviconUrl: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  webContentsId: null,
  error: null,
};

/** Chromium's net::ERR_ABORTED: a navigation replaced by another one, not a failure. */
const ERR_ABORTED = -3;

export interface BrowserRuntimeOptions {
  /** Tests give jsdom's inert element the methods a real webview has. */
  createWebview?: (el: HTMLElement) => void;
}

export function createBrowserRuntime(options: BrowserRuntimeOptions = {}) {
  const entries = new Map<string, Entry>();
  const pageListeners = new Set<(tabId: string, page: BrowserPage) => void>();
  let dragging = false;
  let followFrames = 0;

  function layer(): HTMLElement {
    let el = document.getElementById('browser-layer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'browser-layer';
      // Between the workspace (z-10) and the terminal drawer that slides over it (z-20), which
      // share the root stacking context with this layer. Menus and dialogs portal in at z-50.
      el.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:15;overflow:hidden;contain:strict;';
      document.body.appendChild(el);
    }
    return el;
  }

  function setState(entry: Entry, patch: Partial<BrowserNavState>): void {
    entry.state = { ...entry.state, ...patch };
    for (const listener of entry.listeners) listener();
  }

  function reportPage(entry: Entry): void {
    const { url, title, faviconUrl } = entry.state;
    for (const listener of pageListeners) listener(entry.tabId, { url, title, faviconUrl });
  }

  function history(entry: Entry): Pick<BrowserNavState, 'canGoBack' | 'canGoForward'> {
    try {
      return { canGoBack: entry.webview.canGoBack(), canGoForward: entry.webview.canGoForward() };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  function applyZoom(entry: Entry, scale: number): void {
    if (!entry.attached) return;
    try {
      entry.webview.setZoomFactor(scale);
    } catch {
      // Not attached yet after all; dom-ready applies it.
    }
  }

  function place(entry: Entry): void {
    const { wrapper, webview } = entry;
    const rect = entry.slot?.getBoundingClientRect();
    const visible = !!rect && rect.width > 0 && rect.height > 0 && !dragging;
    wrapper.style.visibility = visible ? 'visible' : 'hidden';
    wrapper.style.pointerEvents = visible ? 'auto' : 'none';
    if (!rect || !visible) return;
    Object.assign(wrapper.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const fit = fitViewport(entry.viewport, { width: rect.width, height: rect.height });
    const width = Math.round(fit.width * fit.scale);
    const height = Math.round(fit.height * fit.scale);
    const left = Math.max(0, Math.round((rect.width - width) / 2));
    const top = Math.max(0, Math.round((rect.height - height) / 2));
    entry.frame = { left, top, scale: fit.scale };
    Object.assign(webview.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${left}px`,
      top: `${top}px`,
    });
    applyZoom(entry, fit.scale);
  }

  /** Keeps following the slots for a few frames, through a pane resize's CSS transition. */
  function follow(): void {
    const running = followFrames > 0;
    followFrames = 12;
    if (running) return;
    const step = (): void => {
      for (const entry of entries.values()) if (entry.slot) place(entry);
      followFrames -= 1;
      if (followFrames > 0) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function wire(entry: Entry): void {
    const { webview } = entry;
    type Detail = Record<string, unknown>;
    const on = (type: string, handler: (event: Event & Detail) => void): void =>
      webview.addEventListener(type, handler as unknown as EventListener);

    on('dom-ready', () => {
      entry.attached = true;
      entry.documentId += 1;
      let webContentsId: number | null = null;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        webContentsId = null;
      }
      setState(entry, { webContentsId, ...history(entry) });
      place(entry);
      if (!entry.slot) applyZoom(entry, 1);
      for (const listener of entry.readyListeners) listener();
    });
    on('did-start-loading', () => setState(entry, { loading: true }));
    on('did-stop-loading', () => setState(entry, { loading: false, ...history(entry) }));
    on('did-navigate', (event) => {
      setState(entry, { url: String(event.url), error: null, ...history(entry) });
      reportPage(entry);
    });
    on('did-navigate-in-page', (event) => {
      if (event.isMainFrame === false) return;
      setState(entry, { url: String(event.url), ...history(entry) });
      reportPage(entry);
    });
    on('page-title-updated', (event) => {
      setState(entry, { title: String(event.title ?? '') });
      reportPage(entry);
    });
    on('page-favicon-updated', (event) => {
      const favicons = event.favicons as string[] | undefined;
      setState(entry, { faviconUrl: favicons?.[0] ?? null });
      reportPage(entry);
    });
    on('did-fail-load', (event) => {
      if (event.isMainFrame === false || event.errorCode === ERR_ABORTED) return;
      setState(entry, {
        loading: false,
        error: {
          code: Number(event.errorCode),
          description: String(event.errorDescription ?? ''),
          url: String(event.validatedURL ?? entry.state.url),
        },
      });
    });
  }

  function create(tabId: string, url: string): Entry {
    const wrapper = document.createElement('div');
    wrapper.dataset.browserTab = tabId;
    wrapper.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;overflow:hidden;';
    const webview = document.createElement('webview') as WebviewElement;
    webview.setAttribute('partition', BROWSER_PARTITION);
    webview.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('src', url);
    webview.style.cssText = 'position:absolute;display:flex;background:#fff;';
    options.createWebview?.(webview);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    wrapper.append(webview, overlay);
    const entry: Entry = {
      tabId,
      wrapper,
      webview,
      overlay,
      slot: null,
      observer: null,
      viewport: 'responsive',
      frame: { left: 0, top: 0, scale: 1 },
      attached: false,
      documentId: 0,
      pickerDocument: -1,
      state: { ...EMPTY, url },
      listeners: new Set(),
      readyListeners: new Set(),
    };
    wire(entry);
    layer().appendChild(wrapper);
    return entry;
  }

  function withEntry(tabId: string, fn: (entry: Entry) => void): void {
    const entry = entries.get(tabId);
    if (!entry?.attached) return;
    try {
      fn(entry);
    } catch {
      // The guest went away between the check and the call; nothing to do.
    }
  }

  const runtime = {
    /** The tab's webview, created on first use and loading `url`. */
    ensure(tabId: string, url: string): WebviewElement {
      let entry = entries.get(tabId);
      if (!entry) {
        entry = create(tabId, url);
        entries.set(tabId, entry);
      }
      return entry.webview;
    },

    get(tabId: string): WebviewElement | null {
      return entries.get(tabId)?.webview ?? null;
    },

    /** The element above the tab's page, for UI that has to sit over it. */
    overlay(tabId: string): HTMLElement | null {
      return entries.get(tabId)?.overlay ?? null;
    },

    /** Shows the tab's page over `slot`. The returned function lets go of it again. */
    attach(tabId: string, slot: HTMLElement): () => void {
      const entry = entries.get(tabId);
      if (!entry) return () => undefined;
      entry.observer?.disconnect();
      entry.slot = slot;
      entry.observer = new ResizeObserver(() => follow());
      entry.observer.observe(slot);
      place(entry);
      return () => {
        if (entry.slot !== slot) return;
        entry.observer?.disconnect();
        entry.observer = null;
        entry.slot = null;
        place(entry);
      };
    },

    /** Places every attached page again, after something moved the panes. */
    layout(): void {
      for (const entry of entries.values()) place(entry);
    },

    setDragging(next: boolean): void {
      if (dragging === next) return;
      dragging = next;
      runtime.layout();
    },

    setViewport(tabId: string, viewport: ViewportPresetId): void {
      const entry = entries.get(tabId);
      if (!entry || entry.viewport === viewport) return;
      entry.viewport = viewport;
      place(entry);
    },

    /** Where the tab's page sits within its pane, for UI anchored to page elements. */
    frame(tabId: string): { left: number; top: number; scale: number } {
      return entries.get(tabId)?.frame ?? { left: 0, top: 0, scale: 1 };
    },

    state(tabId: string): BrowserNavState {
      return entries.get(tabId)?.state ?? EMPTY;
    },

    subscribe(tabId: string, listener: () => void): () => void {
      const entry = entries.get(tabId);
      entry?.listeners.add(listener);
      return () => entry?.listeners.delete(listener);
    },

    onDocumentReady(tabId: string, listener: () => void): () => void {
      const entry = entries.get(tabId);
      entry?.readyListeners.add(listener);
      return () => entry?.readyListeners.delete(listener);
    },

    onPageChange(listener: (tabId: string, page: BrowserPage) => void): () => void {
      pageListeners.add(listener);
      return () => pageListeners.delete(listener);
    },

    tabForWebContents(webContentsId: number): string | null {
      for (const entry of entries.values()) {
        if (entry.state.webContentsId === webContentsId) return entry.tabId;
      }
      return null;
    },

    navigate(tabId: string, url: string): void {
      const entry = entries.get(tabId);
      if (!entry) return;
      setState(entry, { url, error: null });
      if (!entry.attached) {
        entry.webview.setAttribute('src', url);
        return;
      }
      void entry.webview.loadURL(url).catch(() => undefined);
    },

    back: (tabId: string) => withEntry(tabId, (entry) => entry.webview.goBack()),
    forward: (tabId: string) => withEntry(tabId, (entry) => entry.webview.goForward()),
    reload: (tabId: string, hard = false) =>
      withEntry(tabId, (entry) => {
        setState(entry, { error: null });
        if (hard) entry.webview.reloadIgnoringCache();
        else entry.webview.reload();
      }),
    stop: (tabId: string) => withEntry(tabId, (entry) => entry.webview.stop()),
    openDevTools: (tabId: string) => withEntry(tabId, (entry) => entry.webview.openDevTools()),
    focus: (tabId: string) => withEntry(tabId, (entry) => entry.webview.focus()),

    /**
     * Calls the in-page picker (guest/picker.js), injecting it first into a document that hasn't
     * got it yet. Undefined when the tab has no page to run it in.
     */
    async picker<Result = unknown>(tabId: string, call: string): Promise<Result | undefined> {
      const entry = entries.get(tabId);
      if (!entry?.attached) return undefined;
      const { webview } = entry;
      if (entry.pickerDocument !== entry.documentId) {
        await webview.executeJavaScript(pickerSource);
        entry.pickerDocument = entry.documentId;
      }
      return (await webview.executeJavaScript(`window.__runovaPicker.${call}`)) as Result;
    },

    dispose(tabId: string): void {
      const entry = entries.get(tabId);
      if (!entry) return;
      entry.observer?.disconnect();
      entry.listeners.clear();
      entry.readyListeners.clear();
      entry.wrapper.remove();
      entries.delete(tabId);
    },

    disposeAll(): void {
      for (const tabId of [...entries.keys()]) runtime.dispose(tabId);
    },
  };
  return runtime;
}

export type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

export const browserRuntime: BrowserRuntime = createBrowserRuntime();
