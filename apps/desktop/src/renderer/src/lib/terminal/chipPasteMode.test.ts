import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChipPasteController, createChipPasteController } from './chipPasteMode';

/**
 * Chip mode owns the input line between the shell and xterm, so the fake terminal has to answer
 * the three things it reads: how wide the line is, where the cursor sits, and what is already on
 * the line to the right of it.
 */
function fakeTerm(options: { cols?: number; cursorX?: number; afterCursor?: string } = {}) {
  const drawn: string[] = [];
  const handlers: {
    osc: ((payload: string) => boolean) | null;
    resize: (() => void) | null;
  } = { osc: null, resize: null };
  const oscDispose = vi.fn();
  const resizeDispose = vi.fn();
  const state = { cursorX: options.cursorX ?? 0, afterCursor: options.afterCursor ?? '' };

  const term = {
    cols: options.cols ?? 80,
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        get cursorX() {
          return state.cursorX;
        },
        getLine: () => ({
          // xterm's second argument is the start column, so this is the text after the cursor.
          translateToString: (_trim: boolean, start = 0): string => state.afterCursor.slice(start),
        }),
      },
    },
    parser: {
      registerOscHandler: (_ident: number, handler: (payload: string) => boolean) => {
        handlers.osc = handler;
        return { dispose: oscDispose };
      },
    },
    onResize: (handler: () => void) => {
      handlers.resize = handler;
      return { dispose: resizeDispose };
    },
    write: (data: string) => {
      drawn.push(data);
    },
  };

  return { term, drawn, handlers, state, oscDispose, resizeDispose };
}

function setup(options: Parameters<typeof fakeTerm>[0] = {}) {
  const fake = fakeTerm(options);
  const toPty: string[] = [];
  const controller: ChipPasteController = createChipPasteController(
    fake.term as unknown as Terminal,
    (data) => toPty.push(data),
  );
  /** The shell reporting a fresh prompt, the one thing that arms chip mode. */
  const armPrompt = (): void => {
    fake.handlers.osc?.('Runova:PromptReady:1');
  };
  return { ...fake, controller, toPty, armPrompt, screen: () => fake.drawn.join('') };
}

let env: ReturnType<typeof setup>;

beforeEach(() => {
  env = setup();
});

describe('arming', () => {
  it('absorbs nothing before the shell says it is at a fresh prompt', () => {
    expect(env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }])).toBe(
      false,
    );
    expect(env.screen()).toBe('');
  });

  it('ignores a marker from some other program', () => {
    expect(env.handlers.osc?.('something else')).toBe(false);
    expect(env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }])).toBe(
      false,
    );
  });

  it('takes over once the prompt marker arrives', () => {
    env.armPrompt();
    expect(env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }])).toBe(true);
    expect(env.screen()).toContain('[Pasted #1]');
    // Nothing reaches the shell yet: it only gets the real path when the line runs.
    expect(env.toPty).toEqual([]);
  });

  it('refuses to take over when there is text after the cursor', () => {
    // Its redraw erases to end of line, which would wipe text the shell still believes is there.
    // That also keeps it clear of inline predictions from PSReadLine and friends.
    env = setup({ afterCursor: 'suggestion' });
    env.armPrompt();
    expect(env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }])).toBe(
      false,
    );
  });

  it('refuses a paste that would not fit on the line', () => {
    env = setup({ cols: 20 });
    env.armPrompt();
    const chips = [
      { realText: "'a.png'", displayLabel: 'a.png' },
      { realText: "'b.png'", displayLabel: 'b.png' },
    ];
    expect(env.controller.insertChips(chips)).toBe(false);
    // The numbers it would have used are given back, so the next chip is still #1.
    expect(env.controller.insertChips([chips[0]])).toBe(true);
    expect(env.screen()).toContain('[Pasted #1]');
  });

  it('starts numbering from where it left off within one line', () => {
    env.armPrompt();
    env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }]);
    env.controller.insertChips([{ realText: "'b.png'", displayLabel: 'b.png' }]);
    expect(env.screen()).toContain('[Pasted #2]');
  });
});

describe('editing a line with a chip on it', () => {
  beforeEach(() => {
    env.armPrompt();
    env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }]);
    env.drawn.length = 0;
  });

  it('draws typed characters itself instead of sending them on', () => {
    env.controller.handleData('hi');
    expect(env.screen()).toContain('hi');
    expect(env.screen()).toContain('[Pasted #1]');
    expect(env.toPty).toEqual([]);
  });

  it('redraws a pasted run once, not once per character', () => {
    env.controller.handleData('hello world');
    // One erase-and-redraw for the whole chunk.
    expect(env.drawn).toHaveLength(1);
  });

  it('hands the resolved line to the shell when the user presses Enter', () => {
    env.controller.handleData('hi');
    env.toPty.length = 0;
    env.controller.handleData('\r');
    expect(env.toPty).toEqual(["'a.png'hi\r"]);
  });

  it('starts over at the next prompt rather than reusing the old line', () => {
    env.controller.handleData('\r');
    expect(env.controller.insertText('x')).toBe(false);
    expect(env.controller.insertChips([{ realText: "'b.png'", displayLabel: 'b.png' }])).toBe(
      false,
    );
  });

  it('deletes its own cells on backspace', () => {
    env.controller.handleData('hi');
    env.drawn.length = 0;
    env.controller.handleData('\x7f');
    expect(env.screen()).toContain('h');
    expect(env.screen()).not.toContain('hi');
    expect(env.toPty).toEqual([]);
  });

  it('gives the line back when a backspace would reach past what it drew', () => {
    // Everything left of the paste belongs to the shell, which still holds it in its buffer.
    env.controller.handleData('\x1b[D');
    env.controller.handleData('\x7f');
    expect(env.toPty).toEqual(["'a.png'\x7f"]);
    expect(env.controller.insertText('x')).toBe(false);
  });

  it('gives the line back when the cursor moves left out of its region', () => {
    // The first arrow lands on its own first cell; the second would enter the shell's text.
    env.controller.handleData('\x1b[D');
    expect(env.toPty).toEqual([]);
    env.controller.handleData('\x1b[D');
    expect(env.toPty).toEqual(["'a.png'\x1b[D"]);
  });

  it('moves within its own cells without telling the shell', () => {
    env.controller.handleData('ab');
    env.toPty.length = 0;
    env.controller.handleData('\x1b[D');
    env.controller.handleData('\x1b[C');
    expect(env.toPty).toEqual([]);
  });

  it('deletes forward with the Delete key', () => {
    env.controller.handleData('ab');
    env.controller.handleData('\x1b[D');
    env.drawn.length = 0;
    env.controller.handleData('\x1b[3~');
    expect(env.screen()).toContain('a');
    expect(env.screen()).not.toContain('ab');
  });

  it('passes a focus report through without giving up the line', () => {
    env.controller.handleData('\x1b[I');
    expect(env.toPty).toEqual(['\x1b[I']);
    // Still in charge: a focus report is not an edit.
    expect(env.controller.insertText('x')).toBe(true);
  });

  it('gives the line back for anything it cannot safely interpret', () => {
    // Tab completion, history recall and Ctrl+R all rewrite the line from the shell's side.
    env.controller.handleData('\t');
    expect(env.toPty).toEqual(["'a.png'\t"]);
    expect(env.controller.insertText('x')).toBe(false);
  });

  it('gives the line back rather than letting it wrap', () => {
    env = setup({ cols: 20 });
    env.armPrompt();
    env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }]);
    env.toPty.length = 0;
    env.controller.handleData('0123456789');
    expect(env.toPty).toEqual(["'a.png'0123456789"]);
  });

  it('sends the rest of a chunk as one write after it lets go part way through', () => {
    env.controller.handleData('ab\rnext');
    // One write for the resolved line, one for everything after the Enter, never split up.
    expect(env.toPty).toEqual(["'a.png'ab\r", 'next']);
  });

  it('resolves the chips when the terminal is resized under it', () => {
    env.handlers.resize?.();
    expect(env.toPty).toEqual(["'a.png'"]);
  });
});

describe('pasting text onto a line that has no chip', () => {
  it('leaves a plain paste to xterm', () => {
    env.armPrompt();
    expect(env.controller.insertText('hello')).toBe(false);
  });

  it('forwards keystrokes untouched, one write per chunk', () => {
    // Splitting a chunk would tear an escape sequence apart, and an arrow key arriving as
    // three writes reads to the shell as the literal text "[D".
    env.controller.handleData('\x1b[D');
    expect(env.toPty).toEqual(['\x1b[D']);
  });
});

describe('pasting text onto a line that has a chip', () => {
  beforeEach(() => {
    env.armPrompt();
    env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }]);
    env.drawn.length = 0;
  });

  it('goes through the model, so the two never disagree about the line', () => {
    expect(env.controller.insertText(' and more')).toBe(true);
    expect(env.screen()).toContain(' and more');
    expect(env.toPty).toEqual([]);
  });

  it('gives the line back for text it cannot draw itself', () => {
    expect(env.controller.insertText('two\nlines')).toBe(true);
    expect(env.toPty).toEqual(["'a.png'two\nlines"]);
  });

  it('gives the line back, then pastes plainly, when the text would not fit', () => {
    env = setup({ cols: 20 });
    env.armPrompt();
    env.controller.insertChips([{ realText: "'a.png'", displayLabel: 'a.png' }]);
    env.toPty.length = 0;
    expect(env.controller.insertText('0123456789')).toBe(true);
    expect(env.toPty).toEqual(["'a.png'", '0123456789']);
  });
});

describe('dispose', () => {
  it('lets go of the terminal hooks it registered', () => {
    env.controller.dispose();
    expect(env.oscDispose).toHaveBeenCalled();
    expect(env.resizeDispose).toHaveBeenCalled();
  });
});
