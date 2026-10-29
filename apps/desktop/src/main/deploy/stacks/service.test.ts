import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Project } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type {
  StackInfo,
  StackRevisionInfo,
  StackRevisionUpload,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeployStackUploadProgress } from '../../../shared/deployStacksTypes';
import { tempDir } from '../../../test/main/fixtures';
import { type CoreHttpClient, CoreHttpError } from '../connection/coreHttp';
import type { BuildContextOptions } from './buildContext';
import { DeployStacks } from './service';

/**
 * The Apps' main-process side: an upload reads the project again, refuses what still needs an
 * acknowledgment before the server hears of it, renders the .env (values go to the core and
 * nowhere else), packs a build context when the file needs one and streams it after the files.
 */

const SERVER = 'srv-1';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SECRET = 'pg-very-secret-1234';

const STACK_INFO: StackInfo = {
  id: STACK,
  name: 'shop',
  status: 'new',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  revisionCount: 0,
  runningContainers: 0,
  containers: 0,
};

const REVISION: StackRevisionInfo = {
  stackId: STACK,
  number: 1,
  state: 'ready',
  createdAtUnixMs: 2,
  composeSha256: 'abc',
  envKeys: ['DB_PASSWORD'],
  services: ['web'],
  proxiedServices: ['web'],
  hasBuildContext: false,
  steps: [],
  findings: [],
  acknowledgedRisks: [],
  unacknowledgedRisks: [],
  bindings: [],
};

const SIMPLE = `services:
  web:
    image: nginx:1.29
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "true"]
    environment:
      PASSWORD: \${DB_PASSWORD}
    ports:
      - "8080:80"
`;

const BUILDS = `services:
  api:
    build: ./api
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "true"]
`;

const RISKY = `services:
  agent:
    image: example/agent:1.0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "true"]
    privileged: true
`;

function folderWith(files: Record<string, string>): string {
  const folder = tempDir('runova-stack-service-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  return folder;
}

interface Calls {
  posts: Array<{ path: string; body: StackRevisionUpload; token?: string }>;
  puts: Array<{ path: string; body: string; headers?: Record<string, string>; length: number }>;
}

function harness(
  files: Record<string, string>,
  hub: Partial<Record<keyof ICoreHub, (...args: never[]) => unknown>> = {},
  http: { post?: () => unknown; put?: () => unknown } = {},
) {
  const folder = folderWith(files);
  const calls: Calls = { posts: [], puts: [] };
  const progress: DeployStackUploadProgress[] = [];
  const contextRoot = tempDir('runova-stack-temp-');
  const fakeHub = {
    listStacks: vi.fn(async () => []),
    createStack: vi.fn(async () => STACK_INFO),
    getStack: vi.fn(async () => ({
      stack: { ...STACK_INFO, revisionCount: 1 },
      revisions: [REVISION],
      services: [],
    })),
    ...hub,
  } as unknown as ICoreHub;
  const client = {
    post: vi.fn(async (path: string, body: StackRevisionUpload, options: { token?: string }) => {
      calls.posts.push({ path, body, token: options.token });
      return http.post ? http.post() : { ...REVISION, hasBuildContext: body.buildContext };
    }),
    putStream: vi.fn(
      async (
        path: string,
        stream: Readable,
        options: {
          headers?: Record<string, string>;
          contentLength: number;
          onProgress?: (n: number) => void;
        },
      ) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        options.onProgress?.(body.length);
        calls.puts.push({
          path,
          body: body.toString('base64'),
          headers: options.headers,
          length: options.contentLength,
        });
        return http.put ? http.put() : { ...REVISION, hasBuildContext: true };
      },
    ),
  } as unknown as CoreHttpClient;
  const pack = vi.fn(async (options: BuildContextOptions) => {
    writeFileSync(options.output, 'packed-context');
    return {
      path: options.output,
      entries: 2,
      contentBytes: 10,
      archiveBytes: 14,
      sha256: 'f00d',
      skipped: [],
    };
  });
  const stacks = new DeployStacks({
    links: { call: (_serverId, work) => work(fakeHub) },
    roles: () => ['operator'],
    http: (_serverId, work) => work(client, 'token-1'),
    source: {
      project: async () => ({ id: 'p1', name: 'Shop', folderPath: folder }) as Project,
      index: async (root) => ({ root, files: Object.keys(files), truncated: false }),
      // f1 is the .env every test without a pick gets; f2 only comes when picked.
      environment: async (_project, _environment, fileIds = ['f1']) => {
        const picked = fileIds.map((id) => ENV_FILES[id]);
        return {
          id: 'e1',
          name: 'Production',
          files: picked,
          entries: picked.flatMap((file) => file.entries.map(({ key, value }) => ({ key, value }))),
        };
      },
    },
    pack,
    progress: (event) => progress.push(event),
    tempRoot: () => contextRoot,
  });
  return { stacks, hub: fakeHub, client, calls, progress, pack, folder, contextRoot };
}

const ENV_FILES: Record<
  string,
  { fileName: string; entries: Array<{ key: string; value: string; line: number }> }
> = {
  f1: { fileName: '.env', entries: [{ key: 'DB_PASSWORD', value: SECRET, line: 1 }] },
  f2: { fileName: '.env.local', entries: [{ key: 'LOCAL_ONLY', value: 'yes', line: 1 }] },
};

const CREATE = {
  serverId: SERVER,
  name: 'shop',
  projectId: 'p1',
  composePath: 'compose.yaml',
  environmentId: 'e1',
  proxiedServices: ['web'],
  acknowledgedRisks: [],
};

describe('DeployStacks.create', () => {
  it('creates the app, then posts the compose file and the rendered .env', async () => {
    const { stacks, hub, calls, progress, pack } = harness({ 'compose.yaml': SIMPLE });

    const result = await stacks.create(CREATE);

    expect(hub.createStack).toHaveBeenCalledWith({
      name: 'shop',
      source: {
        projectId: 'p1',
        projectName: 'Shop',
        composePath: 'compose.yaml',
        environmentId: 'e1',
        environmentName: 'Production',
      },
    });
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0].path).toBe(`/api/v1/stacks/${STACK}/revisions`);
    expect(calls.posts[0].token).toBe('token-1');
    expect(calls.posts[0].body).toMatchObject({
      compose: SIMPLE,
      proxiedServices: ['web'],
      acknowledgedRisks: [],
      buildContext: false,
    });
    // The value goes to the core in the .env, quoted the way Compose reads it back.
    expect(calls.posts[0].body.env).toContain(`DB_PASSWORD="${SECRET}"`);
    expect(pack).not.toHaveBeenCalled();
    expect(calls.puts).toEqual([]);
    expect(result.stack.revisionCount).toBe(1);
    expect(result.revision.number).toBe(1);
    expect(progress.map((event) => event.phase)).toEqual(['reading', 'uploading-files', 'done']);
  });

  it('packs the compose folder first and streams it after the files when a service builds', async () => {
    const { stacks, calls, pack, progress, folder, contextRoot } = harness({
      'compose.yaml': BUILDS,
      'api/Dockerfile': 'FROM scratch\n',
    });

    const result = await stacks.create({ ...CREATE, proxiedServices: [] });

    expect(pack).toHaveBeenCalledWith(
      expect.objectContaining({ root: folder, alwaysInclude: ['api/Dockerfile'] }),
    );
    expect(calls.posts[0].body.buildContext).toBe(true);
    expect(calls.puts).toEqual([
      {
        path: `/api/v1/stacks/${STACK}/revisions/1/context`,
        body: Buffer.from('packed-context').toString('base64'),
        headers: { 'x-content-sha256': 'f00d' },
        length: 14,
      },
    ]);
    expect(result.revision.hasBuildContext).toBe(true);
    expect(progress.map((event) => event.phase)).toEqual([
      'reading',
      'packing',
      'uploading-files',
      'uploading-context',
      'uploading-context',
      'done',
    ]);
    expect(progress[4]).toMatchObject({ sentBytes: 14, totalBytes: 14 });
    // The packed context does not stay on this computer.
    const packedAt = pack.mock.calls[0][0].output;
    expect(packedAt.startsWith(contextRoot)).toBe(true);
    expect(existsSync(packedAt)).toBe(false);
  });

  it('refuses before the server hears anything while a risk waits for its acknowledgment', async () => {
    const { stacks, hub, calls } = harness({ 'compose.yaml': RISKY });

    await expect(stacks.create(CREATE)).rejects.toThrow(
      'Acknowledge every risk before deploying. Still waiting: privileged:agent.',
    );
    expect(hub.createStack).not.toHaveBeenCalled();
    expect(calls.posts).toEqual([]);

    await stacks.create({ ...CREATE, acknowledgedRisks: ['privileged:agent', 'privileged:agent'] });
    expect(calls.posts[0].body.acknowledgedRisks).toEqual(['privileged:agent']);
  });

  it('refuses a name compose cannot use, and one an app with files already has', async () => {
    const taken = { ...STACK_INFO, revisionCount: 2 };
    const { stacks, hub } = harness(
      { 'compose.yaml': SIMPLE },
      { listStacks: async () => [taken] },
    );

    await expect(stacks.create({ ...CREATE, name: 'Shop App' })).rejects.toThrow();
    await expect(stacks.create(CREATE)).rejects.toThrow(
      'There is already an app called shop on this server.',
    );
    expect(hub.createStack).not.toHaveBeenCalled();
  });

  it('reuses an app of that name that never got its files, as after a failed upload', async () => {
    const { stacks, hub, calls } = harness(
      { 'compose.yaml': SIMPLE },
      { listStacks: async () => [STACK_INFO] },
    );

    await stacks.create(CREATE);

    expect(hub.createStack).not.toHaveBeenCalled();
    expect(calls.posts[0].path).toBe(`/api/v1/stacks/${STACK}/revisions`);
  });

  it('passes on what the core said when it refused the files', async () => {
    const { stacks } = harness(
      { 'compose.yaml': SIMPLE },
      {},
      {
        post: () => {
          throw new CoreHttpError('refused', 409, {
            message: 'That revision already has its files.',
          });
        },
      },
    );
    await expect(stacks.create(CREATE)).rejects.toThrow('That revision already has its files.');
  });

  it("says a role that may not upload cannot, with the role's own name", async () => {
    const { stacks } = harness(
      { 'compose.yaml': SIMPLE },
      {},
      {
        post: () => {
          throw new CoreHttpError('refused', 403, null);
        },
      },
    );
    const error = await stacks.create(CREATE).catch((caught: Error) => caught);
    expect(coreErrorCode(error)).toBe('forbidden');
    expect((error as Error).message).toContain('(operator)');
  });

  it('blocks a compose file that cannot be read', async () => {
    const { stacks } = harness({ 'compose.yaml': 'services: [' });
    await expect(stacks.create(CREATE)).rejects.toThrow(/not valid YAML/);
  });
});

describe('DeployStacks on the hub', () => {
  it('uploads a new revision of an existing app', async () => {
    const { stacks, calls } = harness({ 'compose.yaml': SIMPLE });
    await stacks.upload({
      serverId: SERVER,
      stackId: STACK,
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
      proxiedServices: ['web'],
      acknowledgedRisks: [],
    });
    expect(calls.posts[0].body.env).not.toContain(SECRET);
  });

  it('renders the .env from the picked env files only', async () => {
    const { stacks, calls } = harness({ 'compose.yaml': SIMPLE });
    await stacks.upload({
      serverId: SERVER,
      stackId: STACK,
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: 'e1',
      envFileIds: ['f2'],
      proxiedServices: ['web'],
      acknowledgedRisks: [],
    });
    expect(calls.posts[0].body.env).toContain('LOCAL_ONLY=');
    expect(calls.posts[0].body.env).not.toContain(SECRET);
  });

  it('calls the hub for reads, deploys, rollbacks, lifecycle and both kinds of delete', async () => {
    const job = { id: 'j', kind: 'stackDeploy' };
    const calls: Record<string, unknown[]> = {};
    const record =
      (name: string, answer: unknown = job) =>
      async (...args: unknown[]) => {
        calls[name] = args;
        return answer;
      };
    const { stacks } = harness(
      { 'compose.yaml': SIMPLE },
      {
        listStacks: record('listStacks', [STACK_INFO]),
        getStackRevisionFiles: record('getStackRevisionFiles', { number: 1 }),
        acknowledgeStackRisks: record('acknowledgeStackRisks', REVISION),
        deployStack: record('deployStack'),
        rollbackStack: record('rollbackStack'),
        runStackAction: record('runStackAction'),
        deleteStack: record('deleteStack'),
        deleteStackWithVolumes: record('deleteStackWithVolumes'),
      },
    );

    expect(await stacks.list(SERVER)).toEqual([STACK_INFO]);
    await stacks.files(SERVER, STACK, 3);
    await stacks.acknowledge(SERVER, STACK, 1, ['a', 'a', 'b']);
    await stacks.deploy(SERVER, STACK, 1);
    await stacks.rollback(SERVER, STACK, 1);
    await stacks.action(SERVER, STACK, 'restart');
    await stacks.delete(SERVER, STACK, false);
    await stacks.delete(SERVER, STACK, true);

    expect(calls.getStackRevisionFiles).toEqual([{ stackId: STACK, revision: 3 }]);
    expect(calls.acknowledgeStackRisks).toEqual([
      { stackId: STACK, revision: 1, riskIds: ['a', 'b'] },
    ]);
    expect(calls.deployStack).toEqual([{ stackId: STACK, revision: 1 }]);
    expect(calls.rollbackStack).toEqual([{ stackId: STACK, revision: 1 }]);
    expect(calls.runStackAction).toEqual([{ stackId: STACK, action: 'restart' }]);
    expect(calls.deleteStack).toEqual([STACK]);
    expect(calls.deleteStackWithVolumes).toEqual([STACK]);
  });

  it('turns a refused policy into a forbidden error naming the role', async () => {
    const { stacks } = harness(
      { 'compose.yaml': SIMPLE },
      {
        deleteStackWithVolumes: async () => {
          throw new Error("Failed to invoke 'DeleteStackWithVolumes' because user is unauthorized");
        },
      },
    );
    const error = await stacks.delete(SERVER, STACK, true).catch((caught: Error) => caught);
    expect(coreErrorCode(error)).toBe('forbidden');
  });

  it('discovers and previews through the project files', async () => {
    const { stacks } = harness({ 'compose.yaml': SIMPLE });
    expect((await stacks.discover('p1')).files).toEqual([{ path: 'compose.yaml', services: 1 }]);
    const preview = await stacks.preview({
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: 'e1',
    });
    expect(preview.envKeys).toEqual(['DB_PASSWORD']);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });
});
