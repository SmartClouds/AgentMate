import { describe, expect, it, vi } from 'vitest';
import type {
  StackInfo,
  StackRevisionInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The App Store's last line of defence: a render the linter still has findings for is never
 * uploaded, for an install or an update. No shipped template has one (a catalog test holds them
 * to it), so the catalog is made to report one here.
 */

const FINDING = { id: 'privileged:app', rule: 'privileged', severity: 'critical', message: 'x' };

vi.mock('@runova/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@runova/core')>();
  return {
    ...actual,
    renderCatalogApp: (...args: Parameters<typeof actual.renderCatalogApp>) => {
      const result = actual.renderCatalogApp(...args);
      return result.ok
        ? { ok: true, render: { ...result.render, unacknowledged: [FINDING] } }
        : result;
    },
    renderCatalogUpdate: (...args: Parameters<typeof actual.renderCatalogUpdate>) => {
      const result = actual.renderCatalogUpdate(...args);
      return result.ok ? { ...result, unacknowledged: [FINDING] } : result;
    },
  };
});

const { generateCatalogSecrets, findCatalogTemplate, renderCatalogApp } = await import(
  '@runova/core'
);
const { DeployAppStore } = await import('./service');

const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const INFO = { id: STACK, name: 'cache', liveRevision: 1 } as StackInfo;
const REVISION = {
  number: 1,
  envKeys: ['REDIS_PASSWORD'],
  proxiedServices: [],
} as unknown as StackRevisionInfo;

function store(revisions: StackRevisionInfo[] = [REVISION]) {
  const redis = findCatalogTemplate('redis');
  if (!redis) throw new Error('no redis');
  const rendered = renderCatalogApp(redis, { secrets: generateCatalogSecrets(redis.secrets) });
  if (!rendered.ok) throw new Error(rendered.reason);
  const stacks = {
    createFromFiles: vi.fn(),
    deploy: vi.fn(),
    get: vi.fn(async () => ({ stack: INFO, revisions, services: [] })),
    files: vi.fn(async () => ({ number: 1, compose: rendered.render.compose, envKeys: [] })),
    reviseAndDeploy: vi.fn(),
    revealEnv: vi.fn(),
  };
  return { appStore: new DeployAppStore({ stacks }), stacks, secrets: rendered.render.env };
}

describe('DeployAppStore refusals', () => {
  it('never uploads an install with a finding nobody reviewed', async () => {
    const { appStore, stacks, secrets } = store();
    await expect(
      appStore.install({
        serverId: 'srv-1',
        templateId: 'redis',
        version: '8.10',
        name: 'cache',
        params: {},
        secrets,
        domain: null,
      }),
    ).rejects.toThrow('Redis has findings nobody reviewed: privileged:app.');
    expect(stacks.createFromFiles).not.toHaveBeenCalled();
  });

  it('never revises an app onto a version with such a finding', async () => {
    const { appStore, stacks } = store();
    await expect(
      appStore.update({ serverId: 'srv-1', stackId: STACK, version: '8.10' }),
    ).rejects.toThrow('The new version has findings nobody reviewed: privileged:app.');
    expect(stacks.reviseAndDeploy).not.toHaveBeenCalled();
  });

  it('says so when the app has no revision to update from, or the version is unknown', async () => {
    await expect(
      store([]).appStore.update({ serverId: 'srv-1', stackId: STACK, version: '8.10' }),
    ).rejects.toThrow('cache has no revision to update from.');
    await expect(
      store().appStore.update({ serverId: 'srv-1', stackId: STACK, version: '99' }),
    ).rejects.toThrow('Redis has no version "99".');
  });
});
