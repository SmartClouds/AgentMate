import type { AgentStatus } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSessionEntry, AutoContinuePendingMap } from '../../shared/apiTypes';
import { type AutoContinue, createAutoContinue, NETWORK_RETRY_DELAYS_MS } from './autoContinue';

/** A hand-driven clock and timer queue, so hours of waiting run instantly. */
function fakeClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

const START = Date.UTC(2026, 8, 19, 10, 0);
const ID = 'tab-1';

function entry(options: AgentSessionEntry['autoContinue']): AgentSessionEntry {
  return {
    sessionId: ID,
    projectId: 'p',
    cliId: 'claude-code',
    title: 'Claude',
    autoContinue: options,
  };
}

describe('createAutoContinue', () => {
  let clock: ReturnType<typeof fakeClock>;
  let writes: string[];
  let status: AgentStatus;
  let busy: boolean;
  let broadcasts: AutoContinuePendingMap[];
  let watcher: AutoContinue;

  beforeEach(() => {
    clock = fakeClock(START);
    writes = [];
    status = 'done';
    busy = false;
    broadcasts = [];
    watcher = createAutoContinue({
      write: (_id, data) => writes.push(data),
      statusOf: () => status,
      broadcast: (changes) => broadcasts.push(changes),
      setBusy: (next) => {
        busy = next;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  });

  it('sends continue once the usage limit has reset', () => {
    watcher.sync([entry({ afterLimitReset: true })]);
    watcher.output(ID, '\x1b[31m5-hour limit reached\x1b[0m ∙ resets 3pm (UTC)');
    const pending = watcher.list()[ID];
    expect(pending?.kind).toBe('limit');
    expect(pending?.fireAt).toBe(Date.UTC(2026, 8, 19, 15, 1, 30));
    expect(busy).toBe(true);

    clock.advance(5 * 60 * 60_000);
    expect(writes).toEqual([]);
    clock.advance(2 * 60_000);
    expect(writes).toEqual(['\x1b', 'continue', '\r']);
    expect(watcher.list()).toEqual({});
    expect(busy).toBe(false);
    expect(broadcasts.at(-1)).toEqual({ [ID]: null });
  });

  it('does nothing for a tab that did not opt in to that kind', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    watcher.output(ID, '5-hour limit reached ∙ resets 3pm (UTC)');
    expect(watcher.list()).toEqual({});

    watcher.sync([{ ...entry({ afterLimitReset: true }), cliId: undefined }]);
    watcher.output(ID, '5-hour limit reached ∙ resets 3pm (UTC)');
    expect(watcher.list()).toEqual({});
  });

  it('retries after a network error with a growing wait, then gives up', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    for (const delay of NETWORK_RETRY_DELAYS_MS) {
      watcher.output(ID, 'API Error: Connection error.');
      expect(watcher.list()[ID]?.fireAt).toBe(clock.now() + delay);
      clock.advance(delay + 1000);
    }
    expect(writes.filter((data) => data === 'continue')).toHaveLength(
      NETWORK_RETRY_DELAYS_MS.length,
    );
    watcher.output(ID, 'API Error: Connection error.');
    expect(watcher.list()).toEqual({});
  });

  it('skips the continue when the agent is working again by then', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    watcher.output(ID, 'API Error: Request timed out.');
    status = 'working';
    clock.advance(NETWORK_RETRY_DELAYS_MS[0] ?? 0);
    expect(writes).toEqual([]);
    expect(watcher.list()).toEqual({});
  });

  it('lets the user take over by submitting a line', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    watcher.output(ID, 'API Error: Connection error.');
    watcher.userInput(ID, 'k');
    expect(watcher.list()[ID]).toBeTruthy();
    watcher.userInput(ID, '\r');
    expect(watcher.list()).toEqual({});
  });

  it('ignores lines a resize repaints', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    watcher.resize(ID);
    watcher.output(ID, 'API Error: Connection error.');
    expect(watcher.list()).toEqual({});
    clock.advance(2000);
    watcher.output(ID, 'API Error: Connection error.');
    expect(watcher.list()[ID]).toBeTruthy();
  });

  it('finds a message split across chunks', () => {
    watcher.sync([entry({ afterLimitReset: true })]);
    watcher.output(ID, "You've hit your ");
    watcher.output(ID, 'limit · resets 3pm (UTC)');
    expect(watcher.list()[ID]?.kind).toBe('limit');
  });

  it('keeps a limit wait over a later network retry', () => {
    watcher.sync([entry({ afterLimitReset: true, afterNetworkError: true })]);
    watcher.output(ID, '5-hour limit reached ∙ resets 3pm (UTC)');
    watcher.output(ID, 'API Error: Connection error.');
    expect(watcher.list()[ID]?.kind).toBe('limit');
  });

  it('drops the scheduled continue when the option is turned off or the tab closes', () => {
    watcher.sync([entry({ afterLimitReset: true, afterNetworkError: true })]);
    watcher.output(ID, 'API Error: Connection error.');
    watcher.sync([entry({ afterLimitReset: true })]);
    expect(watcher.list()).toEqual({});

    watcher.output(ID, '5-hour limit reached ∙ resets 3pm (UTC)');
    watcher.sync([]);
    expect(watcher.list()).toEqual({});
    clock.advance(24 * 60 * 60_000);
    expect(writes).toEqual([]);
  });

  it('can cancel one scheduled continue and still catch the next', () => {
    watcher.sync([entry({ afterNetworkError: true })]);
    watcher.output(ID, 'API Error: Connection error.');
    watcher.cancel(ID);
    expect(watcher.list()).toEqual({});
    watcher.output(ID, 'API Error: Connection error.');
    expect(watcher.list()[ID]).toBeTruthy();
  });
});
