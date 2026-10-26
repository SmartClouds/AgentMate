import { beforeEach, describe, expect, it } from 'vitest';
import { useDevServerStore } from '@/stores/devServerStore';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { startDevServerFeed } from './devServerFeed';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge();
  useDevServerStore.getState().reset();
});

describe('startDevServerFeed', () => {
  it('notes dev servers printed by any terminal and forgets them when it exits', () => {
    const stop = startDevServerFeed();
    bridge.$emit('terminal.onData', { sessionId: 't1', data: 'Local: http://localhost:5173/\n' });
    expect(useDevServerStore.getState().servers.t1).toEqual(['http://localhost:5173/']);
    bridge.$emit('terminal.onExit', { sessionId: 't1', exitCode: 0 });
    expect(useDevServerStore.getState().servers.t1).toBeUndefined();
    stop();
    expect(bridge.$listenerCount('terminal.onData')).toBe(0);
    expect(bridge.$listenerCount('terminal.onExit')).toBe(0);
  });

  it('subscribes once however often it is started', () => {
    const stop = startDevServerFeed();
    const again = startDevServerFeed();
    expect(bridge.$listenerCount('terminal.onData')).toBe(1);
    again();
    expect(bridge.$listenerCount('terminal.onData')).toBe(1);
    stop();
    expect(bridge.$listenerCount('terminal.onData')).toBe(0);
  });
});
