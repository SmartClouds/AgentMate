import type { IDisposable, Terminal } from '@xterm/xterm';

/** OSC 52 is how a program puts text on the terminal's clipboard. */
export const OSC52_IDENT = 52;

/**
 * The text an OSC 52 payload (`<targets>;<base64>`) asks to copy, or null when there is nothing
 * to copy. A `?` asks to read the clipboard back, which is refused: any program (or any file it
 * prints) could otherwise lift whatever the user copied last.
 */
export function osc52Text(payload: string): string | null {
  const split = payload.indexOf(';');
  if (split === -1) return null;
  const data = payload.slice(split + 1);
  if (data === '' || data === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Puts text a program copies on the system clipboard. Claude Code's full-screen mode copies its
 * own selection this way (alongside pbcopy on a Mac), and over SSH it is the only way a remote
 * program can reach this computer's clipboard. xterm drops the sequence unless someone handles it.
 */
export function attachOsc52Clipboard(term: Terminal): IDisposable {
  return term.parser.registerOscHandler(OSC52_IDENT, (payload) => {
    const text = osc52Text(payload);
    if (text !== null) void navigator.clipboard.writeText(text).catch(() => undefined);
    return true;
  });
}
