import { BROWSER_PARTITION } from '@shared/browserGuest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BrowserRuntime, createBrowserRuntime } from './browserRuntime';

/**
 * The browser runtime keeps one webview per browser tab alive for as long as the tab exists. A
 * webview reloads its page whenever it is taken out of the DOM or moved in it, and panes remount
 * their bodies on every tab switch and split, so the webviews live in a layer of their own and
 * are laid over whichever pane body shows their tab.
 */

type FakeWebview = HTMLElement & Record<string, ReturnType<typeof vi.fn>>;

let runtime: BrowserRuntime;

function webview(tabId: string): FakeWebview {
  const el = runtime.get(tabId);
  if (!el) throw new Error(`no webview for ${tabId}`);
  return el as unknown as FakeWebview;
}

/** jsdom has no webview, so the element gets the methods the runtime calls on a real one. */
function fakeMethods(el: HTMLElement): void {
  Object.assign(el, {
    loadURL: vi.fn(() => Promise.resolve()),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    getWebContentsId: vi.fn(() => 42),
    getURL: vi.fn(() => 'http://localhost:5173/'),
    setZoomFactor: vi.fn(),
    openDevTools: vi.fn(),
    focus: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve(true)),
  });
}

function fire(el: HTMLElement, type: string, props: Record<string, unknown> = {}): void {
  el.dispatchEvent(Object.assign(new Event(type), props));
}

function slot(width = 800, height = 600, x = 100, y = 40): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect);
  return el;
}

function wrapper(tabId: string): HTMLElement {
  return webview(tabId).parentElement as HTMLElement;
}

beforeEach(() => {
  runtime = createBrowserRuntime({ createWebview: (el) => fakeMethods(el) });
});

afterEach(() => {
  runtime.disposeAll();
  document.body.innerHTML = '';
});

describe('ensure', () => {
  it('creates one webview per tab in its own session, loading the address', () => {
    const el = runtime.ensure('b1', 'http://localhost:5173/');
    expect(el.tagName.toLowerCase()).toBe('webview');
    expect(el.getAttribute('partition')).toBe(BROWSER_PARTITION);
    expect(el.getAttribute('src')).toBe('http://localhost:5173/');
    expect(el.hasAttribute('allowpopups')).toBe(true);
    expect(runtime.ensure('b1', 'http://other/')).toBe(el);
  });

  it('keeps every webview in one layer outside the panes', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.ensure('b2', 'https://example.com/');
    const layer = document.getElementById('browser-layer');
    expect(layer?.querySelectorAll('webview')).toHaveLength(2);
    expect(layer?.style.pointerEvents).toBe('none');
  });

  it('starts hidden until a pane shows it', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    expect(wrapper('b1').style.visibility).toBe('hidden');
  });
});

describe('slots', () => {
  it('lays the webview over the pane body that shows its tab', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.attach('b1', slot(800, 600, 100, 40));
    expect(wrapper('b1').style).toMatchObject({
      visibility: 'visible',
      left: '100px',
      top: '40px',
      width: '800px',
      height: '600px',
      pointerEvents: 'auto',
    });
  });

  it('hides the page, without unloading it, once the pane lets go', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    const detach = runtime.attach('b1', slot());
    detach();
    expect(wrapper('b1').style.visibility).toBe('hidden');
    expect(wrapper('b1').style.pointerEvents).toBe('none');
    expect(el.isConnected).toBe(true);
    expect(webview('b1')).toBe(el);
  });

  it('only lets the latest pane hide it, when a tab moves between panes', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const detachOld = runtime.attach('b1', slot(400, 300, 0, 0));
    runtime.attach('b1', slot(500, 300, 400, 0));
    detachOld();
    expect(wrapper('b1').style.visibility).toBe('visible');
    expect(wrapper('b1').style.left).toBe('400px');
  });

  it('hides the page while the pane has no size, as when the workspace is off screen', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.attach('b1', slot(0, 0));
    expect(wrapper('b1').style.visibility).toBe('hidden');
  });

  it('follows the pane when it is laid out again', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const pane = slot(800, 600, 100, 40);
    runtime.attach('b1', pane);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 40,
      left: 0,
      top: 40,
      width: 500,
      height: 600,
      right: 500,
      bottom: 640,
      toJSON: () => ({}),
    } as DOMRect);
    runtime.layout();
    expect(wrapper('b1').style.left).toBe('0px');
    expect(wrapper('b1').style.width).toBe('500px');
  });

  it('gets out of the way while a tab is dragged, so the panes can take the drop', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.attach('b1', slot());
    runtime.setDragging(true);
    expect(wrapper('b1').style.visibility).toBe('hidden');
    runtime.setDragging(false);
    expect(wrapper('b1').style.visibility).toBe('visible');
  });

  it('gives each tab a layer above its page for the comment tray and cards', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const overlay = runtime.overlay('b1');
    expect(overlay?.parentElement).toBe(wrapper('b1'));
    expect(overlay?.previousElementSibling?.tagName.toLowerCase()).toBe('webview');
  });
});

describe('device sizes', () => {
  it('fills the pane when responsive', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.attach('b1', slot(800, 600));
    expect(webview('b1').style.width).toBe('800px');
    expect(webview('b1').style.height).toBe('600px');
  });

  it('shows a phone at its own size, centered', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.setViewport('b1', 'mobile');
    runtime.attach('b1', slot(1000, 900));
    fire(webview('b1'), 'dom-ready');
    expect(webview('b1').style).toMatchObject({ width: '390px', height: '844px', left: '305px' });
    expect(webview('b1').setZoomFactor).toHaveBeenLastCalledWith(1);
  });

  it('shrinks a device that does not fit, zooming the page to match', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.attach('b1', slot(720, 450));
    fire(webview('b1'), 'dom-ready');
    runtime.setViewport('b1', 'desktop');
    expect(webview('b1').style.width).toBe('720px');
    expect(webview('b1').style.height).toBe('450px');
    expect(webview('b1').setZoomFactor).toHaveBeenLastCalledWith(0.5);
  });
});

describe('frame', () => {
  it('says where the page sits in the pane and how much it is scaled', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    expect(runtime.frame('b1')).toEqual({ left: 0, top: 0, scale: 1 });
    runtime.setViewport('b1', 'desktop');
    runtime.attach('b1', slot(720, 600));
    expect(runtime.frame('b1')).toEqual({ left: 0, top: 75, scale: 0.5 });
  });
});

describe('page state', () => {
  it('tracks loading, the address, history and the title', () => {
    const states: unknown[] = [];
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.subscribe('b1', () => states.push(runtime.state('b1')));
    const el = webview('b1');
    fire(el, 'dom-ready');
    fire(el, 'did-start-loading');
    expect(runtime.state('b1').loading).toBe(true);
    fire(el, 'did-navigate', { url: 'http://localhost:5173/pricing' });
    fire(el, 'page-title-updated', { title: 'Pricing' });
    fire(el, 'page-favicon-updated', { favicons: ['http://localhost:5173/favicon.ico'] });
    fire(el, 'did-stop-loading');
    expect(runtime.state('b1')).toMatchObject({
      url: 'http://localhost:5173/pricing',
      title: 'Pricing',
      faviconUrl: 'http://localhost:5173/favicon.ico',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      webContentsId: 42,
      error: null,
    });
    expect(states.length).toBeGreaterThan(0);
  });

  it('reports what the page is showing, for the tab strip and the saved layout', () => {
    const seen: unknown[] = [];
    runtime.onPageChange((tabId, page) => seen.push([tabId, page]));
    runtime.ensure('b1', 'http://localhost:5173/');
    fire(webview('b1'), 'did-navigate-in-page', {
      url: 'http://localhost:5173/#/a',
      isMainFrame: true,
    });
    fire(webview('b1'), 'did-navigate-in-page', { url: 'http://ads/frame', isMainFrame: false });
    expect(seen).toEqual([
      ['b1', { url: 'http://localhost:5173/#/a', title: '', faviconUrl: null }],
    ]);
  });

  it('shows why a page failed to load, and clears it on the next navigation', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    fire(el, 'did-fail-load', {
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://localhost:5173/',
      isMainFrame: true,
    });
    expect(runtime.state('b1').error).toEqual({
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:5173/',
    });
    fire(el, 'did-navigate', { url: 'http://localhost:5173/' });
    expect(runtime.state('b1').error).toBeNull();
  });

  it('ignores aborted loads and failures inside frames', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    fire(webview('b1'), 'did-fail-load', { errorCode: -3, isMainFrame: true });
    fire(webview('b1'), 'did-fail-load', { errorCode: -102, isMainFrame: false });
    expect(runtime.state('b1').error).toBeNull();
  });

  it('tells listeners when a new document is ready, so the picker can come back', () => {
    const ready = vi.fn();
    runtime.ensure('b1', 'http://localhost:5173/');
    runtime.onDocumentReady('b1', ready);
    fire(webview('b1'), 'dom-ready');
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

describe('navigation', () => {
  it('drives the webview', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    fire(el, 'dom-ready');
    runtime.navigate('b1', 'https://example.com/');
    runtime.back('b1');
    runtime.forward('b1');
    runtime.reload('b1');
    runtime.reload('b1', true);
    runtime.stop('b1');
    runtime.openDevTools('b1');
    expect(el.loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(el.goBack).toHaveBeenCalled();
    expect(el.goForward).toHaveBeenCalled();
    expect(el.reload).toHaveBeenCalledTimes(1);
    expect(el.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(el.stop).toHaveBeenCalled();
    expect(el.openDevTools).toHaveBeenCalled();
  });

  it('waits for the webview to attach before navigating it', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    runtime.navigate('b1', 'https://example.com/');
    expect(el.loadURL).not.toHaveBeenCalled();
    expect(el.getAttribute('src')).toBe('https://example.com/');
  });

  it('finds a tab by the page it shows', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    fire(webview('b1'), 'dom-ready');
    expect(runtime.tabForWebContents(42)).toBe('b1');
    expect(runtime.tabForWebContents(7)).toBeNull();
  });
});

describe('the picker', () => {
  it('injects the picker once per document and then calls it', async () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    fire(el, 'dom-ready');
    el.executeJavaScript.mockImplementation((code: string) =>
      Promise.resolve(code.includes('inspect') ? { armed: true } : true),
    );
    await runtime.picker('b1', 'arm()');
    await runtime.picker('b1', 'inspect()');
    const calls = el.executeJavaScript.mock.calls.map(([code]) => code as string);
    expect(calls.filter((code) => code.includes('__runovaPicker = {'))).toHaveLength(1);
    expect(calls).toContain('window.__runovaPicker.arm()');
    fire(el, 'dom-ready');
    await runtime.picker('b1', 'arm()');
    expect(
      el.executeJavaScript.mock.calls.filter(([code]) =>
        String(code).includes('__runovaPicker = {'),
      ),
    ).toHaveLength(2);
  });

  it('gives nothing back for a tab without a page', async () => {
    expect(await runtime.picker('nope', 'arm()')).toBeUndefined();
  });
});

describe('dispose', () => {
  it('removes the page and forgets the tab', () => {
    runtime.ensure('b1', 'http://localhost:5173/');
    const el = webview('b1');
    runtime.dispose('b1');
    expect(el.isConnected).toBe(false);
    expect(runtime.get('b1')).toBeNull();
    expect(runtime.state('b1').url).toBe('');
  });
});
