import type {
  ContainerSummary,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  type CleanupItem,
  canRemove,
  cleanupCandidates,
  filterItems,
  runCleanup,
  selectionSummary,
} from './candidates';

/**
 * What a server's Cleanup section offers to remove: only what nothing uses, filtered by kind, age
 * and name, and removed in an order where each step frees the next.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MB = 1024 * 1024;

function image(id: string, extra: Partial<ImageInfo> = {}): ImageInfo {
  return {
    id: `sha256:${id.padEnd(64, '0')}`,
    tags: [`${id}:1`],
    digests: [],
    createdAtUnixMs: NOW - 40 * DAY,
    sizeBytes: 100 * MB,
    containers: 0,
    ...extra,
  };
}

function container(name: string, extra: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: `${name}-id`.padEnd(64, '0'),
    name,
    image: 'nginx:1.29',
    imageId: 'sha256:nginx',
    state: 'exited',
    status: 'Exited (0) 3 weeks ago',
    health: 'none',
    createdAtUnixMs: NOW - 20 * DAY,
    ports: [],
    ...extra,
  };
}

function volume(name: string, extra: Partial<VolumeInfo> = {}): VolumeInfo {
  return {
    name,
    driver: 'local',
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    containers: 0,
    createdAtUnixMs: NOW - 100 * DAY,
    sizeBytes: 10 * MB,
    ...extra,
  };
}

function network(name: string, extra: Partial<NetworkInfo> = {}): NetworkInfo {
  return {
    id: `${name}-id`,
    name,
    driver: 'bridge',
    scope: 'local',
    internal: false,
    builtIn: false,
    subnets: [],
    containers: 0,
    ...extra,
  };
}

const SOURCES = {
  images: [
    image('used', { containers: 2 }),
    image('small', { sizeBytes: 5 * MB }),
    image('big', { sizeBytes: 900 * MB, createdAtUnixMs: NOW - 2 * DAY }),
    image('dangle', { tags: [], sizeBytes: 50 * MB }),
  ],
  containers: [
    container('web', { state: 'running', status: 'Up 2 days' }),
    container('paused', { state: 'paused' }),
    container('restarting', { state: 'restarting' }),
    container('old-job', { composeProject: 'shop' }),
    container('dead-one', { state: 'dead' }),
    container('never-ran', { state: 'created', createdAtUnixMs: NOW - DAY }),
  ],
  volumes: [volume('shop_data', { containers: 1 }), volume('old-cache')],
  networks: [
    network('bridge', { builtIn: true }),
    network('shop_default', { containers: 3 }),
    network('old_default', { composeProject: 'old' }),
  ],
};

function keys(items: CleanupItem[]): string[] {
  return items.map((item) => item.name);
}

describe('cleanupCandidates', () => {
  const items = cleanupCandidates(SOURCES);

  it('offers images no container uses, the biggest first, and names an untagged one by its id', () => {
    const images = items.filter((item) => item.kind === 'image');
    expect(keys(images)).toEqual(['big:1', 'dangle000000', 'small:1']);
    expect(images[1]).toMatchObject({ dangling: true, name: 'dangle000000', sizeBytes: 50 * MB });
    expect(images.some((item) => item.name === 'used:1')).toBe(false);
  });

  it('offers containers that are not running, paused or restarting', () => {
    const containers = items.filter((item) => item.kind === 'container');
    expect(keys(containers).sort()).toEqual(['dead-one', 'never-ran', 'old-job']);
    expect(containers.find((item) => item.name === 'old-job')).toMatchObject({
      project: 'shop',
      detail: 'Exited (0) 3 weeks ago',
    });
  });

  it('offers volumes and networks nothing is attached to, never a built-in network', () => {
    expect(keys(items.filter((item) => item.kind === 'volume'))).toEqual(['old-cache']);
    expect(keys(items.filter((item) => item.kind === 'network'))).toEqual(['old_default']);
  });

  it('gives every item a key that is unique across kinds', () => {
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(items.find((item) => item.name === 'old-cache')?.key).toBe('volume:old-cache');
  });

  it('copes with lists that have not arrived', () => {
    expect(cleanupCandidates({})).toEqual([]);
  });
});

describe('filterItems', () => {
  const items = cleanupCandidates(SOURCES);

  it('keeps one kind', () => {
    const only = filterItems(items, { kind: 'volume', age: 'any', query: '' }, NOW);
    expect(keys(only)).toEqual(['old-cache']);
  });

  it('keeps what is older than the chosen age, and drops what has no date', () => {
    const month = filterItems(items, { kind: 'all', age: '30d', query: '' }, NOW);
    expect(keys(month).sort()).toEqual(['dangle000000', 'old-cache', 'small:1']);
    const week = filterItems(items, { kind: 'all', age: '7d', query: '' }, NOW);
    expect(keys(week)).toContain('old-job');
    expect(keys(week)).not.toContain('never-ran');
    expect(keys(week)).not.toContain('old_default');
  });

  it('matches the name, the image and the project, ignoring case', () => {
    expect(keys(filterItems(items, { kind: 'all', age: 'any', query: 'SHOP' }, NOW))).toEqual([
      'old-job',
    ]);
    expect(keys(filterItems(items, { kind: 'all', age: 'any', query: ' big ' }, NOW))).toEqual([
      'big:1',
    ]);
  });
});

describe('selectionSummary', () => {
  it('counts what is ticked, adds up the known sizes and notes volumes', () => {
    const items = cleanupCandidates(SOURCES);
    const big = items.find((item) => item.name === 'big:1');
    const picked = new Set([big?.key ?? '', 'volume:old-cache', 'container:missing']);
    const summary = selectionSummary(items, picked);
    expect(summary).toEqual({ count: 2, bytes: 900 * MB + 10 * MB, hasVolumes: true });
    expect(selectionSummary(items, new Set())).toEqual({ count: 0, bytes: 0, hasVolumes: false });
  });
});

describe('canRemove', () => {
  it('lets an Operator remove all but volumes, which are for Admins', () => {
    const operator = { canOperate: true, canAdmin: false };
    expect(canRemove('image', operator)).toBe(true);
    expect(canRemove('container', operator)).toBe(true);
    expect(canRemove('network', operator)).toBe(true);
    expect(canRemove('volume', operator)).toBe(false);
    expect(canRemove('volume', { canOperate: true, canAdmin: true })).toBe(true);
    expect(canRemove('image', { canOperate: false, canAdmin: false })).toBe(false);
  });
});

describe('runCleanup', () => {
  function api(fail: Record<string, string> = {}) {
    const calls: string[] = [];
    const step = (kind: string) => async (id: string) => {
      calls.push(`${kind} ${id}`);
      if (fail[id]) throw new Error(fail[id]);
    };
    return {
      calls,
      api: {
        removeContainer: step('container'),
        removeImage: step('image'),
        removeNetwork: step('network'),
        removeVolume: step('volume'),
      },
    };
  }

  const items = cleanupCandidates(SOURCES);
  const pick = (...names: string[]) => items.filter((item) => names.includes(item.name));

  it('removes containers first, then images, networks and volumes, one at a time', async () => {
    const { calls, api: remote } = api();
    const steps = vi.fn();
    const outcome = await runCleanup(
      pick('old-cache', 'big:1', 'old_default', 'old-job'),
      remote,
      steps,
    );
    expect(calls.map((call) => call.split(' ')[0])).toEqual([
      'container',
      'image',
      'network',
      'volume',
    ]);
    expect(calls[0]).toBe(`container ${SOURCES.containers[3].id}`);
    expect(calls[3]).toBe('volume old-cache');
    expect(outcome.removed).toHaveLength(4);
    expect(outcome.failed).toEqual([]);
    expect(outcome.freedBytes).toBe(900 * MB + 10 * MB);
    expect(steps).toHaveBeenCalledWith(expect.objectContaining({ state: 'removing', done: 0 }));
    expect(steps).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'removed', done: 4, total: 4 }),
    );
  });

  it('carries on past a refusal and reports it in the core’s words', async () => {
    const big = pick('big:1')[0];
    const { calls, api: remote } = api({
      [big.id]:
        "Error invoking remote method 'deployDocker:removeImage': Error: image is being used",
    });
    const outcome = await runCleanup(pick('big:1', 'small:1'), remote);
    expect(calls).toHaveLength(2);
    expect(outcome.removed.map((item) => item.name)).toEqual(['small:1']);
    expect(outcome.failed).toEqual([{ item: big, message: 'image is being used' }]);
    expect(outcome.freedBytes).toBe(5 * MB);
  });
});
