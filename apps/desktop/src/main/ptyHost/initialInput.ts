/**
 * Types a new tab's first command into its shell.
 *
 * Input that reaches a POSIX terminal before the shell's line editor is up lands while the
 * terminal is still in canonical mode, where one line holds at most MAX_CANON bytes: 1024 on
 * macOS, 4096 on Linux. The rest is dropped, Enter included. A relay leg's command carries its
 * whole prompt, so on a Mac it sat there half typed and never ran.
 *
 * So a line that long waits for the shell's first prompt marker (see shellIntegration.ts), and a
 * moment more for the line editor to put the terminal in raw mode, where a long write is held
 * until the shell reads it instead of being cut off. A shell that never sends the marker gets the
 * line after a while anyway, the way it always did.
 */

const PROMPT_READY = '\x1b]7750;AgentMate:PromptReady:1';

/** A little under macOS's MAX_CANON of 1024, which counts the end of the line too. */
export const CANONICAL_LINE_LIMIT = 1000;

export interface InitialInputTiming {
  /** From the prompt marker to the write, for the line editor to take the terminal. */
  settleMs: number;
  /** How long to wait for a marker that may never come. */
  fallbackMs: number;
}

const DEFAULT_TIMING: InitialInputTiming = { settleMs: 100, fallbackMs: 10_000 };

export interface InitialInput {
  /** Gets everything the shell prints, to spot its first prompt. */
  onOutput(data: string): void;
  dispose(): void;
}

/** Whether `input` has a line the terminal could cut short before the shell is up. */
export function needsPrompt(input: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false;
  return input
    .split(/[\r\n]/)
    .some((line) => Buffer.byteLength(line, 'utf8') > CANONICAL_LINE_LIMIT);
}

export function sendInitialInput(
  input: string,
  write: (data: string) => void,
  platform: NodeJS.Platform = process.platform,
  timing: InitialInputTiming = DEFAULT_TIMING,
): InitialInput {
  if (!needsPrompt(input, platform)) {
    write(input);
    return { onOutput: () => undefined, dispose: () => undefined };
  }
  let pending = true;
  let prompted = false;
  // The marker can arrive split across two chunks, so the end of the last one is kept.
  let tail = '';
  const send = (): void => {
    if (!pending) return;
    pending = false;
    clearTimeout(timer);
    write(input);
  };
  let timer = setTimeout(send, timing.fallbackMs);
  return {
    onOutput(data) {
      if (!pending || prompted) return;
      const seen = tail + data;
      if (seen.includes(PROMPT_READY)) {
        prompted = true;
        clearTimeout(timer);
        timer = setTimeout(send, timing.settleMs);
        return;
      }
      tail = seen.slice(-PROMPT_READY.length);
    },
    dispose() {
      pending = false;
      clearTimeout(timer);
    },
  };
}
