import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachOsc52Clipboard, osc52Text } from './osc52';

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe('osc52Text', () => {
  it('decodes the text a program copies', () => {
    expect(osc52Text(`c;${base64('hello world')}`)).toBe('hello world');
  });

  it('decodes UTF-8, so Persian and emoji come through whole', () => {
    expect(osc52Text(`c;${base64('سلام 👋')}`)).toBe('سلام 👋');
  });

  it('accepts any selection target, or none at all', () => {
    expect(osc52Text(`;${base64('x')}`)).toBe('x');
    expect(osc52Text(`pc;${base64('x')}`)).toBe('x');
  });

  it('refuses a request to read the clipboard back', () => {
    expect(osc52Text('c;?')).toBeNull();
  });

  it('ignores an empty or broken payload', () => {
    expect(osc52Text('c;')).toBeNull();
    expect(osc52Text('no separator')).toBeNull();
    expect(osc52Text('c;not base64!!')).toBeNull();
    // Valid base64, but not valid UTF-8.
    expect(osc52Text(`c;${btoa('\xff\xfe')}`)).toBeNull();
  });
});

/** The parser is the same one the app's xterm uses, so this is what a real program's bytes hit. */
describe('attachOsc52Clipboard', () => {
  const writeText = vi.fn(async () => undefined);
  let term: HeadlessTerminal;

  beforeEach(() => {
    writeText.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    term = new HeadlessTerminal({ allowProposedApi: true, cols: 40, rows: 4 });
    attachOsc52Clipboard(term as unknown as Terminal);
  });

  afterEach(() => {
    term.dispose();
    vi.unstubAllGlobals();
  });

  function write(data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve));
  }

  it('copies what a program sends and keeps the sequence off the screen', async () => {
    await write(`before\x1b]52;c;${base64('from claude')}\x07after`);
    expect(writeText).toHaveBeenCalledWith('from claude');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('beforeafter');
  });

  it('copies with the ST terminator as well as BEL', async () => {
    await write(`\x1b]52;c;${base64('st ends it')}\x1b\\`);
    expect(writeText).toHaveBeenCalledWith('st ends it');
  });

  it('never answers a read request', async () => {
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    await write('\x1b]52;c;?\x07');
    expect(writeText).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });
});
