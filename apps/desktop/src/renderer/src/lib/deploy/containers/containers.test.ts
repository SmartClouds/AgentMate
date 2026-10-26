import type { Project } from '@runova/core';
import type { ContainerStatsSample } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeDocker } from '@shared/deploy/testing/fakeDocker';
import { containerStatsSample, logLine } from '@shared/deploy/testing/fakeDockerData';
import { describe, expect, it } from 'vitest';
import {
  allContainers,
  containerRows,
  isPublic,
  matches,
  portsText,
  portText,
  STATE_LABEL,
  stateTone,
  toggled,
} from './list';
import { appendLines, clockTime, findMatches, highlight, plain } from './logs';
import { composeName, linkKey, matchProject } from './projects';
import { cpuText, memoryShare, mergeStats, ratesOf } from './stats';

/** The Containers screen's own arithmetic: rows, live figures, the log and project links. */

const docker = new FakeDocker({ now: () => 0, openConnections: [] });
const list = docker.list();

describe('container rows', () => {
  it('puts a header before each project and sorts containers by name', () => {
    const rows = containerRows(list);
    expect(rows[0]).toMatchObject({ kind: 'group', project: 'monitoring', total: 2, running: 2 });
    const shop = rows.findIndex((row) => row.kind === 'group' && row.project === 'shop');
    expect(
      rows.slice(shop + 1, shop + 5).map((row) => row.kind === 'container' && row.container.name),
    ).toEqual(['shop-api-1', 'shop-db-1', 'shop-web-1', 'shop-worker-1']);
    const standalone = rows.find((row) => row.kind === 'group' && row.project === null);
    expect(standalone).toMatchObject({ total: 2, running: 1, shown: 2 });
  });

  it('folds a project to its header, and a search shows only the groups with matches', () => {
    const folded = containerRows(list, { folded: new Set(['project:shop']) });
    expect(folded.filter((row) => row.kind === 'container' && row.project === 'shop')).toHaveLength(
      0,
    );
    expect(folded.find((row) => row.key === 'project:shop')).toMatchObject({ folded: true });

    const found = containerRows(list, { query: 'postgres', folded: new Set(['project:shop']) });
    expect(found.map((row) => row.key)).toEqual(['project:shop', found[1].key]);
    expect(found[0]).toMatchObject({ shown: 1, folded: false });
    expect(containerRows(list, { query: 'nothing like it' })).toEqual([]);
  });

  it('matches by name, image, project, service, state and port', () => {
    const web = allContainers(list).find((c) => c.name === 'shop-web-1');
    if (!web) throw new Error('seed changed');
    for (const query of ['WEB', 'nginx', 'shop', 'running', '8080', '  ']) {
      expect(matches(web, query)).toBe(true);
    }
    expect(matches(web, 'grafana')).toBe(false);
    expect(allContainers(undefined)).toEqual([]);
  });

  it('folds and unfolds', () => {
    expect([...toggled(new Set(['a']), 'a')]).toEqual([]);
    expect([...toggled(new Set(), 'a')]).toEqual(['a']);
  });
});

describe('states and ports', () => {
  it('names every state and gives it a tone', () => {
    expect(STATE_LABEL.exited).toBe('Exited');
    expect(stateTone({ state: 'running', health: 'healthy' })).toBe('good');
    expect(stateTone({ state: 'running', health: 'unhealthy' })).toBe('bad');
    expect(stateTone({ state: 'restarting', health: 'none' })).toBe('busy');
    expect(stateTone({ state: 'removing', health: 'none' })).toBe('busy');
    expect(stateTone({ state: 'dead', health: 'none' })).toBe('bad');
    expect(stateTone({ state: 'exited', health: 'none' })).toBe('idle');
  });

  it('writes ports as Docker would, once per mapping, and knows the public ones', () => {
    expect(
      portText({ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 8080 }),
    ).toBe('127.0.0.1:8080 -> 80/tcp');
    expect(portText({ privatePort: 3000, protocol: 'tcp', hostIp: '::', hostPort: 3001 })).toBe(
      '[::]:3001 -> 3000/tcp',
    );
    expect(portText({ privatePort: 53, protocol: 'udp', hostPort: 53 })).toBe('53 -> 53/udp');
    expect(portText({ privatePort: 3000, protocol: 'tcp' })).toBe('3000/tcp');
    expect(
      portsText([
        { privatePort: 1, protocol: 'tcp' },
        { privatePort: 1, protocol: 'tcp' },
      ]),
    ).toEqual(['1/tcp']);
    expect(isPublic({ privatePort: 1, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 1 })).toBe(
      true,
    );
    expect(isPublic({ privatePort: 1, protocol: 'tcp', hostPort: 1 })).toBe(true);
    expect(isPublic({ privatePort: 1, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 1 })).toBe(
      false,
    );
    expect(isPublic({ privatePort: 1, protocol: 'tcp' })).toBe(false);
  });
});

describe('live figures', () => {
  const sample = (at: number, n: number, extra: Partial<ContainerStatsSample> = {}) =>
    containerStatsSample('c1', at, n, extra);

  it('adds samples in time order, keeps the newest and drops stopped containers', () => {
    let history = mergeStats(new Map(), []);
    history = mergeStats(
      history,
      [{ atUnixMs: 1, samples: [sample(1, 0), sample(1, 0)], stopped: [] }],
      2,
    );
    history = mergeStats(history, [{ atUnixMs: 2, samples: [sample(2, 1)], stopped: [] }], 2);
    history = mergeStats(
      history,
      [{ atUnixMs: 3, samples: [sample(3, 2), containerStatsSample('c2', 3)], stopped: [] }],
      2,
    );
    expect(history.get('c1')?.map((one) => one.atUnixMs)).toEqual([2, 3]);
    history = mergeStats(history, [{ atUnixMs: 4, samples: [], stopped: ['c1'] }]);
    expect([...history.keys()]).toEqual(['c2']);
  });

  it('turns running totals into rates, and a counter that went back into zero', () => {
    const rates = ratesOf([
      sample(0, 0),
      sample(2_000, 0, { networkReceivedBytes: 1_000_000 + 4_000, blockWrittenBytes: 0 }),
      sample(2_000, 0),
    ]);
    expect(rates.atUnixMs).toEqual([2_000]);
    expect(rates.receive).toEqual([2_000]);
    expect(rates.write).toEqual([0]);
    expect(ratesOf([])).toEqual({ atUnixMs: [], receive: [], transmit: [], read: [], write: [] });
  });

  it('writes processor use the way docker stats does', () => {
    expect(cpuText(0)).toBe('0%');
    expect(cpuText(Number.NaN)).toBe('0%');
    expect(cpuText(3.456)).toBe('3.5%');
    expect(cpuText(212.4)).toBe('212%');
    expect(memoryShare(sample(0, 0, { memoryUsedBytes: 50, memoryLimitBytes: 200 }))).toBe(25);
    expect(memoryShare(sample(0, 0, { memoryLimitBytes: 0 }))).toBe(0);
  });
});

describe('the log', () => {
  const at = 1_700_000_000_000;

  it('appends only lines after the last one kept, up to a limit', () => {
    const a = logLine('a', at);
    const b = logLine('b', at + 1);
    const c = logLine('c', at + 2);
    const first = appendLines([], [a, b]);
    expect(appendLines(first, [b])).toBe(first);
    expect(appendLines(first, [b, c], 2).map((line) => line.text)).toEqual(['b', 'c']);
  });

  it('finds and marks matches, ignoring case and colour codes', () => {
    const lines = [
      logLine('\u001b[31mERROR\u001b[0m boom', at),
      logLine('fine', at + 1),
      logLine('error again', at + 2),
    ];
    expect(plain(lines[0].text)).toBe('ERROR boom');
    expect(findMatches(lines, 'error')).toEqual([0, 2]);
    expect(findMatches(lines, ' ')).toEqual([]);
    expect(highlight('an Error and an error.', 'error')).toEqual([
      { text: 'an ', match: false },
      { text: 'Error', match: true },
      { text: ' and an ', match: false },
      { text: 'error', match: true },
      { text: '.', match: false },
    ]);
    expect(highlight('x', '')).toEqual([{ text: 'x', match: false }]);
    expect(clockTime(at)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('project links', () => {
  const project = (id: string, name: string, folderPath: string) =>
    ({ id, name, folderPath }) as Project;
  const projects = [
    project('p1', 'My Shop', 'C:\\code\\shop\\'),
    project('p2', 'Monitoring', '/srv/ops'),
    project('p3', 'Other', '/x/other'),
  ];

  it('finds the project by its folder, then its name, and prefers a hand-picked one', () => {
    expect(matchProject(projects, { composeProject: 'shop' })?.id).toBe('p1');
    expect(matchProject(projects, { composeProject: 'monitoring' })?.id).toBe('p2');
    expect(matchProject(projects, { composeProject: 'shop', linkedProjectId: 'p3' })?.id).toBe(
      'p3',
    );
    expect(matchProject(projects, { composeProject: 'shop', linkedProjectId: 'gone' })?.id).toBe(
      'p1',
    );
    expect(matchProject(projects, { composeProject: '!!!' })).toBeNull();
    expect(matchProject(projects, {})).toBeNull();
    expect(matchProject(projects, { composeProject: 'unknown' })).toBeNull();
  });

  it('names compose projects and links the way compose does', () => {
    expect(composeName('My Shop!')).toBe('myshop');
    expect(linkKey('srv', 'shop', 'shop-api-1')).toBe('srv:project:shop');
    expect(linkKey('srv', undefined, 'toolbox')).toBe('srv:container:toolbox');
  });
});
