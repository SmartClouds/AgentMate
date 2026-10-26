import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalBatch } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import type { DeployJournalEvent } from '../../../shared/deployAssistantTypes';
import { IPC } from '../../../shared/ipcChannels';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { JournalFeed, JournalSubscriptions } from './journal';

/**
 * A unit's journal in the logs center: the last lines to the window that asked, in batches, a
 * reopened stream that carries on from the last line's time without repeating it, an end with the
 * core's reason, and at most two per server.
 */

let links: CoreLinks | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  links?.closeAll();
  links = null;
  vi.useRealTimers();
});

function setup(roles = ['admin']) {
  const core = new FakeCore(() => Date.now());
  core.roles = roles;
  core.assistant.journal.set('nginx.service', [
    { atUnixMs: 1_000, priority: 6, text: 'started' },
    { atUnixMs: 2_000, priority: 3, text: 'failed to bind' },
  ]);
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  let n = 0;
  const journals = new JournalSubscriptions({ links, newId: () => `j-${++n}` });
  const events: DeployJournalEvent[] = [];
  const owner = {
    id: 1,
    send: vi.fn((channel: string, payload: unknown) => {
      expect(channel).toBe(IPC.deployLogs.onJournal);
      events.push(payload as DeployJournalEvent);
    }),
  };
  return { core, hubs, journals, events, owner };
}

describe('JournalSubscriptions', () => {
  it('sends the last lines in one batch and ends a journal read once', async () => {
    const { journals, events, owner } = setup();
    const id = journals.watch(owner, {
      serverId: 'srv-1',
      unit: 'nginx.service',
      lines: 50,
      follow: false,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(id).toBe('j-1');
    expect(events.flatMap((event) => event.lines.map((line) => line.text))).toEqual([
      'started',
      'failed to bind',
    ]);
    expect(events.at(-1)?.ended).toEqual({});
    expect(journals.count()).toBe(0);
  });

  it('ends with the core’s reason when it refuses, and allows two per server', async () => {
    const { journals, events, owner } = setup(['operator']);
    journals.watch(owner, { serverId: 'srv-1', unit: 'nginx', follow: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)?.ended?.error).toMatch(/unauthorized/);

    const admin = setup();
    admin.journals.watch(admin.owner, { serverId: 'srv-1', unit: 'a', follow: true });
    admin.journals.watch(admin.owner, { serverId: 'srv-1', unit: 'b', follow: true });
    expect(() =>
      admin.journals.watch(admin.owner, { serverId: 'srv-1', unit: 'c', follow: true }),
    ).toThrow('Two journals are already open');
    expect(admin.journals.unwatch({ id: 2, send: vi.fn() }, 'j-1')).toBe(false);
    expect(admin.journals.unwatch(admin.owner, 'j-1')).toBe(true);
    admin.journals.dropOwner(1);
    expect(admin.journals.count()).toBe(0);
  });
});

describe('JournalSubscriptions, followed', () => {
  it('batches a followed journal and drops a pending batch when it stops', async () => {
    const { journals, events, owner } = setup();
    const id = journals.watch(owner, { serverId: 'srv-1', unit: 'nginx.service', follow: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.ended).toBeUndefined();
    expect(events[0]?.lines).toHaveLength(2);
    expect(journals.unwatch(owner, id)).toBe(true);
    expect(journals.unwatch(owner, id)).toBe(false);
    expect(new JournalSubscriptions({ links: links as CoreLinks }).count()).toBe(0);
  });
});

describe('JournalFeed', () => {
  it('reopens from the last line’s time and skips what it already showed', () => {
    const lines = vi.fn();
    const ended = vi.fn();
    const feed = new JournalFeed(
      { serverId: 's', unit: 'docker', lines: 100, sinceUnixMs: 5, follow: true },
      { lines, ended },
    );
    const opened: unknown[] = [];
    const hub = {
      streamJournal: (request: unknown) => {
        opened.push(request);
        return {} as never;
      },
    } as never;

    feed.open(hub);
    feed.next({ lines: [{ atUnixMs: 10, priority: 6, text: 'a' }] } satisfies JournalBatch);
    expect(feed.ended()).toBe(1_000);
    feed.open(hub);
    feed.next({
      lines: [
        { atUnixMs: 10, priority: 6, text: 'a' },
        { atUnixMs: 11, priority: 6, text: 'b' },
      ],
    });
    feed.next({ lines: [] });

    expect(opened).toEqual([
      { unit: 'docker', follow: true, lines: 100, sinceUnixMs: 5 },
      { unit: 'docker', follow: true, sinceUnixMs: 10, lines: 2_000 },
    ]);
    expect(lines.mock.calls.map(([batch]) => batch.map((l: { text: string }) => l.text))).toEqual([
      ['a'],
      ['b'],
    ]);
    expect(feed.failed(new Error('This connection already has 2 journal streams open.'))).toBe(
      5_000,
    );
    expect(feed.failed(new Error('HubException: gone'))).toBeNull();
    expect(ended).toHaveBeenCalledWith({ error: 'gone' });
  });
});

describe('JournalFeed, read once', () => {
  it('asks for the defaults and ends when the core ends the stream', () => {
    const ended = vi.fn();
    const feed = new JournalFeed(
      { serverId: 's', unit: 'ssh', follow: false },
      { lines: vi.fn(), ended },
    );
    const opened: unknown[] = [];
    feed.open({
      streamJournal: (request: unknown) => {
        opened.push(request);
        return {} as never;
      },
    } as never);
    expect(opened).toEqual([{ unit: 'ssh', follow: false }]);
    expect(feed.ended()).toBeNull();
    expect(ended).toHaveBeenCalledWith({});
  });
});
