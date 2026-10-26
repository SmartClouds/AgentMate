import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type {
  JobInfo,
  StackDetails,
  StackInfo,
  StackRevisionInfo,
  StackRevisionUpload,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { CoreHttpClient } from '../connection/coreHttp';
import { DeployStacks } from './service';

/**
 * Revisions that never read a project: files made in the main process (an App Store install),
 * revisions copied on the server (updates, "make private") and revealing a revision's .env.
 */

const SERVER = 'srv-1';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';

const INFO: StackInfo = {
  id: STACK,
  name: 'shop',
  status: 'running',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  revisionCount: 1,
  liveRevision: 1,
  runningContainers: 1,
  containers: 1,
};

const revision = (extra: Partial<StackRevisionInfo> = {}): StackRevisionInfo => ({
  stackId: STACK,
  number: 1,
  state: 'live',
  createdAtUnixMs: 2,
  composeSha256: 'abc',
  envKeys: ['DB_PASSWORD'],
  services: ['web', 'db'],
  proxiedServices: ['db'],
  hasBuildContext: false,
  steps: [],
  findings: [],
  acknowledgedRisks: [],
  unacknowledgedRisks: [],
  bindings: [],
  ...extra,
});

const JOB = { id: 'job-1', kind: 'stackDeploy', state: 'running' } as unknown as JobInfo;

function harness(
  hub: Partial<Record<keyof ICoreHub, (...args: never[]) => unknown>> = {},
  roles = ['operator'],
) {
  const details: StackDetails = { stack: INFO, revisions: [revision()], services: [] };
  const fake = {
    listStacks: vi.fn(async () => []),
    createStack: vi.fn(async () => ({ ...INFO, revisionCount: 0, liveRevision: undefined })),
    getStack: vi.fn(async () => details),
    reviseStack: vi.fn(async () =>
      revision({ number: 2, state: 'ready', proxiedServices: ['db', 'web'] }),
    ),
    deployStack: vi.fn(async () => JOB),
    stepUp: vi.fn(async () => ({ untilUnixMs: 1 })),
    revealStackEnv: vi.fn(async () => [{ key: 'DB_PASSWORD', value: 'Secret1234567890' }]),
    ...hub,
  } as unknown as ICoreHub;
  const posts: Array<{ path: string; body: StackRevisionUpload }> = [];
  const client = {
    post: vi.fn(async (path: string, body: StackRevisionUpload) => {
      posts.push({ path, body });
      return revision({ state: 'ready' });
    }),
  } as unknown as CoreHttpClient;
  const stacks = new DeployStacks({
    links: { call: (_serverId, work) => work(fake) },
    roles: () => roles,
    http: (_serverId, work) => work(client, 'token-1'),
    source: {
      project: async () => {
        throw new Error('no project is read here');
      },
      index: async () => {
        throw new Error('no project is read here');
      },
      environment: async () => {
        throw new Error('no project is read here');
      },
    },
    pack: async () => {
      throw new Error('nothing is packed here');
    },
  });
  return { stacks, hub: fake, posts };
}

const UPLOAD: StackRevisionUpload = {
  compose: 'services: {}\n',
  env: 'A="b"\n',
  proxiedServices: ['web'],
  acknowledgedRisks: [],
  buildContext: false,
};

describe('DeployStacks.createFromFiles', () => {
  it('creates the app and posts the files as they are', async () => {
    const { stacks, hub, posts } = harness();
    const result = await stacks.createFromFiles(SERVER, 'shop', 'Redis from the App Store', UPLOAD);
    expect(hub.createStack).toHaveBeenCalledWith({
      name: 'shop',
      description: 'Redis from the App Store',
    });
    expect(posts).toEqual([{ path: `/api/v1/stacks/${STACK}/revisions`, body: UPLOAD }]);
    expect(result.revision.state).toBe('ready');
  });

  it('refuses a name already taken and a name that is not one', async () => {
    const { stacks } = harness({ listStacks: async () => [INFO] });
    await expect(stacks.createFromFiles(SERVER, 'shop', 'x', UPLOAD)).rejects.toThrow(
      'There is already an app called shop',
    );
    await expect(stacks.createFromFiles(SERVER, 'Not A Name', 'x', UPLOAD)).rejects.toThrow();
  });
});

describe('DeployStacks.makePrivate', () => {
  it('copies the live revision with the services on loopback and deploys it', async () => {
    const { stacks, hub } = harness();
    const result = await stacks.makePrivate({
      serverId: SERVER,
      stackId: STACK,
      services: ['web'],
    });
    expect(hub.reviseStack).toHaveBeenCalledWith({
      stackId: STACK,
      revision: 1,
      proxiedServices: ['db', 'web'],
      purpose: 'makePrivate',
    });
    expect(hub.deployStack).toHaveBeenCalledWith({ stackId: STACK, revision: 2 });
    expect(result).toEqual({ revision: expect.objectContaining({ number: 2 }), job: JOB });
  });

  it('refuses a service the app does not have, or one already private', async () => {
    const { stacks, hub } = harness();
    await expect(
      stacks.makePrivate({ serverId: SERVER, stackId: STACK, services: ['other'] }),
    ).rejects.toThrow('shop has no service called other.');
    await expect(
      stacks.makePrivate({ serverId: SERVER, stackId: STACK, services: ['db'] }),
    ).rejects.toThrow('already');
    expect(hub.reviseStack).not.toHaveBeenCalled();
  });

  it('does not deploy a revision the server found invalid or waiting for acknowledgments', async () => {
    const invalid = harness({
      reviseStack: async () => revision({ number: 2, state: 'invalid', error: 'Compose said no' }),
    });
    const out = await invalid.stacks.makePrivate({
      serverId: SERVER,
      stackId: STACK,
      services: ['web'],
    });
    expect(out.job).toBeNull();
    expect(invalid.hub.deployStack).not.toHaveBeenCalled();

    const waiting = harness({
      reviseStack: async () =>
        revision({ number: 2, state: 'ready', unacknowledgedRisks: ['privileged:web'] }),
    });
    const held = await waiting.stacks.makePrivate({
      serverId: SERVER,
      stackId: STACK,
      services: ['web'],
    });
    expect(held.job).toBeNull();
  });

  it('works from the newest revision when nothing is live yet', async () => {
    const { stacks, hub } = harness({
      getStack: async () => ({
        stack: { ...INFO, liveRevision: undefined, revisionCount: 2 },
        revisions: [revision({ number: 2, state: 'failed', proxiedServices: [] }), revision()],
        services: [],
      }),
    });
    await stacks.makePrivate({ serverId: SERVER, stackId: STACK, services: ['web'] });
    expect(hub.reviseStack).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2, proxiedServices: ['web'] }),
    );
  });
});

describe('DeployStacks.revealEnv', () => {
  it('steps up when handed a password, then reads the .env', async () => {
    const { stacks, hub } = harness({}, ['admin']);
    const entries = await stacks.revealEnv({
      serverId: SERVER,
      stackId: STACK,
      revision: 1,
      password: 'hunter2hunter2',
    });
    expect(hub.stepUp).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(hub.revealStackEnv).toHaveBeenCalledWith({ stackId: STACK, revision: 1 });
    expect(entries).toEqual([{ key: 'DB_PASSWORD', value: 'Secret1234567890' }]);
  });

  it('asks an Admin for a step-up, and tells an Operator it is not theirs', async () => {
    const refusal = async () => {
      throw new Error("Failed to invoke 'RevealStackEnv' because user is unauthorized");
    };
    const admin = harness({ revealStackEnv: refusal }, ['admin']);
    const asked = await admin.stacks
      .revealEnv({ serverId: SERVER, stackId: STACK, revision: 1 })
      .catch((error: unknown) => error);
    expect(coreErrorCode(asked)).toBe('stepUpRequired');
    const operator = harness({ revealStackEnv: refusal }, ['operator']);
    const refused = await operator.stacks
      .revealEnv({ serverId: SERVER, stackId: STACK, revision: 1 })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('forbidden');
  });
});

describe('DeployStacks.revise', () => {
  it('passes the request through and deploys only a ready revision', async () => {
    const { stacks, hub } = harness();
    const out = await stacks.reviseAndDeploy(SERVER, {
      stackId: STACK,
      revision: 1,
      proxiedServices: ['db'],
      compose: 'services: {}\n',
      purpose: 'update',
    });
    expect(hub.reviseStack).toHaveBeenCalledWith({
      stackId: STACK,
      revision: 1,
      proxiedServices: ['db'],
      compose: 'services: {}\n',
      purpose: 'update',
    });
    expect(out.job).toBe(JOB);
  });
});
