import { beforeEach, describe, expect, it, vi } from 'vitest';

type KeyHandler = (event: KeyboardEvent) => boolean;

const fake = vi.hoisted(() => ({
  keyHandler: null as KeyHandler | null,
  paste: vi.fn(async () => undefined),
  hasSelection: false,
  options: null as Record<string, unknown> | null,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      fake.options = options;
    }
    loadAddon = vi.fn();
    onData = vi.fn();
    paste = vi.fn();
    input = vi.fn();
    hasSelection(): boolean {
      return fake.hasSelection;
    }
    getSelection(): string {
      return 'selected';
    }
    attachCustomKeyEventHandler(handler: KeyHandler): void {
      fake.keyHandler = handler;
    }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@/lib/terminal/chipPasteMode', () => ({ createChipPasteController: () => null }));
vi.mock('@/lib/terminal/imageChipPreview', () => ({
  createImageChipPreview: () => ({ noteOutgoing: () => undefined }),
}));
vi.mock('@/lib/terminal/pasteFiles', () => ({ pasteClipboardIntoTerminal: fake.paste }));
vi.mock('@/stores/shortcutStore', () => ({
  commandForEvent: () => null,
  useShortcutStore: { getState: () => ({ overrides: {} }) },
}));

const { createXterm } = await import('./xtermFactory');

function keydown(fields: Partial<KeyboardEvent>): KeyboardEvent & { preventDefault: () => void } {
  return {
    type: 'keydown',
    key: '',
    code: '',
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...fields,
  } as unknown as KeyboardEvent & { preventDefault: () => void };
}

describe('createXterm key handling', () => {
  beforeEach(() => {
    fake.keyHandler = null;
    fake.paste.mockClear();
    fake.hasSelection = false;
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      runova: { platform: 'win32', windowsBuild: 26200, terminal: { write: vi.fn() } },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } });
    createXterm({ sessionId: () => 'session' });
  });

  it('pastes from the clipboard when Win+V sends its Ctrl+V on a Persian layout', () => {
    const event = keydown({ key: 'ر', code: '', keyCode: 86, ctrlKey: true });
    // false tells xterm to leave the key alone, so no raw ^V reaches the shell.
    expect(fake.keyHandler?.(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(fake.paste).toHaveBeenCalledTimes(1);
  });

  it('pastes from the clipboard on a physical Ctrl+V', () => {
    const event = keydown({ key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true });
    expect(fake.keyHandler?.(event)).toBe(false);
    expect(fake.paste).toHaveBeenCalledTimes(1);
  });

  it('lets the Windows key through without pasting', () => {
    const event = keydown({ key: 'Meta', code: 'MetaLeft', keyCode: 91, metaKey: true });
    expect(fake.keyHandler?.(event)).toBe(true);
    expect(fake.paste).not.toHaveBeenCalled();
  });

  it('still sends Ctrl+C to the shell when nothing is selected', () => {
    const event = keydown({ key: 'ز', code: '', keyCode: 67, ctrlKey: true });
    expect(fake.keyHandler?.(event)).toBe(true);
    expect(fake.paste).not.toHaveBeenCalled();
  });
});

describe('createXterm options', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      runova: { platform: 'win32', windowsBuild: 26200, terminal: { write: vi.fn() } },
    });
  });

  it('draws Persian and Arabic letters in Vazirmatn and keeps the monospace face for the rest', async () => {
    const { TERMINAL_RTL_FONT } = await import('./fontReady');
    createXterm({ sessionId: () => 'session' });
    const family = String(fake.options?.fontFamily);
    expect(family.startsWith(`'${TERMINAL_RTL_FONT}', 'Cascadia Code'`)).toBe(true);
  });
});
