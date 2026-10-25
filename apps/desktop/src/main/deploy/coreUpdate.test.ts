import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../shared/coreErrors';
import type {
  CoreUpdateRequest,
  CoreUpdateResult,
} from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import type { DeployCoreRecord, DeployHealth, DeploySetupProgress } from '../../shared/deployTypes';
import type { ReleaseSource } from './bootstrap/releaseSource';
import { type CoreHttpClient, CoreHttpError, type CoreStreamOptions } from './connection/coreHttp';
import { CORE_UPDATE_PATH, type CoreUpdateDeps, updateCoreLive } from './coreUpdate';

const SHA = 'b'.repeat(64);
const FILE = 'agentmate-core-1.64.0-linux-x64.tar.gz';
const URL = `https://github.com/SmartClouds/AgentMate/releases/download/v1.64.0/${FILE}`;
const RECORD: DeployCoreRecord = {
  version: '1.63.0',
  release: '/opt/agentmate-core/releases/1.63.0-aaaaaaaaaaaa',
  transport: 'streamlocal',
  installedAt: 1,
  os: 'Ubuntu 24.04 LTS',
  architecture: 'x86_64',
};

function health(version: string, startedAtUnixMs: number): DeployHealth {
  return { version, apiVersion: 1, startedAtUnixMs, checkedAt: 0 };
}

interface Upload {
  path: string;
  options: CoreStreamOptions;
  body: Buffer;
}

let folder: string;
let tarball: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'core-update-'));
  tarball = join(folder, FILE);
  await writeFile(tarball, Buffer.alloc(4096, 7));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * A server whose core answers `updateCore` as told and then restarts: health answers from the old
 * start until `restartAfter` checks, then from a new start on `cameBackAs`.
 */
function setup(
  options: {
    remote?: boolean;
    answer?: (request: CoreUpdateRequest) => CoreUpdateResult;
    hubError?: Error;
    uploadError?: Error;
    cameBackAs?: string;
    roles?: string[] | null;
  } = {},
) {
  const progress: DeploySetupProgress[] = [];
  const uploads: Upload[] = [];
  const saved: DeployCoreRecord[] = [];
  const stepUps: unknown[] = [];
  const requests: CoreUpdateRequest[] = [];
  let checks = 0;
  const releases: ReleaseSource = {
    release: vi.fn(async (rid) => ({
      version: '1.64.0',
      rid,
      file: FILE,
      sha256: SHA,
      localPath: tarball,
    })),
    ...(options.remote === false
      ? {}
      : {
          remote: (rid) => ({
            version: '1.64.0',
            rid,
            file: FILE,
            sha256: SHA,
            size: 4096,
            url: URL,
          }),
        }),
  };
  const hub = {
    stepUp: vi.fn(async (proof: unknown) => {
      stepUps.push(proof);
      return { stepUpUntilUnixMs: 1 };
    }),
    updateCore: vi.fn(async (request: CoreUpdateRequest) => {
      requests.push(request);
      if (options.hubError) throw options.hubError;
      return options.answer?.(request) ?? { outcome: 'switching', runningVersion: '1.63.0' };
    }),
  } as unknown as ICoreHub;
  const client = {
    putStream: vi.fn(async (path: string, body: Readable, streamOptions: CoreStreamOptions) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      uploads.push({ path, options: streamOptions, body: Buffer.concat(chunks) });
      streamOptions.onProgress?.(4096);
      if (options.uploadError) throw options.uploadError;
      return { outcome: 'switching', runningVersion: '1.63.0' };
    }),
  } as unknown as CoreHttpClient;
  const resetLink = vi.fn();
  const deps: CoreUpdateDeps = {
    releases,
    record: async () => RECORD,
    saveRecord: async (_id, record) => {
      saved.push(record);
    },
    withHub: (_id, work) => work(hub),
    withCoreHttp: (_id, work) => work(client, 'token'),
    health: async () => {
      checks += 1;
      if (checks === 1) return health('1.63.0', 100);
      if (checks === 2) throw new Error('connect ECONNREFUSED');
      return health(options.cameBackAs ?? '1.64.0', 200);
    },
    roles: () => (options.roles === undefined ? ['owner'] : options.roles),
    resetLink,
    progress: (event) => progress.push(event),
    sleep: async () => undefined,
  };
  return { deps, progress, uploads, saved, stepUps, requests, resetLink, releases };
}

const phases = (events: DeploySetupProgress[]) =>
  events.map((event) => `${event.phase}:${event.status}`);

describe('updateCoreLive', () => {
  it('lets the server download the release itself and waits for it to come back on it', async () => {
    const { deps, progress, uploads, saved, requests, resetLink, releases } = setup();

    const result = await updateCoreLive(deps, { serverId: 's1', password: 'pw' });

    expect(result).toEqual({
      outcome: 'updated',
      version: '1.64.0',
      previousVersion: '1.63.0',
      via: 'server-download',
    });
    expect(requests).toEqual([
      { version: '1.64.0', file: FILE, sha256: SHA, size: 4096, downloadUrl: URL },
    ]);
    expect(uploads).toEqual([]);
    expect(releases.release).not.toHaveBeenCalled();
    expect(phases(progress)).toEqual([
      'fetch:running',
      'fetch:done',
      'switch:running',
      'switch:done',
      'health:done',
    ]);
    expect(saved).toEqual([
      expect.objectContaining({
        version: '1.64.0',
        release: `/opt/agentmate-core/releases/1.64.0-${SHA.slice(0, 12)}`,
      }),
    ]);
    expect(resetLink).toHaveBeenCalledWith('s1');
  });

  it('steps up with the password it is given before asking', async () => {
    const { deps, stepUps } = setup();

    await updateCoreLive(deps, { serverId: 's1', totpCode: '123456' });

    expect(stepUps).toEqual([{ totpCode: '123456' }]);
  });

  it('uploads the release over the core connection when the server cannot download it', async () => {
    const { deps, progress, uploads } = setup({
      answer: () => ({
        outcome: 'downloadFailed',
        runningVersion: '1.63.0',
        problem: 'Name or service not known (github.com:443)',
      }),
    });

    const result = await updateCoreLive(deps, { serverId: 's1' });

    expect(result).toMatchObject({ outcome: 'updated', via: 'upload' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.path).toBe(CORE_UPDATE_PATH);
    expect(uploads[0]?.body.length).toBe(4096);
    expect(uploads[0]?.options).toMatchObject({
      token: 'token',
      contentLength: 4096,
      headers: {
        'x-agentmate-core-version': '1.64.0',
        'x-agentmate-core-file': FILE,
        'x-agentmate-core-sha256': SHA,
      },
    });
    expect(phases(progress)).toEqual([
      'fetch:running',
      'fetch:failed',
      'download:running',
      'download:done',
      'upload:running',
      'upload:running',
      'upload:done',
      'switch:running',
      'switch:done',
      'health:done',
    ]);
    expect(progress[1]?.detail).toContain('github.com');
  });

  it('uploads straight away from a build with no public release, stepping up first', async () => {
    const { deps, uploads, requests, stepUps } = setup({ remote: false });

    const result = await updateCoreLive(deps, { serverId: 's1', password: 'pw' });

    expect(result).toMatchObject({ outcome: 'updated', via: 'upload' });
    expect(requests).toEqual([]);
    expect(stepUps).toEqual([{ password: 'pw' }]);
    expect(uploads).toHaveLength(1);
  });

  it('says to use SSH for an older core without the hub method', async () => {
    const { deps } = setup({
      hubError: new Error(
        "Failed to invoke 'UpdateCore' due to an error on the server. Method does not exist.",
      ),
    });

    const result = await updateCoreLive(deps, { serverId: 's1' });

    expect(result).toEqual({
      outcome: 'needs-ssh',
      reason: 'This server runs an older core that cannot update itself.',
    });
  });

  it('says to use SSH for a core the app did not install', async () => {
    const { deps } = setup({
      answer: () => ({
        outcome: 'unsupported',
        runningVersion: '0.0.0-dev',
        problem: 'This core was not installed by the app, so it cannot replace itself.',
      }),
    });

    const result = await updateCoreLive(deps, { serverId: 's1' });

    expect(result).toMatchObject({
      outcome: 'needs-ssh',
      reason: expect.stringContaining('not installed'),
    });
  });

  it('asks for a step-up when the core wants one, and tells a non-owner it cannot', async () => {
    const refused = new Error("Failed to invoke 'UpdateCore' because user is unauthorized");

    const owner = await updateCoreLive(setup({ hubError: refused }).deps, { serverId: 's1' }).catch(
      (error: unknown) => error,
    );
    const admin = await updateCoreLive(setup({ hubError: refused, roles: ['admin'] }).deps, {
      serverId: 's1',
    }).catch((error: unknown) => error);

    expect(coreErrorCode(owner)).toBe('stepUpRequired');
    expect(coreErrorCode(admin)).toBe('forbidden');
    expect((admin as Error).message).toContain('Only an Owner');
  });

  it('turns a refused upload into a step-up or an older core', async () => {
    const forbidden = new CoreHttpError('Forbidden', 403, null);
    const missing = new CoreHttpError('Not Found', 404, null);

    const stepUp = await updateCoreLive(setup({ remote: false, uploadError: forbidden }).deps, {
      serverId: 's1',
    }).catch((error: unknown) => error);
    const viewer = await updateCoreLive(
      setup({ remote: false, uploadError: forbidden, roles: ['viewer'] }).deps,
      { serverId: 's1' },
    ).catch((error: unknown) => error);
    const older = await updateCoreLive(setup({ remote: false, uploadError: missing }).deps, {
      serverId: 's1',
    });

    expect(coreErrorCode(stepUp)).toBe('stepUpRequired');
    expect(coreErrorCode(viewer)).toBe('forbidden');
    expect(older).toMatchObject({ outcome: 'needs-ssh' });
  });

  it('reports a release that did not stay up, without saving it', async () => {
    const { deps, progress, saved } = setup({ cameBackAs: '1.63.0' });

    await expect(updateCoreLive(deps, { serverId: 's1' })).rejects.toThrow(
      /1\.64\.0 did not stay up, so the server went back to 1\.63\.0/,
    );
    expect(phases(progress).at(-1)).toBe('switch:failed');
    expect(saved).toEqual([]);
  });

  it('gives up when the core does not come back', async () => {
    let clock = 0;
    const { deps } = setup();
    deps.health = vi.fn(async () => {
      if (clock === 0) return health('1.63.0', 100);
      throw new Error('connect ECONNREFUSED');
    });
    deps.now = () => clock;
    deps.sleep = async (ms) => {
      clock += ms;
    };

    await expect(updateCoreLive(deps, { serverId: 's1' })).rejects.toThrow(
      /did not answer within 3 minutes/,
    );
  });

  it('refuses a server whose processor has no build', async () => {
    const { deps } = setup();
    deps.record = async () => ({ ...RECORD, architecture: 'riscv64' });

    expect(await updateCoreLive(deps, { serverId: 's1' })).toMatchObject({ outcome: 'needs-ssh' });
  });
});
