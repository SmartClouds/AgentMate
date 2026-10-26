import { quoteForShell, shellKindFor } from '@runova/core';
import type { ChipInput, ChipPasteController } from '@/lib/terminal/chipPasteMode';

/**
 * Pasting into a terminal the way an agent CLI wants it: text goes in as text (xterm handles
 * that), while an image or a copied file goes in as a quoted path. Agents such as Claude Code
 * and Codex attach an image when given its path, which is how a pasted screenshot reaches them.
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** A path for each pasted file: its own on disk, or a saved copy for clipboard-only images. */
async function pathsForFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const onDisk = window.runova.shell.pathForFile(file);
    if (onDisk) {
      paths.push(onDisk);
      continue;
    }
    if (IMAGE_TYPES.has(file.type)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      paths.push(await window.runova.terminalClipboard.saveImage(bytes, file.type));
    }
  }
  return paths;
}

function shortLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

/** One chip per path: its own quoted text for the shell, and a short name to remember it by
 * (the chip itself just shows an index; the label is there for whatever needs it later). */
export function pathsToChips(paths: string[], shell: string | undefined): ChipInput[] {
  const kind = shellKindFor(shell, window.runova.platform);
  return paths.map((path) => ({
    realText: quoteForShell(path, kind),
    displayLabel: shortLabel(path),
  }));
}

export async function pasteFilesToChips(
  files: File[],
  shell: string | undefined,
): Promise<ChipInput[]> {
  return pathsToChips(await pathsForFiles(files), shell);
}

/**
 * The paste event itself, for the routes that still produce one: a middle-click paste, and the
 * paste Electron's own Edit menu performs when its Ctrl+V accelerator gets the key before the
 * terminal does. Returns a cleanup.
 */
export function attachTerminalPaste(element: HTMLElement, target: TerminalPasteTarget): () => void {
  const onPaste = (event: ClipboardEvent): void => {
    // Ctrl+V and right-click read the clipboard themselves; Chromium can still fire a paste
    // event afterwards, and acting on that too would paste the same thing twice.
    if (isDuplicatePaste()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const files = Array.from(event.clipboardData?.files ?? []);
    // Text copied from a web page can come with an image of itself; the text is what was meant.
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) {
      // Plain text is xterm's to paste, unless a chip is on the line, where it has to go
      // through the model instead or the two would disagree about what the line holds.
      if (target.chipMode?.insertText(text)) {
        event.preventDefault();
        event.stopPropagation();
        markPasted();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    markPasted();
    if (files.length === 0) {
      // An empty paste means the clipboard holds something a textarea cannot take, i.e. an
      // image, so ask the main process, which can see it.
      void pasteClipboardIntoTerminal(target);
      return;
    }
    void pasteFilesToChips(files, target.shell()).then((chips) => {
      if (chips.length === 0) return;
      if (target.chipMode?.insertChips(chips)) {
        target.chipMode.insertText(' ');
        return;
      }
      target.paste(`${chips.map((chip) => chip.realText).join(' ')} `);
    });
  };
  // Capture phase: xterm listens on its own textarea further down.
  element.addEventListener('paste', onPaste, true);
  return () => element.removeEventListener('paste', onPaste, true);
}

export interface TerminalPasteTarget {
  /** Shows pasted files as chips when the shell is ready for them. */
  chipMode: ChipPasteController | null;
  /** Types text into the shell the way xterm would, keeping bracketed paste intact. */
  paste: (text: string) => void;
  shell: () => string | undefined;
}

let lastPasteAt = 0;

/** A paste just went in through some other route, so the DOM paste event that may follow is a
 * duplicate. Chromium fires one for menu-driven pastes even when the keydown was handled. */
function markPasted(): void {
  lastPasteAt = Date.now();
}

function pastedJustNow(): boolean {
  return Date.now() - lastPasteAt < 300;
}

/**
 * The one way anything reaches a terminal from the clipboard: Ctrl+V, Shift+Insert, right-click,
 * and the paste Windows synthesizes when you pick an item out of Win+V all end up here.
 *
 * It asks the main process rather than reading the clipboard in the renderer, which is what makes
 * an image work at all: Chromium hands a plain textarea nothing but text, so a pasted screenshot
 * arrived empty and only right-click (which already asked the main process) could see it.
 */
export async function pasteClipboardIntoTerminal(target: TerminalPasteTarget): Promise<void> {
  const content = await window.runova.terminalClipboard.read().catch(() => null);
  if (!content) return;
  markPasted();
  if (content.kind === 'text') {
    if (target.chipMode?.insertText(content.text)) return;
    target.paste(content.text);
    return;
  }
  const chips = pathsToChips(content.paths, target.shell());
  if (chips.length === 0) return;
  if (target.chipMode?.insertChips(chips)) {
    target.chipMode.insertText(' ');
    return;
  }
  target.paste(`${chips.map((chip) => chip.realText).join(' ')} `);
}

/** True when this paste event follows one already handled through the clipboard read above. */
export function isDuplicatePaste(): boolean {
  return pastedJustNow();
}
