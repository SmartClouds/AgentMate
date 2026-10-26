import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerLogLine,
  ContainerStatsBatch,
  DockerEvent,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { CoreLinks } from './coreLinks';
import { COMMAND_NOT_RERUN, ContainerStatsFeed, DockerEventsFeed } from './dockerFeeds';
import { DockerLinks } from './dockerLinks';

/**
 * Docker's streams on a server's link: one stats stream and one events stream per server for
 * everyone, container logs and consoles counted against the core's limits, and each carrying on
 * from where it was when the connection changes (a log after its last line, events after their
 * cursor), except a console, which opens a new shell and says so.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function setup(roles: string[] = ['owner']) {
  const core = new FakeCore(() => Date.now());
  core.roles = roles;
  const hubs = fakeLiveHubs(core);
  const links = new CoreLinks({ open: async () => hubs.open() });
  const docker = new DockerLinks(links);
  return { core, hubs, links, docker };
}

function statsListener() {
  const batches: ContainerStatsBatch[] = [];
  const failures: string[] = [];
  return {
    batches,
    failures,
    listener: {
      batch: (batch: ContainerStatsBatch) => batches.push(batch),
      failed: (message: string) => failures.push(message),
    },
  };
}

function logListener() {
  const lines: ContainerLogLine[] = [];
  const ends: Array<{ error?: string }> = [];
  return {
    lines,
    ends,
    events: {
      lines: (batch: ContainerLogLine[]) => lines.push(...batch),
      ended: (end: { error?: string }) => ends.push(end),
    },
  };
}

function consoleListener() {
  const output: Array<{ data: string; restarted: boolean }> = [];
  const ends: Array<{ exitCode?: number; error?: string }> = [];
  return {
    output,
    ends,
    screen: () => output.map((item) => item.data).join(''),
    events: {
      output: (data: string, restarted: boolean) => output.push({ data, restarted }),
      ended: (end: { exitCode?: number; error?: string }) => ends.push(end),
    },
  };
}

describe('DockerLinks stats', () => {
  it('runs one stats stream per server and hands a late listener the last few minutes', async () => {
    const { core, hubs, docker } = setup();
    const first = statsListener();
    docker.watchStats('srv-1', first.listener);
    await settle();

    core.docker.stats();
    vi.setSystemTime(Date.now() + 2_000);
    core.docker.stats();
    expect(first.batches).toHaveLength(2);

    const late = statsListener();
    docker.watchStats('srv-1', late.listener);
    expect(late.batches.map((batch) => batch.atUnixMs)).toEqual(
      first.batches.map((batch) => batch.atUnixMs),
    );
    expect(hubs.latest()?.openStreams('container-stats')).toBe(1);
    expect(hubs.latest()?.requested.at(-1)?.args).toEqual([{ intervalMs: 2_000 }]);
    expect(first.batches[0].samples.map((sample) => sample.containerId)).toHaveLength(7);
    expect(first.batches[0].stopped).toHaveLength(1);
  });

  it('keeps the stream a few seconds after the last listener, then lets it go', async () => {
    const { core, hubs, docker } = setup();
    const one = statsListener();
    const stop = docker.watchStats('srv-1', one.listener);
    await settle();
    stop();
    stop();
    await settle(4_000);
    expect(hubs.latest()?.openStreams('container-stats')).toBe(1);

    // Coming back within the linger reuses the stream.
    const again = docker.watchStats('srv-1', statsListener().listener);
    await settle(10_000);
    expect(hubs.latest()?.openStreams('container-stats')).toBe(1);
    again();
    await settle(5_000);
    expect(hubs.latest()?.openStreams('container-stats')).toBe(0);
    core.docker.stats();
    expect(one.batches).toHaveLength(0);
  });

  it('opens the stream again when the core ends it, and drops a repeated batch', async () => {
    const { core, hubs, docker } = setup();
    const one = statsListener();
    docker.watchStats('srv-1', one.listener);
    await settle();
    const batch = core.docker.stats();
    hubs.latest()?.endStreams('container-stats');
    await settle(1_000);
    expect(hubs.latest()?.openStreams('container-stats')).toBe(1);

    hubs.latest()?.deliverContainerStats(batch);
    expect(one.batches).toHaveLength(1);
  });

  it('says when stats cannot be read and keeps trying until Docker is back', async () => {
    const { core, hubs, docker } = setup();
    core.docker.status = { ...core.docker.status, running: false };
    const one = statsListener();
    docker.watchStats('srv-1', one.listener);
    await settle();
    expect(one.failures).toEqual(['Docker is not running on this server.']);

    core.docker.status = { ...core.docker.status, running: true };
    await settle(10_000);
    expect(hubs.latest()?.openStreams('container-stats')).toBe(1);
    core.docker.stats();
    expect(one.batches).toHaveLength(1);
  });
});

describe('DockerLinks events', () => {
  it('shares one events stream and resumes after the last cursor when the connection changes', async () => {
    const { core, hubs, docker } = setup();
    const a: DockerEvent[] = [];
    const b: DockerEvent[] = [];
    docker.watchEvents('srv-1', (event) => a.push(event));
    docker.watchEvents('srv-1', (event) => b.push(event));
    await settle();
    expect(hubs.latest()?.openStreams('docker-events')).toBe(1);

    core.docker.event('start', 'toolbox');
    core.dropAll();
    core.docker.event('die', 'toolbox');
    await settle(5_000);

    expect(hubs.latest()?.requested.find((one) => one.kind === 'docker-events')?.args).toEqual([
      { afterCursor: '1' },
    ]);
    expect(a.map((event) => event.action)).toEqual(['start', 'die']);
    expect(b).toEqual(a);

    // The same event again (a replay that overlaps) is not passed on twice.
    hubs.latest()?.deliverDockerEvent(a[1]);
    expect(a).toHaveLength(2);
  });

  it('opens the events stream again when the core ends it', async () => {
    const { core, hubs, docker } = setup();
    const seen: string[] = [];
    docker.watchEvents('srv-1', (event) => seen.push(event.action));
    await settle();
    hubs.latest()?.endStreams('docker-events');
    await settle(1_000);
    core.docker.event('restart', 'toolbox');
    expect(seen).toEqual(['restart']);
    expect(hubs.latest()?.openStreams('docker-events')).toBe(1);
  });

  it('waits longer after a refusal than after a busy connection', () => {
    const feed = new DockerEventsFeed();
    expect(feed.failed(new Error('This connection already has 8 streams open.'))).toBe(5_000);
    expect(feed.failed(new Error('Docker is not running on this server.'))).toBe(10_000);
    const stats = new ContainerStatsFeed();
    expect(
      stats.failed(new Error('This connection already has 2 container-stats streams open.')),
    ).toBe(5_000);
  });
});

describe('DockerLinks logs', () => {
  it('starts with the tail, follows new lines, and carries on after a reconnect without repeats', async () => {
    const { core, hubs, docker } = setup();
    for (let n = 1; n <= 3; n += 1) {
      vi.setSystemTime(Date.now() + 1_000);
      core.docker.log('shop-api-1', `old ${n}`);
    }
    const log = logListener();
    docker.watchLogs('srv-1', { containerId: 'shop-api-1', tail: 2, follow: true }, log.events);
    await settle();
    expect(log.lines.map((line) => line.text)).toEqual(['old 2', 'old 3']);

    vi.setSystemTime(Date.now() + 1_000);
    core.docker.log('shop-api-1', 'new 1', 'stderr');
    core.dropAll();
    vi.setSystemTime(Date.now() + 1_000);
    core.docker.log('shop-api-1', 'new 2');
    await settle(5_000);

    expect(log.lines.map((line) => line.text)).toEqual(['old 2', 'old 3', 'new 1', 'new 2']);
    const resumed = hubs.latest()?.requested.find((one) => one.kind === 'container-logs');
    expect(resumed?.args[0]).toMatchObject({
      containerId: 'shop-api-1',
      follow: true,
      afterTimestamp: log.lines[2].timestamp,
    });
    expect(log.ends).toEqual([]);
  });

  it('ends a followed log when the container stops, and one that was not followed at once', async () => {
    const { links, docker } = setup();
    const followed = logListener();
    docker.watchLogs(
      'srv-1',
      { containerId: 'toolbox', follow: true, sinceUnixMs: 0 },
      followed.events,
    );
    const once = logListener();
    docker.watchLogs('srv-1', { containerId: 'toolbox', follow: false }, once.events);
    await settle();
    expect(once.ends).toEqual([{}]);

    await links.call('srv-1', (hub) => hub.stopContainer('toolbox', undefined));
    await settle();
    expect(followed.ends).toEqual([{}]);
    // Both gave their place back.
    for (let n = 0; n < 4; n += 1) {
      docker.watchLogs('srv-1', { containerId: 'toolbox', follow: false }, logListener().events);
    }
  });

  it('reports a log the core will not show', async () => {
    const { docker } = setup();
    const log = logListener();
    docker.watchLogs('srv-1', { containerId: 'ghost', follow: true }, log.events);
    await settle();
    expect(log.ends).toEqual([{ error: 'No such container: ghost' }]);
  });

  it('stops at four logs a server, and frees a place when one closes', async () => {
    const { docker } = setup();
    const stops = Array.from({ length: 4 }, () =>
      docker.watchLogs('srv-1', { containerId: 'shop-api-1', follow: true }, logListener().events),
    );
    expect(() =>
      docker.watchLogs('srv-1', { containerId: 'shop-api-1', follow: true }, logListener().events),
    ).toThrow(/Four container logs/);
    stops[0]();
    stops[0]();
    expect(() =>
      docker.watchLogs('srv-1', { containerId: 'shop-api-1', follow: true }, logListener().events),
    ).not.toThrow();
  });

  it('waits for a free stream when the connection has none left', async () => {
    const { core, hubs, links, docker } = setup();
    // Two metrics, two alerts, a stats and an events stream, and two more logs make eight.
    links.watchMetrics('srv-1', 2_000, () => undefined);
    links.watchMetrics('srv-1', 5_000, () => undefined);
    links.watchAlerts('srv-1', () => undefined);
    links.attachAlerts('srv-1', new (await import('./feeds')).AlertsFeed());
    docker.watchStats('srv-1', statsListener().listener);
    docker.watchEvents('srv-1', () => undefined);
    docker.watchLogs('srv-1', { containerId: 'shop-api-1', follow: true }, logListener().events);
    docker.watchLogs('srv-1', { containerId: 'shop-db-1', follow: true }, logListener().events);
    await settle();
    expect(hubs.latest()?.openStreams()).toBe(8);

    const waiting = logListener();
    docker.watchLogs('srv-1', { containerId: 'shop-web-1', follow: true }, waiting.events);
    await settle();
    expect(waiting.ends).toEqual([]);
    expect(hubs.latest()?.openStreams('container-logs')).toBe(2);

    // Once a place is free, the waiting log gets it.
    await links.call('srv-1', (hub) => hub.stopContainer('shop-db-1', undefined));
    await settle(5_000);
    expect(hubs.latest()?.openStreams('container-logs')).toBe(2);
    vi.setSystemTime(Date.now() + 1_000);
    core.docker.log('shop-web-1', 'GET / 200');
    expect(waiting.lines.map((line) => line.text)).toEqual(['GET / 200']);
  });
});

describe('DockerLinks consoles', () => {
  it('opens a shell, types into it, resizes it and ends when it exits', async () => {
    const { core, docker } = setup();
    const terminal = consoleListener();
    const handle = docker.openConsole(
      'srv-1',
      { containerId: 'shop-api-1', columns: 80, rows: 24 },
      terminal.events,
    );
    await settle();
    expect(terminal.screen()).toBe('root@shop-api-1:/# ');

    expect(handle.write('ls\r')).toBe(true);
    expect(handle.resize(120, 40)).toBe(true);
    expect(terminal.screen()).toContain('ran ls');
    expect(core.docker.consoles[0].sizes).toEqual([
      { columns: 80, rows: 24 },
      { columns: 120, rows: 40 },
    ]);

    handle.write('exit\r');
    await settle();
    expect(terminal.ends).toEqual([{ exitCode: 0 }]);
    expect(core.docker.consoles[0].open).toBe(false);
    expect(handle.write('ls\r')).toBe(false);
    expect(handle.resize(80, 24)).toBe(false);
  });

  it('opens a new shell at the last size when the connection changes, and marks it', async () => {
    const { core, hubs, docker } = setup();
    const terminal = consoleListener();
    const handle = docker.openConsole(
      'srv-1',
      { containerId: 'shop-api-1', columns: 80, rows: 24 },
      terminal.events,
    );
    await settle();
    handle.resize(100, 30);
    core.dropAll();
    await settle(5_000);

    expect(terminal.output.map((item) => item.restarted)).toEqual([false, true]);
    expect(hubs.latest()?.requested.find((one) => one.kind === 'console')?.args[0]).toMatchObject({
      containerId: 'shop-api-1',
      columns: 100,
      rows: 30,
    });
    expect(terminal.ends).toEqual([]);
  });

  it('does not run a chosen command again when the connection changes', async () => {
    const { core, hubs, docker } = setup();
    const terminal = consoleListener();
    docker.openConsole(
      'srv-1',
      {
        containerId: 'shop-api-1',
        columns: 80,
        rows: 24,
        command: ['/bin/sh', '-c', 'php artisan migrate'],
        user: 'root',
      },
      terminal.events,
    );
    await settle();
    expect(hubs.latest()?.requested.find((one) => one.kind === 'console')?.args[0]).toMatchObject({
      command: ['/bin/sh', '-c', 'php artisan migrate'],
      user: 'root',
    });
    core.dropAll();
    await settle(5_000);

    expect(hubs.latest()?.requested.some((one) => one.kind === 'console')).toBe(false);
    expect(core.docker.consoles).toHaveLength(1);
    expect(terminal.ends).toEqual([{ error: COMMAND_NOT_RERUN }]);
    // Its place is free again.
    expect(() =>
      [1, 2].map(() =>
        docker.openConsole(
          'srv-1',
          { containerId: 'toolbox', columns: 80, rows: 24 },
          consoleListener().events,
        ),
      ),
    ).not.toThrow();
  });

  it('ends the shell when closed, and frees its place', async () => {
    const { core, docker } = setup();
    const handles = [1, 2].map(() =>
      docker.openConsole(
        'srv-1',
        { containerId: 'toolbox', columns: 80, rows: 24 },
        consoleListener().events,
      ),
    );
    await settle();
    expect(() =>
      docker.openConsole(
        'srv-1',
        { containerId: 'toolbox', columns: 80, rows: 24 },
        consoleListener().events,
      ),
    ).toThrow(/Two consoles/);
    handles[0].close();
    handles[0].close();
    await settle();
    expect(core.docker.consoles.filter((session) => session.open)).toHaveLength(1);
    expect(() =>
      docker.openConsole(
        'srv-1',
        { containerId: 'toolbox', columns: 80, rows: 24 },
        consoleListener().events,
      ),
    ).not.toThrow();
  });

  it('reports a console the core refused', async () => {
    const { docker } = setup();
    const terminal = consoleListener();
    docker.openConsole(
      'srv-1',
      { containerId: 'migrate-once', columns: 80, rows: 24 },
      terminal.events,
    );
    await settle();
    expect(terminal.ends).toEqual([{ error: 'Container migrate-once is not running.' }]);
  });

  it('reports a shell that ended without saying how', async () => {
    const { hubs, docker } = setup();
    const terminal = consoleListener();
    docker.openConsole('srv-1', { containerId: 'toolbox', columns: 80, rows: 24 }, terminal.events);
    await settle();
    hubs.latest()?.endStreams('console');
    await settle();
    expect(terminal.ends).toEqual([{}]);
  });

  it('keeps the shared streams when the app quits, rather than timing them out', async () => {
    const { hubs, docker } = setup();
    const stop = docker.watchStats('srv-1', statsListener().listener);
    const stopEvents = docker.watchEvents('srv-1', () => undefined);
    await settle();
    stop();
    stopEvents();
    docker.closeAll();
    await settle(10_000);
    expect(hubs.latest()?.openStreams()).toBe(2);
  });
});
