// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRuntime, RUNTIME_VERSION, readConfig, type SceneDefinition } from './runtime.js';

/**
 * The runtime on a scene page (jsdom here; the capture host and the preview run it in Chromium).
 * Each test gets a fresh iframe, since the runtime replaces the page's clocks for good.
 */

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
});

function page(config?: object) {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const win = frame.contentWindow as Window & typeof globalThis;
  if (config) {
    const script = win.document.createElement('script');
    script.id = 'studio-config';
    script.type = 'application/json';
    script.textContent = JSON.stringify(config);
    win.document.head.appendChild(script);
  }
  const runtime = installRuntime(win);
  const studio = (win as unknown as { Studio: { scene(d: SceneDefinition): void; config: object } })
    .Studio;
  return { win, runtime, studio };
}

describe('readConfig', () => {
  it('reads the page config and falls back to defaults', () => {
    const { win } = page({ duration: 8, lang: 'fa', dir: 'rtl', params: { color: 'red' } });
    expect(readConfig(win.document)).toMatchObject({
      duration: 8,
      lang: 'fa',
      dir: 'rtl',
      width: 1920,
      params: { color: 'red' },
    });
    const broken = document.implementation.createHTMLDocument();
    broken.body.innerHTML = '<script id="studio-config">{not json</script>';
    expect(readConfig(broken).duration).toBe(5);
  });
});

describe('installRuntime', () => {
  it('renders the asked moment with a context that knows its progress', async () => {
    const { runtime, studio, win } = page({ duration: 4, lang: 'fa', dir: 'rtl' });
    const seen: unknown[] = [];
    studio.scene({
      render: (t, ctx) => {
        seen.push([t, ctx.progress, ctx.lang, ctx.dir, ctx.between(1, 3), win.performance.now()]);
      },
    });
    await runtime.renderAt(2);
    await runtime.renderAt(8);
    expect(seen).toEqual([
      [2, 0.5, 'fa', 'rtl', 0.5, 2000],
      [8, 1, 'fa', 'rtl', 1, 8000],
    ]);
    expect((win as unknown as { __studio: { version: number } }).__studio.version).toBe(
      RUNTIME_VERSION,
    );
  });

  it('gives the same random numbers and noise for the same frame', async () => {
    const { runtime, studio } = page();
    const values: number[][] = [];
    studio.scene({ render: (_t, ctx) => void values.push([ctx.random(), ctx.noise(1.5, 2)]) });
    await runtime.renderAt(1);
    await runtime.renderAt(3);
    await runtime.renderAt(1);
    expect(values[2]).toEqual(values[0]);
    expect(values[1]).not.toEqual(values[0]);
  });

  it('runs setup once before the first frame', async () => {
    const { runtime, studio } = page();
    const order: string[] = [];
    studio.scene({
      setup: async () => {
        await Promise.resolve();
        order.push('setup');
      },
      render: (t) => void order.push(`render ${t}`),
    });
    await runtime.renderAt(0);
    await runtime.renderAt(1);
    expect(order).toEqual(['setup', 'render 0', 'render 1']);
  });

  it('reports a failing setup, a failing frame and a runaway timer, and keeps rendering', async () => {
    const { runtime, studio, win } = page();
    studio.scene({
      setup: () => {
        throw new Error('no model');
      },
      render: (t) => {
        if (t === 1) throw new Error('bad frame');
      },
    });
    // A timer that multiplies every time it fires.
    const fork = () => {
      win.setTimeout(fork, 0);
      win.setTimeout(fork, 0);
    };
    win.setTimeout(fork, 0);
    await runtime.renderAt(1);
    await runtime.renderAt(1.001);
    expect(runtime.state.errors.slice(0, 2)).toEqual([
      'The scene setup failed: no model',
      'The scene failed at 1.000 s: bad frame',
    ]);
    expect(runtime.state.errors).toContain(
      'A timer kept firing without end; it was stopped for this frame.',
    );
    // The frame after the failing one still rendered without a new scene error.
    expect(runtime.state.errors.filter((e) => e.startsWith('The scene failed'))).toHaveLength(1);
  });

  it('collects page errors, rejections and blocked requests', () => {
    const { runtime, win } = page();
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'x is not defined' }));
    const rejection = new win.Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('fetch refused');
    win.dispatchEvent(rejection);
    const blocked = new win.Event('securitypolicyviolation') as Event & {
      violatedDirective: string;
      blockedURI: string;
    };
    blocked.violatedDirective = 'connect-src';
    blocked.blockedURI = 'https://example.com';
    win.document.dispatchEvent(blocked);
    expect(runtime.state.errors).toEqual([
      'Error: x is not defined',
      'Unhandled rejection: fetch refused',
      'Blocked connect-src: https://example.com',
    ]);
  });

  it('refuses and reports a window the scene tries to open', () => {
    const { runtime, win } = page();
    expect(win.open('https://example.com')).toBeNull();
    expect(win.open()).toBeNull();
    expect(runtime.state.errors).toEqual([
      'Blocked opening a window: https://example.com',
      'Blocked opening a window: about:blank',
    ]);
  });

  it('seeks Lottie animations to the frame time', async () => {
    const { runtime, win } = page();
    const goToAndStop = vi.fn();
    (win as unknown as { lottie: object }).lottie = { goToAndStop };
    await runtime.renderAt(1.5);
    expect(goToAndStop).toHaveBeenCalledWith(1500, false);
  });

  it('answers a seek message from the preview with the frame and its errors', async () => {
    const { win, studio } = page();
    studio.scene({ render: () => undefined });
    const reply = vi.fn();
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: { type: 'studio:seek', t: 0.5, id: 7 },
        source: { postMessage: reply } as unknown as Window,
      }),
    );
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ type: 'studio:frame', id: 7, t: 0.5, errors: [] }, '*'),
    );
    // Anything else is not for the runtime.
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'other' } }));
  });

  it('waits for a real paint after a frame, whatever the virtual clock says', async () => {
    const { runtime } = page();
    await runtime.renderAt(3);
    await expect(runtime.state.afterPaint()).resolves.toBeUndefined();
  });

  it('marks the page ready once loaded and the scene has registered and set up', async () => {
    const { runtime, studio } = page();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A page whose script never registers a scene (a syntax error, say) is never ready.
    expect(runtime.state.ready).toBe(false);
    studio.scene({ render: () => undefined });
    await vi.waitFor(() => expect(runtime.state.ready).toBe(true));
  });
});
