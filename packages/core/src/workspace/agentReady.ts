/**
 * Tells when an agent CLI that a tab just started is ready to be typed into.
 *
 * There is no signal for this: a CLI does not announce that its input box is on screen. What it
 * does do is paint a screenful of its own UI, turn on bracketed paste (every agent CLI does, it
 * is how they take a pasted block as one piece), and then stop drawing while it waits. Those
 * three together are a good stand-in, and the minimum wait keeps the shell's own echo of the
 * launch command from passing for the CLI on a slow start.
 *
 * The output only counts from the moment bracketed paste went on, not from the launch. Claude
 * Code turns it on about a second in, then goes silent for a few seconds while it loads, and
 * only then resets the mode and draws its input box. Counting from the launch, the shell's
 * banner and echo filled the byte quota, the silence looked like a finished screen, and the
 * prompt was pasted into a CLI that was not reading yet and lost.
 *
 * Bracketed paste is the one signal that cannot be dropped: without it every newline in a pasted
 * prompt is a submitted line, which at a shell prompt means running the prompt as commands. So a
 * CLI that never gets there times out and the prompt goes back to the caller undelivered.
 *
 * Pure and clock-free, so the caller can poll it from wherever it already tracks output.
 */

export interface AgentReadySignals {
  /** Output since the program last turned bracketed paste on, in bytes. */
  bytes: number;
  /** How long ago the launch command was sent. */
  elapsedMs: number;
  /** How long the terminal has been quiet. Window title changes (a spinner) don't count. */
  quietMs: number;
  /** The program has turned on bracketed paste, so a whole prompt can go in as one paste. */
  bracketedPaste: boolean;
}

export const AGENT_READY_TIMING = {
  /**
   * Enough drawing after paste mode went on to be the CLI's screen. Claude Code and Codex both
   * draw 800 bytes or more even in a narrow pane; the few control codes around the mode switch
   * stay well under this.
   */
  minBytes: 384,
  /** Nothing counts as ready before this, however quiet it looks. */
  minElapsedMs: 1200,
  /** Silence this long means the CLI has finished drawing and is waiting on the user. */
  quietMs: 700,
  /** A CLI that never gets there (not installed, a question at the shell) stops being waited on. */
  timeoutMs: 45_000,
} as const;

export type AgentReadyVerdict = 'wait' | 'ready' | 'timeout';

export function agentReadyVerdict(signals: AgentReadySignals): AgentReadyVerdict {
  const t = AGENT_READY_TIMING;
  if (
    signals.bracketedPaste &&
    signals.elapsedMs >= t.minElapsedMs &&
    signals.bytes >= t.minBytes &&
    signals.quietMs >= t.quietMs
  ) {
    return 'ready';
  }
  return signals.elapsedMs >= t.timeoutMs ? 'timeout' : 'wait';
}
