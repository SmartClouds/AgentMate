import { agentReadyVerdict } from '@agentmat/core';

const PASTE_ON = '\x1b[?2004h';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** A window title change (a spinner in the tab name) is not drawing. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const TITLE_ONLY = /^(?:\x1b\][0-2];[^\x07\x1b]*(?:\x07|\x1b\\))+$/;
const POLL_MS = 100;
/** Gives the CLI a moment to take the paste in before Enter submits it. */
const SUBMIT_DELAY_MS = 150;

export interface DeliveryPorts {
  subscribe: (listener: (data: string) => void) => () => void;
  write: (data: string) => void;
}

/** The prompt as one bracketed paste, with its own paste markers taken out and newlines as CR. */
export function bracketedPaste(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r')
    .split(PASTE_START)
    .join('')
    .split(PASTE_END)
    .join('');
  return `${PASTE_START}${body}${PASTE_END}`;
}

/**
 * Pastes a prompt into a CLI that a Relay leg just started, once the CLI looks ready (see core
 * agentReady), and submits it, since nobody is there to press Enter. Resolves false when the CLI
 * never got there, so the caller can hand the prompt to the user instead.
 */
export function deliverWhenReady(text: string, ports: DeliveryPorts): Promise<boolean> {
  const now = Date.now;
  const startedAt = now();
  let pasteMode = false;
  let bytes = 0;
  let lastOutputAt = startedAt;

  return new Promise((resolve) => {
    const unsubscribe = ports.subscribe((data) => {
      const at = data.lastIndexOf(PASTE_ON);
      if (at !== -1) {
        pasteMode = true;
        bytes = data.length - at - PASTE_ON.length;
      } else if (pasteMode) {
        bytes += data.length;
      }
      if (!TITLE_ONLY.test(data)) lastOutputAt = now();
    });
    const timer = setInterval(() => {
      const at = now();
      const verdict = agentReadyVerdict({
        bytes,
        elapsedMs: at - startedAt,
        quietMs: at - lastOutputAt,
        bracketedPaste: pasteMode,
      });
      if (verdict === 'wait') return;
      clearInterval(timer);
      unsubscribe();
      if (verdict === 'timeout') {
        resolve(false);
        return;
      }
      ports.write(bracketedPaste(text));
      setTimeout(() => {
        ports.write('\r');
        resolve(true);
      }, SUBMIT_DELAY_MS);
    }, POLL_MS);
  });
}
