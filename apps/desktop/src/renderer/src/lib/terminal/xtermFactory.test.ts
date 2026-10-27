import { beforeEach, describe, expect, it, vi } from 'vitest';

type KeyHandler = (event: KeyboardEvent) => boolean;

const fake = vi.hoisted(() => ({
  keyHandler: null as KeyHandler | null,
  paste: vi.fn(async () => undefined),
  hasSelection: false,
  options: null as Record<string, unknown> | null,
  webLinkOpen: null as ((event: MouseEvent, uri: string) => void) | null,
  oscHandlers: new Map<number, (payload: string) => boolean>(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      fake.options = options;
    }
    loadAddon = vi.fn();
    onData = vi.fn();
    parser = {
      registerOscHandler: (ident: number, handler: (payload: string) => boolean) => {
        fake.oscHandlers.set(ident, handler);
        return { dispose: () => fake.oscHandlers.delete(ident) };
      },
    };
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
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(open: (event: MouseEvent, uri: string) => void) {
      fake.webLinkOpen = open;
    }
  },
}));
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

function click(fields: Partial<MouseEvent> = {}): MouseEvent {
  return { ctrlKey: false, metaKey: false, ...fields } as MouseEvent;
}

type LinkHandler = {
  activate: (event: MouseEvent, uri: string) => void;
  allowNonHttpProtocols?: boolean;
};

describe('createXterm links', () => {
  const openExternal = vi.fn(async () => undefined);
  const confirm = vi.fn(() => true);

  beforeEach(() => {
    openExternal.mockClear();
    confirm.mockClear();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      runova: {
        platform: 'darwin',
        windowsBuild: null,
        terminal: { write: vi.fn() },
        shell: { openExternal },
      },
    });
    vi.stubGlobal('confirm', confirm);
    createXterm({ sessionId: () => 'session' });
  });

  // Claude Code prints its links with OSC 8. xterm's own handler for those asked "Do you want to
  // navigate to ...?" and then opened a blank window that the main window turned away.
  it('opens an OSC 8 link in the browser on Cmd+click, without asking first', () => {
    const handler = fake.options?.linkHandler as LinkHandler | undefined;
    expect(handler).toBeDefined();
    handler?.activate(click({ metaKey: true }), 'https://example.com/docs');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('opens an OSC 8 link on Ctrl+click too', () => {
    const handler = fake.options?.linkHandler as LinkHandler;
    handler.activate(click({ ctrlKey: true }), 'https://example.com/');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('leaves a plain click on an OSC 8 link for selecting text', () => {
    const handler = fake.options?.linkHandler as LinkHandler;
    handler.activate(click(), 'https://example.com/');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('only lets http and https OSC 8 links through, as the main process does', () => {
    const handler = fake.options?.linkHandler as LinkHandler;
    expect(handler.allowNonHttpProtocols).toBe(false);
  });

  it('opens a plain URL in the output the same way', () => {
    fake.webLinkOpen?.(click(), 'https://example.com/plain');
    expect(openExternal).not.toHaveBeenCalled();
    fake.webLinkOpen?.(click({ metaKey: true }), 'https://example.com/plain');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/plain');
  });
});

describe('createXterm copying', () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    fake.hasSelection = false;
    fake.oscHandlers.clear();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      runova: { platform: 'darwin', windowsBuild: null, terminal: { write: vi.fn() } },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    createXterm({ sessionId: () => 'session' });
  });

  // With mouse tracking on (Claude Code's full-screen mode) a drag goes to the program. Shift
  // forces a real selection elsewhere, but on a Mac xterm only honors Option with this set.
  it('lets Option+drag select on a Mac while a program has the mouse', () => {
    expect(fake.options?.macOptionClickForcesSelection).toBe(true);
  });

  it('copies the selection on Cmd+C', () => {
    fake.hasSelection = true;
    const event = keydown({ key: 'c', code: 'KeyC', keyCode: 67, metaKey: true });
    expect(fake.keyHandler?.(event)).toBe(false);
    expect(writeText).toHaveBeenCalledWith('selected');
  });

  it('puts text a program copies with OSC 52 on the clipboard', () => {
    const handler = fake.oscHandlers.get(52);
    expect(handler).toBeDefined();
    expect(handler?.(`c;${btoa('copied text')}`)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('copied text');
  });
});
