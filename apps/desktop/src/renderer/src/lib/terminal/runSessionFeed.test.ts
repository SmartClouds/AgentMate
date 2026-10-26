import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRunSessionStore } from '@/stores/runSessionStore';
import { type TerminalSessionMeta, useTerminalStore } from '@/stores/terminalStore';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { startRunSessionFeed } from './runSessionFeed';

/**
 * The feed reads only project runs' output, from wherever it arrives, and forgets a run once its
 * tab is gone. It is started once by the shell, but a second start must not double up.
 */

let bridge: FakeBridge;
const stops: (() => void)[] = [];

const RUN = { commandId: 'dev', label: 'Dev', command: 'pnpm dev', kind: 'web', startedAt: 1 };

function sessions(list: TerminalSessionMeta[]): void {
  useTerminalStore.setState({ sessions: list });
}

function start(): () => void {
  const stop = startRunSessionFeed();
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  bridge = installRunovaBridge();
  useRunSessionStore.setState({ outputs: {} });
  sessions([
    { id: 'dev', title: 'Apollo', run: RUN as TerminalSessionMeta['run'] },
    { id: 'shell', title: 'PowerShell' },
  ]);
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('startRunSessionFeed', () => {
  it("keeps what a run prints and skips every other terminal's output", () => {
    start();

    bridge.$emit('terminal.onData', { sessionId: 'dev', data: 'http://localhost:5173/\n' });
    bridge.$emit('terminal.onData', { sessionId: 'shell', data: 'http://localhost:9999/\n' });

    expect(useRunSessionStore.getState().outputs).toEqual({
      dev: { urls: ['http://localhost:5173/'], devices: [] },
    });
  });

  it('follows a run opened after the feed started', () => {
    start();
    sessions([
      ...useTerminalStore.getState().sessions,
      { id: 'later', title: 'Zeus', run: RUN as TerminalSessionMeta['run'] },
    ]);

    bridge.$emit('terminal.onData', { sessionId: 'later', data: 'http://localhost:8000/\n' });

    expect(useRunSessionStore.getState().outputs.later?.urls).toEqual(['http://localhost:8000/']);
  });

  it("forgets a run's output once its tab is closed", () => {
    start();
    bridge.$emit('terminal.onData', { sessionId: 'dev', data: 'http://localhost:5173/\n' });

    sessions([{ id: 'shell', title: 'PowerShell' }]);

    expect(useRunSessionStore.getState().outputs).toEqual({});
  });

  it('subscribes once however often it is started, and stops with the last user', () => {
    const first = start();
    const second = start();
    expect(bridge.$listenerCount('terminal.onData')).toBe(1);

    first();
    // Stopping twice is harmless and must not take the other user's feed down.
    first();
    expect(bridge.$listenerCount('terminal.onData')).toBe(1);

    second();
    expect(bridge.$listenerCount('terminal.onData')).toBe(0);
  });
});
