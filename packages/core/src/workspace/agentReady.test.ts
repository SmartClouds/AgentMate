import { describe, expect, it } from 'vitest';
import { AGENT_READY_TIMING, type AgentReadySignals, agentReadyVerdict } from './agentReady.js';

const t = AGENT_READY_TIMING;

/** A CLI that has drawn its screen and gone quiet: every signal is satisfied. */
function ready(patch: Partial<AgentReadySignals> = {}): AgentReadySignals {
  return {
    bytes: t.minBytes,
    elapsedMs: t.minElapsedMs,
    quietMs: t.quietMs,
    bracketedPaste: true,
    ...patch,
  };
}

describe('agentReadyVerdict', () => {
  it('is ready once every signal is in', () => {
    expect(agentReadyVerdict(ready())).toBe('ready');
  });

  it('never calls a CLI ready before bracketed paste is on', () => {
    // Without it, each newline of a pasted prompt is a submitted line, which at a shell
    // prompt means running the prompt as commands. This is the one signal that cannot slip.
    expect(agentReadyVerdict(ready({ bracketedPaste: false }))).toBe('wait');
    expect(
      agentReadyVerdict(ready({ bracketedPaste: false, bytes: 100_000, quietMs: 30_000 })),
    ).toBe('wait');
  });

  it('waits out the minimum even when the terminal already looks finished', () => {
    // A slow start lets the shell is own echo of the launch command pass for the CLI.
    expect(agentReadyVerdict(ready({ elapsedMs: t.minElapsedMs - 1 }))).toBe('wait');
  });

  it('waits while too little has been drawn since paste mode went on', () => {
    expect(agentReadyVerdict(ready({ bytes: t.minBytes - 1 }))).toBe('wait');
  });

  it('waits while output is still arriving', () => {
    expect(agentReadyVerdict(ready({ quietMs: t.quietMs - 1 }))).toBe('wait');
  });

  it('gives up on a CLI that never gets there', () => {
    expect(agentReadyVerdict(ready({ bracketedPaste: false, elapsedMs: t.timeoutMs }))).toBe(
      'timeout',
    );
    expect(agentReadyVerdict(ready({ bytes: 0, elapsedMs: t.timeoutMs + 1 }))).toBe('timeout');
  });

  it('prefers ready over timeout when the last poll satisfies both', () => {
    expect(agentReadyVerdict(ready({ elapsedMs: t.timeoutMs + 1 }))).toBe('ready');
  });
});
