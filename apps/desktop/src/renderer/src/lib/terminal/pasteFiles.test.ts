import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import type { ChipPasteController } from './chipPasteMode';
import {
  attachTerminalPaste,
  isDuplicatePaste,
  pasteClipboardIntoTerminal,
  pasteFilesToChips,
  pathsToChips,
  type TerminalPasteTarget,
} from './pasteFiles';

function chipMode(answers: { insertChips?: boolean; insertText?: boolean } = {}) {
  return {
    handleData: vi.fn(),
    insertChips: vi.fn(() => answers.insertChips ?? false),
    insertText: vi.fn(() => answers.insertText ?? false),
    dispose: vi.fn(),
  } satisfies ChipPasteController;
}

function target(
  mode: ChipPasteController | null = null,
  shell = 'powershell.exe',
): TerminalPasteTarget & { paste: Mock<(text: string) => void> } {
  return { chipMode: mode, paste: vi.fn<(text: string) => void>(), shell: () => shell };
}

let bridge: FakeBridge;

/**
 * The module remembers when a paste last went in, to ignore the duplicate DOM event Chromium
 * fires afterwards. That window is 300ms of wall clock, which a test file runs through in much
 * less, so every test starts a second later than the last one.
 */
const realNow = Date.now.bind(Date);
let clockOffset = 0;

beforeEach(() => {
  clockOffset += 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  bridge = installRunovaBridge({
    platform: 'win32',
    // The real bridge answers synchronously; the default async stand-in would hand back a
    // promise, which reads as "this file has a path on disk".
    'shell.pathForFile': () => undefined,
  });
});

describe('pathsToChips', () => {
  it('quotes each path for the shell and keeps a short name for it', () => {
    const chips = pathsToChips(['C:\\Users\\A B\\shot.png'], 'powershell.exe');
    expect(chips).toEqual([{ realText: "'C:\\Users\\A B\\shot.png'", displayLabel: 'shot.png' }]);
  });

  it('quotes for the shell that is actually running', () => {
    installRunovaBridge({ platform: 'linux', 'shell.pathForFile': () => undefined });
    const [chip] = pathsToChips(['/home/me/a file.png'], 'bash');
    expect(chip.realText).toBe("'/home/me/a file.png'");
  });

  it('names a file by its last segment whatever separator the path uses', () => {
    expect(pathsToChips(['/home/me/a.png'], 'bash')[0].displayLabel).toBe('a.png');
    expect(pathsToChips(['C:\\x\\b.png'], 'cmd.exe')[0].displayLabel).toBe('b.png');
  });

  it('falls back to the whole path when there is no last segment', () => {
    expect(pathsToChips(['/'], 'bash')[0].displayLabel).toBe('/');
  });

  it('has no chips for no paths', () => {
    expect(pathsToChips([], 'bash')).toEqual([]);
  });
});

describe('pasteFilesToChips', () => {
  it('uses the real path of a file dragged from the file manager', async () => {
    installRunovaBridge({
      platform: 'win32',
      'shell.pathForFile': () => 'C:\\pics\\a.png',
    });
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    // A path with no space in it needs no quoting, so it goes in exactly as it is.
    expect(await pasteFilesToChips([file], 'powershell.exe')).toEqual([
      { realText: 'C:\\pics\\a.png', displayLabel: 'a.png' },
    ]);
  });

  it('saves a clipboard-only image and uses where it landed', async () => {
    // A screenshot on the clipboard has no path, and an agent CLI attaches an image by path.
    bridge = installRunovaBridge({
      platform: 'win32',
      'shell.pathForFile': () => undefined,
      'terminalClipboard.saveImage': async () => 'C:\\tmp\\pasted.png',
    });
    const file = new File([new Uint8Array([1, 2])], 'clip.png', { type: 'image/png' });
    const chips = await pasteFilesToChips([file], 'powershell.exe');
    expect(chips).toEqual([{ realText: 'C:\\tmp\\pasted.png', displayLabel: 'pasted.png' }]);
    const [bytes, type] = bridge.$fn('terminalClipboard.saveImage').mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(type).toBe('image/png');
  });

  it('skips a pathless file that is not an image it can save', async () => {
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' });
    expect(await pasteFilesToChips([file], 'bash')).toEqual([]);
  });
});

describe('pasteClipboardIntoTerminal', () => {
  it('does nothing when the clipboard holds nothing it can use', async () => {
    const pane = target();
    await pasteClipboardIntoTerminal(pane);
    expect(pane.paste).not.toHaveBeenCalled();
  });

  it('does nothing when reading the clipboard fails', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => {
        throw new Error('no clipboard');
      },
    });
    const pane = target();
    await expect(pasteClipboardIntoTerminal(pane)).resolves.toBeUndefined();
    expect(pane.paste).not.toHaveBeenCalled();
  });

  it('types clipboard text into the terminal', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => ({ kind: 'text', text: 'ls -al' }),
    });
    const pane = target();
    await pasteClipboardIntoTerminal(pane);
    expect(pane.paste).toHaveBeenCalledWith('ls -al');
  });

  it('routes text through chip mode when a chip is already on the line', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => ({ kind: 'text', text: 'more' }),
    });
    const mode = chipMode({ insertText: true });
    const pane = target(mode);
    await pasteClipboardIntoTerminal(pane);
    expect(mode.insertText).toHaveBeenCalledWith('more');
    expect(pane.paste).not.toHaveBeenCalled();
  });

  it('shows pasted files as chips, with a space after them', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => ({ kind: 'files', paths: ['C:\\pics\\a.png'] }),
    });
    const mode = chipMode({ insertChips: true });
    const pane = target(mode);
    await pasteClipboardIntoTerminal(pane);
    expect(mode.insertChips).toHaveBeenCalledWith([
      { realText: 'C:\\pics\\a.png', displayLabel: 'a.png' },
    ]);
    expect(mode.insertText).toHaveBeenCalledWith(' ');
    expect(pane.paste).not.toHaveBeenCalled();
  });

  it('falls back to the real quoted paths when chips are not available', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => ({
        kind: 'files',
        paths: ['C:\\pics\\a.png', 'C:\\pics\\b.png'],
      }),
    });
    const pane = target(null);
    await pasteClipboardIntoTerminal(pane);
    expect(pane.paste).toHaveBeenCalledWith('C:\\pics\\a.png C:\\pics\\b.png ');
  });

  it('marks the paste, so the DOM event Chromium fires afterwards is ignored', async () => {
    installRunovaBridge({
      platform: 'win32',
      'terminalClipboard.read': async () => ({ kind: 'text', text: 'x' }),
    });
    await pasteClipboardIntoTerminal(target());
    expect(isDuplicatePaste()).toBe(true);
  });
});

describe('attachTerminalPaste', () => {
  /** A paste event carrying whatever the clipboard held, as Chromium delivers it. */
  function pasteEvent(data: { text?: string; files?: File[] }): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: data.files ?? [],
        getData: () => data.text ?? '',
      },
    });
    return event;
  }

  it('leaves a plain text paste to xterm', () => {
    const element = document.createElement('div');
    const pane = target();
    const off = attachTerminalPaste(element, pane);
    const event = pasteEvent({ text: 'hello' });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(pane.paste).not.toHaveBeenCalled();
    off();
  });

  it('takes text over when a chip is on the line', () => {
    const element = document.createElement('div');
    const mode = chipMode({ insertText: true });
    const off = attachTerminalPaste(element, target(mode));
    const event = pasteEvent({ text: 'hello' });
    element.dispatchEvent(event);
    expect(mode.insertText).toHaveBeenCalledWith('hello');
    expect(event.defaultPrevented).toBe(true);
    off();
  });

  it('turns dropped files into chips', async () => {
    installRunovaBridge({ platform: 'win32', 'shell.pathForFile': () => 'C:\\pics\\a.png' });
    const element = document.createElement('div');
    const mode = chipMode({ insertChips: true });
    const off = attachTerminalPaste(element, target(mode));
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    element.dispatchEvent(pasteEvent({ files: [file] }));
    await vi.waitFor(() => expect(mode.insertChips).toHaveBeenCalled());
    off();
  });

  it('asks the main process when the clipboard hands a textarea nothing', async () => {
    // A pasted screenshot arrives empty here; only the main process can see the image.
    const read = vi.fn(async () => ({ kind: 'text', text: 'from main' }));
    installRunovaBridge({ platform: 'win32', 'terminalClipboard.read': read });
    const element = document.createElement('div');
    const pane = target();
    const off = attachTerminalPaste(element, pane);
    element.dispatchEvent(pasteEvent({}));
    await vi.waitFor(() => expect(pane.paste).toHaveBeenCalledWith('from main'));
    off();
  });

  it('stops listening after its cleanup runs', () => {
    const element = document.createElement('div');
    const mode = chipMode({ insertText: true });
    attachTerminalPaste(element, target(mode))();
    element.dispatchEvent(pasteEvent({ text: 'hello' }));
    expect(mode.insertText).not.toHaveBeenCalled();
  });
});
