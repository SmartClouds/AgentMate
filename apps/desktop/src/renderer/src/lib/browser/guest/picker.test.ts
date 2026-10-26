import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageMarker, PickResult } from '../types';
import source from './picker.js?raw';

/**
 * The element picker runs inside the guest page, injected as a string through
 * webview.executeJavaScript. These tests run that same string in jsdom and drive it the way the
 * page would: pointer moves, clicks, right-clicks and Esc.
 */

interface PickerApi {
  version: number;
  arm(): void;
  disarm(): void;
  awaitPick(): Promise<PickResult>;
  cancel(): void;
  freeze(): void;
  setMarkers(markers: PageMarker[]): void;
  flashMarker(id: string): void;
  reveal(id: string): boolean;
  setChromeHidden(hidden: boolean): void;
  inspect(): {
    armed: boolean;
    frozen: boolean;
    highlight: { x: number; y: number; width: number; height: number; label: string } | null;
    markers: {
      id: string;
      n: number;
      left: number;
      top: number;
      fixed: boolean;
      flashing: boolean;
    }[];
    chromeHidden: boolean;
  };
  teardown(): void;
}

declare global {
  interface Window {
    __runovaPicker?: PickerApi;
  }
}

function inject(): PickerApi {
  const result = (0, eval)(source);
  expect(result).toBe(true);
  const api = window.__runovaPicker;
  if (!api) throw new Error('picker did not install');
  return api;
}

function rect(el: Element, x: number, y: number, width: number, height: number): void {
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
}

let under: Element | null = null;
const frame = () => new Promise((resolve) => setTimeout(resolve, 30));

function pointAt(el: Element | null, type = 'pointermove', init: MouseEventInit = {}): void {
  under = el;
  const host = document.querySelector('runova-picker');
  const target = host ?? document;
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: 50, ...init }),
  );
}

beforeEach(() => {
  document.title = 'Pricing';
  document.body.innerHTML = `
    <main>
      <section class="plans css-1x2y3z">
        <button class="buy primary" type="button">Buy now</button>
        <button class="buy" type="button" aria-label="Buy the team plan">Team</button>
      </section>
      <form id="signup"><input name="email" placeholder="Email" /></form>
      <div id="a1b2c3d4e5f6a7b8c9"><span>hashed id</span></div>
      <a href="https://app.dev/cb?access_token=abc&page=2">Link</a>
      <script>var secret = 1;</script>
    </main>`;
  under = null;
  document.elementFromPoint = vi.fn(() => under) as typeof document.elementFromPoint;
});

afterEach(() => {
  window.__runovaPicker?.teardown();
  vi.restoreAllMocks();
});

describe('installing', () => {
  it('installs once and keeps the same instance when injected again', () => {
    const first = inject();
    first.arm();
    const second = inject();
    expect(second).toBe(first);
    expect(document.querySelectorAll('runova-picker')).toHaveLength(1);
  });

  it('removes itself on teardown', () => {
    inject().teardown();
    expect(document.querySelector('runova-picker')).toBeNull();
    expect(window.__runovaPicker).toBeUndefined();
  });
});

describe('hovering', () => {
  it('highlights the element under the pointer with its tag, class and size', async () => {
    const api = inject();
    api.arm();
    const button = document.querySelector('button.primary') as Element;
    rect(button, 10, 20, 96, 32);
    pointAt(button);
    await frame();
    expect(api.inspect().highlight).toEqual({
      x: 10,
      y: 20,
      width: 96,
      height: 32,
      label: 'button.buy  96×32',
    });
  });

  it('does not highlight anything until armed', async () => {
    const api = inject();
    pointAt(document.querySelector('button'));
    await frame();
    expect(api.inspect().highlight).toBeNull();
  });

  it('keeps the highlight in place while frozen', async () => {
    const api = inject();
    api.arm();
    const [first, second] = document.querySelectorAll('button');
    rect(first as Element, 0, 0, 10, 10);
    rect(second as Element, 100, 0, 10, 10);
    pointAt(first as Element);
    await frame();
    api.freeze();
    pointAt(second as Element);
    await frame();
    expect(api.inspect().highlight?.x).toBe(0);
    expect(api.inspect().frozen).toBe(true);
  });

  it('blocks wheel scrolling while frozen', () => {
    const api = inject();
    api.arm();
    api.freeze();
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    document.querySelector('runova-picker')?.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });
});

describe('awaitPick', () => {
  it('settles with the clicked element', async () => {
    const api = inject();
    api.arm();
    const pending = api.awaitPick();
    const button = document.querySelector('button.primary') as Element;
    rect(button, 10, 20, 96, 32);
    pointAt(button, 'click');
    const result = await pending;
    expect(result.kind).toBe('pick');
    if (result.kind === 'cancel') return;
    const { page, element } = result.payload;
    expect(page).toMatchObject({ title: 'Pricing', url: window.location.href });
    expect(page.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(element).toMatchObject({
      tagName: 'button',
      role: 'button',
      name: 'Buy now',
      text: 'Buy now',
      rectViewport: { x: 10, y: 20, width: 96, height: 32 },
      fixed: false,
      react: null,
    });
    expect(document.querySelectorAll(element.selector)).toHaveLength(1);
    expect(document.querySelector(element.selector)).toBe(button);
  });

  it('settles as a copy on right-click, keeping the page menu away', async () => {
    const api = inject();
    api.arm();
    const pending = api.awaitPick();
    const button = document.querySelector('button') as Element;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    under = button;
    document.querySelector('runova-picker')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((await pending).kind).toBe('copy');
  });

  it('settles as cancelled on Esc', async () => {
    const api = inject();
    api.arm();
    const pending = api.awaitPick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await pending).toEqual({ kind: 'cancel' });
  });

  it('settles as cancelled when the host cancels or tears down', async () => {
    const api = inject();
    api.arm();
    const first = api.awaitPick();
    api.cancel();
    expect(await first).toEqual({ kind: 'cancel' });
    const second = api.awaitPick();
    api.teardown();
    expect(await second).toEqual({ kind: 'cancel' });
  });

  it('settles an earlier wait as cancelled when a new one starts', async () => {
    const api = inject();
    api.arm();
    const first = api.awaitPick();
    void api.awaitPick();
    expect(await first).toEqual({ kind: 'cancel' });
  });

  it('ignores clicks on nothing', async () => {
    const api = inject();
    api.arm();
    const pending = api.awaitPick();
    pointAt(null, 'click');
    pointAt(document.querySelector('input'), 'click');
    expect((await pending).kind).toBe('pick');
  });
});

describe('describing the element', () => {
  async function pick(el: Element) {
    const api = inject();
    api.arm();
    const pending = api.awaitPick();
    pointAt(el, 'click');
    const result = await pending;
    if (result.kind === 'cancel') throw new Error('cancelled');
    return result.payload.element;
  }

  it('prefers an id for the selector', async () => {
    const form = await pick(document.querySelector('form') as Element);
    expect(form.selector).toBe('#signup');
    const input = document.querySelector('input') as Element;
    const element = await pick(input);
    expect(document.querySelector(element.selector)).toBe(input);
    expect(element.name).toBe('Email');
    expect(element.role).toBe('textbox');
  });

  it('skips ids and classes that look generated', async () => {
    const element = await pick(document.querySelector('div') as Element);
    expect(element.selector).not.toContain('a1b2c3d4');
    const section = await pick(document.querySelector('section') as Element);
    expect(section.selector).not.toContain('css-1x2y3z');
    expect(section.selector).toContain('section.plans');
  });

  it('tells two look-alike siblings apart', async () => {
    const second = document.querySelectorAll('button')[1] as Element;
    const element = await pick(second);
    expect(document.querySelector(element.selector)).toBe(second);
    expect(element.name).toBe('Buy the team plan');
  });

  it('keeps a readable path of the ancestors', async () => {
    const element = await pick(document.querySelector('button') as Element);
    expect(element.path).toBe('main > section.plans > button.buy');
  });

  it('keeps allowlisted attributes and hides secrets in them', async () => {
    const element = await pick(document.querySelector('a') as Element);
    expect(element.role).toBe('link');
    expect(element.attributes.href).toBe('https://app.dev/cb?access_token=redacted&page=2');
    expect(element.html).toContain('access_token=redacted');
    expect(element.html).not.toContain('abc');
  });

  it('strips scripts from the html and keeps it short', async () => {
    const main = document.querySelector('main') as Element;
    main.insertAdjacentHTML('beforeend', `<p>${'long text '.repeat(1000)}</p>`);
    const element = await pick(main);
    expect(element.html).not.toContain('<script');
    expect(element.html.length).toBeLessThanOrEqual(4096);
    expect(element.text.length).toBeLessThanOrEqual(200);
  });

  it('reads the React components and source from the fiber', async () => {
    const button = document.querySelector('button') as unknown as Element & Record<string, unknown>;
    const Button = function Button() {
      return null;
    };
    const fiber = {
      type: 'button',
      _debugSource: {
        fileName: '/home/me/shop/src/components/Button.tsx',
        lineNumber: 12,
        columnNumber: 3,
      },
      return: {
        type: Button,
        return: {
          type: { displayName: 'PricingCard' },
          return: {
            type: function App() {
              return null;
            },
            return: null,
          },
        },
      },
    };
    button.__reactFiber$abc123 = fiber;
    const element = await pick(button);
    expect(element.react).toEqual({
      components: ['App', 'PricingCard', 'Button'],
      source: 'src/components/Button.tsx:12:3',
    });
  });

  it('reports fixed elements', async () => {
    const bar = document.createElement('nav');
    bar.style.position = 'fixed';
    bar.innerHTML = '<button>Menu</button>';
    document.body.appendChild(bar);
    const element = await pick(bar.querySelector('button') as Element);
    expect(element.fixed).toBe(true);
  });
});

describe('pins', () => {
  const marker = (n: number, fixed = false): PageMarker => ({
    id: `m${n}`,
    n,
    fixed,
    rectPage: { x: 100, y: 900 + n, width: 50, height: 20 },
    rectViewport: { x: 100, y: 300, width: 50, height: 20 },
  });

  it('draws numbered pins at the top-left of each element, in page coordinates', () => {
    const api = inject();
    api.setMarkers([marker(1), marker(2, true)]);
    expect(api.inspect().markers).toEqual([
      { id: 'm1', n: 1, left: 100, top: 901, fixed: false, flashing: false },
      { id: 'm2', n: 2, left: 100, top: 300, fixed: true, flashing: false },
    ]);
  });

  it('replaces and clears pins', () => {
    const api = inject();
    api.setMarkers([marker(1), marker(2)]);
    api.setMarkers([marker(3)]);
    expect(api.inspect().markers.map((pin) => pin.n)).toEqual([3]);
    api.setMarkers([]);
    expect(api.inspect().markers).toEqual([]);
  });

  it('flashes one pin for a moment', () => {
    vi.useFakeTimers();
    try {
      const api = inject();
      api.setMarkers([marker(1)]);
      api.flashMarker('m1');
      expect(api.inspect().markers[0]?.flashing).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(api.inspect().markers[0]?.flashing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls a pin into view and pulses it', () => {
    const api = inject();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as typeof window.scrollTo;
    api.setMarkers([marker(1)]);
    expect(api.reveal('m1')).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number), behavior: 'smooth' }),
    );
    expect(api.inspect().markers[0]?.flashing).toBe(true);
    expect(api.reveal('nope')).toBe(false);
  });

  it('hides the highlight and the pins for a screenshot', () => {
    const api = inject();
    api.setMarkers([marker(1)]);
    api.setChromeHidden(true);
    expect(api.inspect().chromeHidden).toBe(true);
    expect((document.querySelector('runova-picker') as HTMLElement).style.visibility).toBe(
      'hidden',
    );
    api.setChromeHidden(false);
    expect(api.inspect().chromeHidden).toBe(false);
  });

  it('keeps pins after disarming', async () => {
    const api = inject();
    api.arm();
    api.setMarkers([marker(1)]);
    api.disarm();
    expect(api.inspect().armed).toBe(false);
    expect(api.inspect().markers).toHaveLength(1);
  });
});
