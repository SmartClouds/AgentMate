import { findCatalogTemplate, generateCatalogSecrets, renderCatalogApp } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type {
  JobInfo,
  StackDetails,
  StackInfo,
  StackRevisionInfo,
  StackRevisionUpload,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { type AppStoreStacks, DeployAppStore } from './service';

/**
 * The App Store's main-process side: an install is rendered again here from what was picked
 * (never taken as a file from the renderer), goes up as a new app and deploys; an update renders
 * the newer compose file and has the server copy the live revision with it, keeping its .env.
 */

const SERVER = 'srv-1';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const JOB = { id: 'job-1' } as unknown as JobInfo;

const redis = findCatalogTemplate('redis');
const postgres = findCatalogTemplate('postgres');
if (!redis || !postgres) throw new Error('the catalog lost redis or postgres');

const INFO: StackInfo = {
  id: STACK,
  name: 'cache',
  status: 'new',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  revisionCount: 1,
  runningContainers: 0,
  containers: 0,
};

const revision = (extra: Partial<StackRevisionInfo> = {}): StackRevisionInfo => ({
  stackId: STACK,
  number: 1,
  state: 'ready',
  createdAtUnixMs: 2,
  composeSha256: 'abc',
  envKeys: ['REDIS_PASSWORD'],
  services: ['redis'],
  proxiedServices: ['redis'],
  hasBuildContext: false,
  steps: [],
  findings: [],
  acknowledgedRisks: [],
  unacknowledgedRisks: [],
  bindings: [],
  ...extra,
});

function harness(stacks: Partial<AppStoreStacks> = {}) {
  const uploads: StackRevisionUpload[] = [];
  const fake: AppStoreStacks = {
    createFromFiles: vi.fn(async (_server, _name, _description, upload) => {
      uploads.push(upload);
      return { stack: INFO, revision: revision() };
    }),
    deploy: vi.fn(async () => JOB),
    get: vi.fn(async () => ({ stack: INFO, revisions: [revision()], services: [] })),
    files: vi.fn(async () => ({ number: 1, compose: '', envKeys: [] })),
    reviseAndDeploy: vi.fn(async () => ({ revision: revision({ number: 2 }), job: JOB })),
    revealEnv: vi.fn(async () => []),
    ...stacks,
  };
  return { store: new DeployAppStore({ stacks: fake }), stacks: fake, uploads };
}

const INSTALL = {
  serverId: SERVER,
  templateId: 'redis',
  version: '8.10',
  name: 'cache',
  params: { port: 16390 },
  secrets: generateCatalogSecrets(redis.secrets),
  domain: null,
};

describe('DeployAppStore.install', () => {
  it('renders the files here, creates the app and deploys it', async () => {
    const { store, stacks, uploads } = harness();
    const result = await store.install(INSTALL);
    expect(stacks.createFromFiles).toHaveBeenCalledWith(
      SERVER,
      'cache',
      'Redis from the App Store',
      expect.anything(),
    );
    const [upload] = uploads;
    expect(upload.compose).toContain('127.0.0.1:16390:6379');
    expect(upload.compose).not.toContain(INSTALL.secrets.REDIS_PASSWORD);
    expect(upload.env).toContain(INSTALL.secrets.REDIS_PASSWORD);
    expect(upload.proxiedServices).toEqual(['redis']);
    expect(upload.buildContext).toBe(false);
    expect(stacks.deploy).toHaveBeenCalledWith(SERVER, STACK, 1);
    expect(result).toEqual({ stack: INFO, revision: revision(), job: JOB });
  });

  it('refuses an unknown app, a weak secret and parameters that do not fit, before any upload', async () => {
    const { store, stacks } = harness();
    await expect(store.install({ ...INSTALL, templateId: 'minio' })).rejects.toThrow(
      'The App Store has no app called minio.',
    );
    await expect(
      store.install({ ...INSTALL, secrets: { REDIS_PASSWORD: 'short' } }),
    ).rejects.toThrow('at least 16 characters');
    await expect(store.install({ ...INSTALL, params: { port: 70000 } })).rejects.toThrow(
      'Ports go from 1 to 65535.',
    );
    expect(stacks.createFromFiles).not.toHaveBeenCalled();
  });

  it('leaves a revision the server refused undeployed', async () => {
    const { store, stacks } = harness({
      createFromFiles: async () => ({ stack: INFO, revision: revision({ state: 'invalid' }) }),
    });
    const result = await store.install(INSTALL);
    expect(result.job).toBeNull();
    expect(stacks.deploy).not.toHaveBeenCalled();
  });
});

describe('DeployAppStore.update', () => {
  function installed(version: string) {
    const out = renderCatalogApp(postgres as NonNullable<typeof postgres>, {
      version,
      params: { port: 15440 },
      secrets: generateCatalogSecrets((postgres as NonNullable<typeof postgres>).secrets),
    });
    if (!out.ok) throw new Error(out.reason);
    return out.render;
  }

  const details = (envKeys: string[]): StackDetails => ({
    stack: { ...INFO, name: 'db', liveRevision: 1 },
    revisions: [revision({ state: 'live', envKeys, proxiedServices: ['postgres'] })],
    services: [],
  });

  it('has the server copy the live revision with the newer compose file and no env', async () => {
    const old = installed('17');
    const { store, stacks } = harness({
      get: async () => details(Object.keys(old.env)),
      files: vi.fn(async () => ({
        number: 1,
        compose: old.compose,
        envKeys: Object.keys(old.env),
      })),
    });
    const result = await store.update({ serverId: SERVER, stackId: STACK, version: '18' });
    expect(stacks.files).toHaveBeenCalledWith(SERVER, STACK, 1);
    const [[server, request]] = (stacks.reviseAndDeploy as ReturnType<typeof vi.fn>).mock.calls;
    expect(server).toBe(SERVER);
    expect(request).toMatchObject({
      stackId: STACK,
      revision: 1,
      proxiedServices: ['postgres'],
      purpose: 'update',
      acknowledgedRisks: [],
    });
    expect(request.compose).toContain('version: "18"');
    expect(request).not.toHaveProperty('env');
    expect(result.job).toBe(JOB);
  });

  it('refuses an app that is not from the App Store, and a version that needs a missing secret', async () => {
    const notStore = harness({
      files: async () => ({ number: 1, compose: 'services: {}\n', envKeys: [] }),
    });
    await expect(
      notStore.store.update({ serverId: SERVER, stackId: STACK, version: '18' }),
    ).rejects.toThrow('not installed from the App Store');

    const old = installed('17');
    const missing = harness({
      get: async () => details([]),
      files: async () => ({ number: 1, compose: old.compose, envKeys: [] }),
    });
    await expect(
      missing.store.update({ serverId: SERVER, stackId: STACK, version: '18' }),
    ).rejects.toThrow('POSTGRES_PASSWORD');
    expect(missing.stacks.reviseAndDeploy).not.toHaveBeenCalled();
  });
});

describe('DeployAppStore.revealSecrets', () => {
  it('hands back the .env as a map', async () => {
    const { store } = harness({
      revealEnv: async () => [{ key: 'REDIS_PASSWORD', value: 'Abc1234567890defg' }],
    });
    await expect(
      store.revealSecrets({ serverId: SERVER, stackId: STACK, revision: 1, password: 'pw' }),
    ).resolves.toEqual({ REDIS_PASSWORD: 'Abc1234567890defg' });
  });
});
