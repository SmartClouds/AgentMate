import { AGENT_READY_TIMING } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bracketedPaste, deliverWhenReady } from './delivery';

/** Pasting a leg's prompt into a CLI started without a tab on screen. */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function ports() {
  let listener: ((data: string) => void) | null = null;
  const writes: string[] = [];
  return {
    writes,
    emit: (data: string) => listener?.(data),
    ports: {
      subscribe: (next: (data: string) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      write: (data: string) => writes.push(data),
    },
  };
}

describe('bracketedPaste', () => {
  it('wraps the prompt and turns newlines into carriage returns', () => {
    expect(bracketedPaste('a\r\nb\nc\x1b[201~d')).toBe('\x1b[200~a\rb\rcd\x1b[201~');
  });
});

describe('deliverWhenReady', () => {
  it('pastes once the CLI has drawn its screen in paste mode and gone quiet, then submits', async () => {
    const io = ports();
    const delivered = deliverWhenReady('Run T001', io.ports);
    io.emit('PS C:\\> codex\r\n');
    await vi.advanceTimersByTimeAsync(500);
    io.emit(`\x1b[?2004h${'x'.repeat(AGENT_READY_TIMING.minBytes)}`);
    await vi.advanceTimersByTimeAsync(400);
    expect(io.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(AGENT_READY_TIMING.quietMs + 500);
    expect(io.writes[0]).toBe('\x1b[200~Run T001\x1b[201~');
    await vi.advanceTimersByTimeAsync(200);
    expect(io.writes).toEqual(['\x1b[200~Run T001\x1b[201~', '\r']);
    expect(await delivered).toBe(true);
  });

  it('gives up on a CLI that never turns on bracketed paste', async () => {
    const io = ports();
    const delivered = deliverWhenReady('Run T001', io.ports);
    io.emit('codex: command not found\r\n');
    await vi.advanceTimersByTimeAsync(AGENT_READY_TIMING.timeoutMs + 200);
    expect(await delivered).toBe(false);
    expect(io.writes).toEqual([]);
  });
});
