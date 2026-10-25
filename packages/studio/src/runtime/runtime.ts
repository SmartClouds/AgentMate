import {
  ease,
  hashString,
  keyframes,
  lerp,
  noise2,
  progress,
  seededRandom,
  spring,
  tween,
} from './motion.js';
import { installVirtualTime, type VirtualClock } from './virtualTime.js';

/**
 * The Studio runtime: the one script every scene page loads before its own code. A scene registers
 * itself with `Studio.scene({ setup, render })`, and the page then draws any moment on request
 * through `window.renderAt(t)`: the render calls it frame by frame, the preview through messages
 * from the editor. Scenes get their size, language, params and the motion helpers on `ctx`, and
 * are written against `ctx.progress` so they fit any duration.
 */

export const RUNTIME_VERSION = 1;

export interface SceneConfig {
  /** How long the scene runs, in seconds. */
  duration: number;
  width: number;
  height: number;
  lang: string;
  dir: 'ltr' | 'rtl';
  params: Record<string, string | number | boolean>;
  /** Seeds every random number in the scene. */
  seed: string;
}

export interface SceneContext extends SceneConfig {
  /** Seconds since the scene started. */
  t: number;
  /** How far through the scene, from 0 to 1. */
  progress: number;
  /** A random number from 0 to 1, the same for the same frame every time. */
  random: () => number;
  /** Smooth noise from 0 to 1, seeded by the scene. */
  noise: (x: number, y?: number) => number;
  ease: typeof ease;
  tween: typeof tween;
  keyframes: typeof keyframes;
  spring: typeof spring;
  lerp: typeof lerp;
  /** Where `t` is between two times, from 0 to 1. */
  between: (start: number, end: number) => number;
}

export interface SceneDefinition {
  /** Runs once, before the first frame: build the DOM, load models, measure text. */
  setup?: (ctx: SceneContext) => void | Promise<void>;
  /** Draws the moment `t` seconds in. Must depend on `t` alone, never on earlier frames. */
  render: (t: number, ctx: SceneContext) => void | Promise<void>;
}

export interface StudioState {
  version: number;
  ready: boolean;
  duration: number;
  /** Errors, uncaught rejections and blocked requests, in the order they happened. */
  errors: string[];
  /**
   * Resolves once the page has really painted what the last `renderAt` drew, through two real
   * animation frames (with a timer fallback, since a hidden window may not paint on its own).
   */
  afterPaint: () => Promise<void>;
}

const DEFAULTS: SceneConfig = {
  duration: 5,
  width: 1920,
  height: 1080,
  lang: 'en',
  dir: 'ltr',
  params: {},
  seed: 'scene',
};

/** The config the scene server writes into the page, as JSON in `#studio-config`. */
export function readConfig(doc: Document): SceneConfig {
  const text = doc.getElementById('studio-config')?.textContent;
  if (!text) return DEFAULTS;
  try {
    const value = JSON.parse(text) as Partial<SceneConfig>;
    return { ...DEFAULTS, ...value, params: { ...(value.params ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

interface LottieGlobal {
  goToAndStop?: (value: number, isFrame?: boolean) => void;
}

type RuntimeWindow = Window &
  typeof globalThis & {
    Studio?: unknown;
    renderAt?: (t: number) => Promise<void>;
    __studio?: StudioState;
    lottie?: LottieGlobal;
  };

export interface Runtime {
  clock: VirtualClock;
  state: StudioState;
  renderAt: (t: number) => Promise<void>;
}

/** Installs the runtime on `win`. Runs before any scene code. */
export function installRuntime(win: RuntimeWindow): Runtime {
  const doc = win.document;
  const config = readConfig(doc);
  const clock = installVirtualTime(win, { seed: config.seed });
  const state: StudioState = {
    version: RUNTIME_VERSION,
    ready: false,
    duration: config.duration,
    errors: [],
    afterPaint: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        clock.real.requestAnimationFrame(() => clock.real.requestAnimationFrame(finish));
        clock.real.setTimeout(finish, 50);
      }),
  };
  const report = (message: string) => {
    if (state.errors.length < 200) state.errors.push(message);
  };

  win.addEventListener('error', (event) => {
    report(`Error: ${event.message || 'a script failed to load'}`);
  });
  win.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    report(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  // A scene may not open windows; the attempt is refused and reported rather than left silent.
  win.open = ((url?: string | URL) => {
    report(`Blocked opening a window: ${url ? String(url) : 'about:blank'}`);
    return null;
  }) as typeof win.open;
  doc.addEventListener('securitypolicyviolation', (event) => {
    report(`Blocked ${event.violatedDirective}: ${event.blockedURI || 'inline'}`);
  });

  const noiseSeed = hashString(`${config.seed}:noise`);
  const context = (t: number): SceneContext => ({
    ...config,
    t,
    progress: config.duration > 0 ? Math.min(1, Math.max(0, t / config.duration)) : 0,
    random: seededRandom(hashString(`${config.seed}:${Math.round(t * 1000)}`)),
    noise: (x, y = 0) => noise2(noiseSeed, x, y),
    ease,
    tween,
    keyframes,
    spring,
    lerp,
    between: (start, end) => progress(t, start, end),
  });

  let definition: SceneDefinition | null = null;
  let setup: Promise<void> = Promise.resolve();
  /** Resolves once the scene has registered itself; a page that never does is never ready. */
  let registered: () => void = () => undefined;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });

  const assetsReady = async () => {
    const images = [...doc.images].filter((img) => !img.complete);
    await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
    if (doc.fonts) await doc.fonts.ready;
  };

  /** CSS animations and transitions, and Web Animations, are paused and set to the moment. */
  const seekAnimations = (t: number) => {
    for (const animation of doc.getAnimations?.() ?? []) {
      animation.pause();
      animation.currentTime = t * 1000;
    }
    win.lottie?.goToAndStop?.(t * 1000, false);
  };

  const renderAt = async (t: number) => {
    await setup;
    clock.advanceTo(t * 1000);
    seekAnimations(t);
    if (definition) {
      try {
        await definition.render(t, context(t));
      } catch (error) {
        report(
          `The scene failed at ${t.toFixed(3)} s: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await assetsReady();
    for (const problem of clock.problems.splice(0)) report(problem);
  };

  win.Studio = {
    version: RUNTIME_VERSION,
    config,
    scene(next: SceneDefinition) {
      definition = next;
      registered();
      setup = Promise.resolve()
        .then(() => next.setup?.(context(0)))
        .catch((error: unknown) => {
          report(
            `The scene setup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return next;
    },
    ease,
    tween,
    keyframes,
    spring,
    lerp,
  };
  win.renderAt = renderAt;
  win.__studio = state;

  // Ready once the page has loaded and the scene has registered and set itself up.
  const markReady = () => {
    void registration
      .then(() => setup)
      .then(async () => {
        await assetsReady();
        state.ready = true;
      });
  };
  if (doc.readyState === 'complete') markReady();
  else win.addEventListener('load', markReady);

  // The preview drives the page from the editor; a page at an opaque origin can only post back.
  win.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; t?: number; id?: number } | null;
    if (data?.type !== 'studio:seek' || typeof data.t !== 'number') return;
    const t = data.t;
    void renderAt(t).then(() => {
      (event.source as Window | null)?.postMessage(
        { type: 'studio:frame', id: data.id, t, errors: state.errors.slice() },
        '*',
      );
    });
  });

  return { clock, state, renderAt };
}
