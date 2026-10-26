import type { Terminal } from '@xterm/xterm';

/**
 * Takes over the terminal's current input line so a pasted file can show as a short chip
 * instead of its whole path, while the shell still gets the real path once the line runs.
 *
 * It only ever engages on a line where a paste actually happened, and only once the shell has
 * reported (via an OSC 7750 marker injected at spawn, see `main/ptyHost/shellIntegration.ts`)
 * that it is sitting at a fresh prompt. Until then every keystroke is forwarded untouched, as
 * one write per chunk: splitting a chunk would tear escape sequences apart, and an arrow key
 * arriving as three separate writes reads to the shell as the literal text `[D`.
 *
 * It only ever owns what it draws itself, starting at the cursor. Whatever was typed before the
 * paste stays with the shell, which still holds it in its own line buffer, so it is never copied
 * into the model and never sent twice. Editing back past that point hands the line over.
 *
 * Anything it can't safely interpret (Tab, history, Ctrl+R, a resize, a line that would wrap)
 * resolves every chip to real text, hands the resolved line to the shell so its own echo
 * repaints it, and reverts to plain passthrough until the next fresh-prompt marker.
 */

const MARKER_OSC_IDENT = 7750;
const MARKER_PAYLOAD = 'Runova:PromptReady:1';
const PRINTABLE = /^[\x20-\x7e]$/;
/** The terminal telling the program it gained or lost focus. Not an edit, so it just passes. */
const FOCUS_REPORTS = ['\x1b[I', '\x1b[O'];

export interface ChipInput {
  realText: string;
  displayLabel: string;
}

type Cell =
  | { kind: 'char'; value: string }
  | { kind: 'chip'; id: number; displayLabel: string; realText: string };

export interface ChipPasteController {
  /** Feeds a raw `term.onData` chunk through chip mode; writes to the pty itself. */
  handleData(data: string): void;
  /** A file/image paste. True means it was absorbed as a chip; false means the caller should
   * fall back to writing the real paths as plain text, as if this feature didn't exist. */
  insertChips(chips: ChipInput[]): boolean;
  /** A plain-text paste. Only does anything once a chip is already on the line (true); false
   * means the caller should fall back to a plain paste. */
  insertText(text: string): boolean;
  dispose(): void;
}

export function createChipPasteController(
  term: Terminal,
  write: (data: string) => void,
): ChipPasteController {
  let ready = false;
  /**
   * The column our own rendering starts at: wherever the cursor was when the paste engaged.
   * Anything left of it was typed before the paste and belongs to the shell, which still holds
   * it in its own line buffer, so the model never contains it and it is never sent again.
   */
  let renderStart = 0;
  let cells: Cell[] = [];
  let cursor = 0;
  let engaged = false;
  /** The real cursor's column offset from `renderStart`, i.e. how far our own rendering ran. */
  let cursorScreenOffset = 0;
  let nextChipIndex = 1;

  function chipLabel(id: number): string {
    return `[Pasted #${id}]`;
  }

  function cellWidth(cell: Cell): number {
    return cell.kind === 'char' ? 1 : chipLabel(cell.id).length;
  }

  function totalWidth(list: Cell[]): number {
    return list.reduce((sum, c) => sum + cellWidth(c), 0);
  }

  function widthBefore(index: number): number {
    let w = 0;
    for (let i = 0; i < index; i++) w += cellWidth(cells[i]);
    return w;
  }

  function renderCell(cell: Cell): string {
    if (cell.kind === 'char') return cell.value;
    return `\x1b[7;36m${chipLabel(cell.id)}\x1b[0m`;
  }

  function charCells(text: string): Cell[] {
    return [...text].map((value) => ({ kind: 'char', value }) as Cell);
  }

  function resetIdle(): void {
    ready = false;
    engaged = false;
    renderStart = 0;
    cells = [];
    cursor = 0;
    cursorScreenOffset = 0;
  }

  /** Chip mode only ever owns a single row, so anything that would wrap is handed back. */
  function fitsOnLine(width: number): boolean {
    return renderStart + width <= term.cols;
  }

  /** Erases everything drawn since the boundary (by us or the shell's own echo) and rewrites
   * the full model, leaving the real cursor at the model cursor's position. */
  function redraw(): void {
    let out = cursorScreenOffset > 0 ? `\x1b[${cursorScreenOffset}D` : '';
    out += '\x1b[K';
    out += cells.map(renderCell).join('');
    const back = totalWidth(cells) - widthBefore(cursor);
    if (back > 0) out += `\x1b[${back}D`;
    term.write(out);
    cursorScreenOffset = widthBefore(cursor);
  }

  /** Resolves every chip to real text, wipes our own rendering, and lets the shell's real echo
   * take over for the resolved text plus whatever raw bytes follow it. One write, never split. */
  function handOff(trailingRaw: string, submitSuffix: string): void {
    const resolved = cells.map((c) => (c.kind === 'char' ? c.value : c.realText)).join('');
    term.write((cursorScreenOffset > 0 ? `\x1b[${cursorScreenOffset}D` : '') + '\x1b[K');
    write(resolved + trailingRaw + submitSuffix);
    resetIdle();
  }

  /**
   * Whether chip mode can take over from where the cursor is. It only ever appends at the
   * cursor, so the one thing it cannot cope with is text sitting after the cursor: its redraw
   * erases to end of line, which would wipe text the shell still believes is there.
   *
   * That also keeps it clear of inline predictions (PSReadLine, zsh-autosuggestions, fish),
   * which are drawn after the cursor and are indistinguishable from typed text in the buffer.
   */
  function canEngage(): boolean {
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return !!line && !line.translateToString(true, buffer.cursorX).trim();
  }

  const oscDisposable = term.parser.registerOscHandler(MARKER_OSC_IDENT, (payload) => {
    if (payload !== MARKER_PAYLOAD) return false;
    resetIdle();
    ready = true;
    return true;
  });

  const resizeDisposable = term.onResize(() => {
    if (engaged) handOff('', '');
    else ready = false;
  });

  function handleData(data: string): void {
    if (!engaged) {
      // Submitting leaves this prompt behind; the next one re-arms. Inspect only, so the chunk
      // still goes out whole.
      if (ready && (data.includes('\r') || data.includes('\n'))) resetIdle();
      write(data);
      return;
    }
    let i = 0;
    while (i < data.length && engaged) {
      const rest = data.slice(i);
      if (rest[0] === '\r' || rest[0] === '\n') {
        handOff('', '\r');
        i += 1;
        continue;
      }
      const focusReport = FOCUS_REPORTS.find((seq) => rest.startsWith(seq));
      if (focusReport) {
        write(focusReport);
        i += focusReport.length;
        continue;
      }
      if (rest[0] === '\x7f' || rest[0] === '\b') {
        // Backspacing past our own region means deleting what the user typed before the paste,
        // which only the shell holds, so it takes the line back from here.
        if (cursor === 0) {
          handOff(rest, '');
          return;
        }
        cells.splice(cursor - 1, 1);
        cursor -= 1;
        redraw();
        i += 1;
        continue;
      }
      if (rest.startsWith('\x1b[3~')) {
        if (cursor < cells.length) {
          cells.splice(cursor, 1);
          redraw();
        }
        i += 4;
        continue;
      }
      if (rest.startsWith('\x1b[C')) {
        if (cursor < cells.length) {
          cursor += 1;
          redraw();
        }
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[D')) {
        // Same as backspace: moving left of our region puts the cursor in the shell's text.
        if (cursor === 0) {
          handOff(rest, '');
          return;
        }
        cursor -= 1;
        redraw();
        i += 3;
        continue;
      }
      if (PRINTABLE.test(rest[0])) {
        // Take the whole run in one go: a pasted line arriving as one chunk should cost one
        // redraw, not one per character.
        let end = 1;
        while (end < rest.length && PRINTABLE.test(rest[end])) end += 1;
        const run = charCells(rest.slice(0, end));
        if (!fitsOnLine(totalWidth(cells) + run.length)) {
          handOff(rest, '');
          return;
        }
        cells.splice(cursor, 0, ...run);
        cursor += run.length;
        redraw();
        i += end;
        continue;
      }
      // Tab, history recall, Ctrl+R/C/D, an unowned escape sequence, a non-ASCII byte: none of
      // these are safe to interpret locally, so the rest of this chunk hands off as one go.
      handOff(rest, '');
      return;
    }
    // Chip mode let go part way through the chunk (a submit, a hand-off); the rest is the
    // shell's, and goes as a single write.
    if (i < data.length) write(data.slice(i));
  }

  function insertChips(chips: ChipInput[]): boolean {
    if (!ready) return false;
    if (!engaged && !canEngage()) return false;
    const additions: Cell[] = chips.map((chip) => ({
      kind: 'chip',
      id: nextChipIndex++,
      displayLabel: chip.displayLabel,
      realText: chip.realText,
    }));
    const startCol = engaged ? renderStart : term.buffer.active.cursorX;
    if (startCol + totalWidth(cells) + totalWidth(additions) > term.cols) {
      nextChipIndex -= chips.length;
      return false;
    }
    if (!engaged) {
      // Whatever was typed before this paste stays with the shell, which still has it in its own
      // line buffer. Taking a copy into the model would send it a second time on hand-off.
      renderStart = startCol;
      cells = [];
      cursor = 0;
      cursorScreenOffset = 0;
      engaged = true;
    }
    cells.splice(cursor, 0, ...additions);
    cursor += additions.length;
    redraw();
    return true;
  }

  function insertText(text: string): boolean {
    if (!engaged) return false;
    if (![...text].every((ch) => PRINTABLE.test(ch))) {
      handOff(text, '');
      return true;
    }
    const additions = charCells(text);
    if (!fitsOnLine(totalWidth(cells) + additions.length)) {
      handOff('', '');
      write(text);
      return true;
    }
    cells.splice(cursor, 0, ...additions);
    cursor += additions.length;
    redraw();
    return true;
  }

  return {
    handleData,
    insertChips,
    insertText,
    dispose(): void {
      oscDisposable.dispose();
      resizeDisposable.dispose();
    },
  };
}
