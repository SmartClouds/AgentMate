import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerLogLine } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { containerStatsSample, logLine } from '../../../shared/deploy/testing/fakeDockerData';
import { IPC } from '../../../shared/ipcChannels';
import type { ConsoleFeedEvents, ContainerLogsFeedEvents, StatsListener } from './dockerFeeds';
import type { DockerLinks } from './dockerLinks';
import { DockerSubscriptions } from './dockerSubscriptions';
import type { SubscriptionOwner } from './subscriptions';

/**
 * The Containers screen's subscriptions belong to the window that made them: their events go
 * to that window only, stats and logs in batches, a console's screen within a few
 * milliseconds, and they all stop when the window goes away.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function owner(id: number) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const value: SubscriptionOwner = {
    id,
    send: (channel, payload) => sent.push({ channel, payload: payload as Record<string, unknown> }),
  };
  return { owner: value, sent };
}

function setup(options: { maxPerOwner?: number } = {}) {
  const stats: Array<{ listener: StatsListener; stop: ReturnType<typeof vi.fn> }> = [];
  const events: Array<{ listener: (event: unknown) => void; stop: ReturnType<typeof vi.fn> }> = [];
  const logs: Array<{ events: ContainerLogsFeedEvents; stop: ReturnType<typeof vi.fn> }> = [];
  const consoles: Array<{
    events: ConsoleFeedEvents;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const links = {
    watchStats: vi.fn((_serverId: string, listener: StatsListener) => {
      const entry = { listener, stop: vi.fn() };
      stats.push(entry);
      return entry.stop;
    }),
    watchEvents: vi.fn((_serverId: string, listener: (event: unknown) => void) => {
      const entry = { listener, stop: vi.fn() };
      events.push(entry);
      return entry.stop;
    }),
    watchLogs: vi.fn((_serverId: string, _options: unknown, handlers: ContainerLogsFeedEvents) => {
      const entry = { events: handlers, stop: vi.fn() };
      logs.push(entry);
      return entry.stop;
    }),
    openConsole: vi.fn((_serverId: string, _request: unknown, handlers: ConsoleFeedEvents) => {
      const entry = {
        events: handlers,
        write: vi.fn(() => true),
        resize: vi.fn(() => true),
        close: vi.fn(),
      };
      consoles.push(entry);
      return entry;
    }),
  };
  let next = 0;
  const subscriptions = new DockerSubscriptions({
    links: links as unknown as DockerLinks,
    newId: () => `sub-${++next}`,
    ...options,
  });
  return { links, stats, events, logs, consoles, subscriptions };
}

describe('DockerSubscriptions', () => {
  it('sends stats to the window that asked, in one message per burst, and says when they fail', async () => {
    const { subscriptions, stats } = setup();
    const main = owner(1);
    const id = subscriptions.watchStats(main.owner, 'srv-1');
    const batch = (at: number) => ({
      atUnixMs: at,
      samples: [containerStatsSample('c1', at)],
      stopped: [],
    });
    stats[0].listener.batch(batch(1));
    stats[0].listener.batch(batch(2));
    expect(main.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(main.sent).toEqual([
      {
        channel: IPC.deployDocker.onStats,
        payload: { subscriptionId: id, serverId: 'srv-1', batches: [batch(1), batch(2)] },
      },
    ]);

    stats[0].listener.batch(batch(3));
    stats[0].listener.failed?.('Docker is not running on this server.');
    expect(main.sent.slice(1).map((one) => one.payload)).toEqual([
      { subscriptionId: id, serverId: 'srv-1', batches: [batch(3)] },
      {
        subscriptionId: id,
        serverId: 'srv-1',
        batches: [],
        error: 'Docker is not running on this server.',
      },
    ]);
  });

  it('sends engine events in batches', async () => {
    const { subscriptions, events } = setup();
    const main = owner(1);
    const id = subscriptions.watchEvents(main.owner, 'srv-1');
    events[0].listener({ action: 'start' });
    events[0].listener({ action: 'die' });
    await vi.advanceTimersByTimeAsync(100);
    expect(main.sent).toEqual([
      {
        channel: IPC.deployDocker.onEvents,
        payload: {
          subscriptionId: id,
          serverId: 'srv-1',
          events: [{ action: 'start' }, { action: 'die' }],
        },
      },
    ]);
  });

  it('batches log lines and sends the end with whatever was left', async () => {
    const { subscriptions, logs, links } = setup();
    const main = owner(1);
    const id = subscriptions.watchLogs(main.owner, {
      serverId: 'srv-1',
      containerId: 'web',
      follow: true,
      tail: 10,
      sinceUnixMs: 5,
    });
    expect(links.watchLogs).toHaveBeenCalledWith(
      'srv-1',
      { containerId: 'web', follow: true, tail: 10, sinceUnixMs: 5 },
      expect.anything(),
    );
    const line = (text: string): ContainerLogLine => logLine(text, 1_700_000_000_000);
    logs[0].events.lines([line('a'), line('b')]);
    await vi.advanceTimersByTimeAsync(100);
    logs[0].events.lines([line('c')]);
    logs[0].events.ended({ error: 'The engine went away.' });

    expect(main.sent.map((one) => one.payload)).toEqual([
      { subscriptionId: id, serverId: 'srv-1', containerId: 'web', lines: [line('a'), line('b')] },
      {
        subscriptionId: id,
        serverId: 'srv-1',
        containerId: 'web',
        lines: [line('c')],
        ended: { error: 'The engine went away.' },
      },
    ]);
    // Over by itself, so there is nothing left to unwatch.
    expect(subscriptions.unwatch(main.owner, 'logs', id)).toBe(false);
  });

  it('keeps no entry for a log that ended before the call returned', () => {
    const { subscriptions, links } = setup();
    links.watchLogs.mockImplementationOnce((_serverId, _options, handlers) => {
      handlers.ended({});
      return vi.fn();
    });
    const main = owner(1);
    subscriptions.watchLogs(main.owner, { serverId: 'srv-1', containerId: 'web', follow: false });
    expect(subscriptions.count()).toBe(0);
    expect(main.sent.map((one) => one.payload.ended)).toEqual([{}]);
  });

  it('passes a console’s screen within milliseconds, a new shell on its own, then the end', async () => {
    const { subscriptions, consoles, links } = setup();
    const main = owner(1);
    const id = subscriptions.openConsole(main.owner, {
      serverId: 'srv-1',
      containerId: 'web',
      columns: 80,
      rows: 24,
      command: ['/bin/sh'],
      user: 'node',
    });
    expect(links.openConsole).toHaveBeenCalledWith(
      'srv-1',
      { containerId: 'web', columns: 80, rows: 24, command: ['/bin/sh'], user: 'node' },
      expect.anything(),
    );
    consoles[0].events.output('$ ', false);
    consoles[0].events.output('l', false);
    await vi.advanceTimersByTimeAsync(8);
    consoles[0].events.output('s', false);
    consoles[0].events.output('# ', true);
    await vi.advanceTimersByTimeAsync(8);
    consoles[0].events.ended({ exitCode: 0 });

    expect(main.sent.map((one) => one.payload)).toEqual([
      { subscriptionId: id, serverId: 'srv-1', data: '$ l' },
      { subscriptionId: id, serverId: 'srv-1', data: 's' },
      { subscriptionId: id, serverId: 'srv-1', data: '# ', restarted: true },
      { subscriptionId: id, serverId: 'srv-1', ended: { exitCode: 0 } },
    ]);
    expect(main.sent.every((one) => one.channel === IPC.deployDocker.onConsole)).toBe(true);
    expect(subscriptions.consoleInput(main.owner, id, 'x')).toBe(false);
  });

  it('types and resizes only in the window’s own console, and closes it on request', () => {
    const { subscriptions, consoles } = setup();
    const main = owner(1);
    const other = owner(2);
    const id = subscriptions.openConsole(main.owner, {
      serverId: 'srv-1',
      containerId: 'web',
      columns: 80,
      rows: 24,
    });
    expect(subscriptions.consoleInput(main.owner, id, 'ls\r')).toBe(true);
    expect(subscriptions.consoleResize(main.owner, id, 100, 30)).toBe(true);
    expect(subscriptions.consoleInput(other.owner, id, 'rm -rf /\r')).toBe(false);
    expect(subscriptions.consoleResize(other.owner, id, 1, 1)).toBe(false);
    expect(consoles[0].write).toHaveBeenCalledTimes(1);
    expect(consoles[0].resize).toHaveBeenCalledWith(100, 30);

    expect(subscriptions.unwatch(other.owner, 'console', id)).toBe(false);
    expect(subscriptions.unwatch(main.owner, 'logs', id)).toBe(false);
    expect(subscriptions.unwatch(main.owner, 'console', id)).toBe(true);
    expect(consoles[0].close).toHaveBeenCalled();
  });

  it('keeps no entry for a console refused before the call returned', () => {
    const { subscriptions, links } = setup();
    links.openConsole.mockImplementationOnce((_serverId, _request, handlers) => {
      handlers.ended({ error: 'Not running.' });
      return {
        events: handlers,
        write: vi.fn(() => true),
        resize: vi.fn(() => true),
        close: vi.fn(),
      };
    });
    const main = owner(1);
    subscriptions.openConsole(main.owner, {
      serverId: 'srv-1',
      containerId: 'web',
      columns: 80,
      rows: 24,
    });
    expect(subscriptions.count()).toBe(0);
  });

  it('ends everything a window had when it goes away, and nothing of another window', async () => {
    const { subscriptions, stats, events, logs, consoles } = setup();
    const main = owner(1);
    const other = owner(2);
    subscriptions.watchStats(main.owner, 'srv-1');
    subscriptions.watchEvents(main.owner, 'srv-1');
    subscriptions.watchLogs(main.owner, { serverId: 'srv-1', containerId: 'web', follow: true });
    subscriptions.openConsole(main.owner, {
      serverId: 'srv-1',
      containerId: 'web',
      columns: 80,
      rows: 24,
    });
    subscriptions.watchStats(other.owner, 'srv-1');
    stats[0].listener.batch({ atUnixMs: 1, samples: [], stopped: [] });
    consoles[0].events.output('$ ', false);

    subscriptions.dropOwner(1);
    await vi.advanceTimersByTimeAsync(200);

    expect(stats[0].stop).toHaveBeenCalled();
    expect(events[0].stop).toHaveBeenCalled();
    expect(logs[0].stop).toHaveBeenCalled();
    expect(consoles[0].close).toHaveBeenCalled();
    expect(stats[1].stop).not.toHaveBeenCalled();
    expect(main.sent).toEqual([]);
    expect(subscriptions.count(2)).toBe(1);
  });

  it('caps how many subscriptions one window may hold', () => {
    const { subscriptions } = setup({ maxPerOwner: 2 });
    const main = owner(1);
    subscriptions.watchStats(main.owner, 'srv-1');
    subscriptions.watchEvents(main.owner, 'srv-1');
    expect(() => subscriptions.watchStats(main.owner, 'srv-1')).toThrow(/Too many/);
  });

  it('makes its own ids by default', () => {
    const subscriptions = new DockerSubscriptions({
      links: { watchStats: () => () => undefined } as unknown as DockerLinks,
    });
    expect(subscriptions.watchStats(owner(1).owner, 'srv-1')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
