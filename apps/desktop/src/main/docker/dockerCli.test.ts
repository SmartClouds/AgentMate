import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDockerAvailable,
  listContainers,
  listContainersForProject,
  listImages,
  listRunningContainersForProject,
  pullImage,
  removeContainer,
  removeImages,
  restartContainer,
  sampleDockerActivity,
  startContainer,
  stopContainer,
} from './dockerCli';

/**
 * Every field the Docker tab shows is scraped out of two CLI calls, so the parsing is where this
 * breaks: `docker ps` truncates its ID by default while `docker stats` does not, memory arrives as
 * a human string with two different unit systems, and labels are one flat comma-joined blob.
 */

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

interface ExecOutcome {
  stdout?: string;
  error?: { message: string; stderr?: string };
}

const execState = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  /** Answers keyed by the docker subcommand, so a test only spells out what it cares about. */
  byCommand: new Map<string, ExecOutcome>(),
  /** Answers by the whole argument list, for calls that share a subcommand or lead with a flag. */
  respond: null as ((args: string[]) => ExecOutcome | undefined) | null,
}));

// The real execFile exposes a promisify implementation resolving to { stdout, stderr }; the
// stand-in has to as well or the module would destructure a bare string.
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: (file: string, args: string[], options: Record<string, unknown>) => {
      execState.calls.push({ file, args, options });
      const outcome = execState.respond?.(args) ?? execState.byCommand.get(args[0]) ?? {};
      if (outcome.error) {
        return Promise.reject(Object.assign(new Error(outcome.error.message), outcome.error));
      }
      return Promise.resolve({ stdout: outcome.stdout ?? '', stderr: '' });
    },
  });
  return { execFile };
});

/** Real `docker ps -a --no-trunc --format '{{json .}}'` output, one JSON object per line. */
const PS_OUTPUT = [
  JSON.stringify({
    ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    Names: 'runova-db-1',
    Image: 'postgres:16-alpine',
    State: 'running',
    Status: 'Up 2 hours',
    Labels:
      'com.docker.compose.project=runova,com.docker.compose.service=db,com.docker.compose.project.working_dir=/home/me/projects/runova',
  }),
  JSON.stringify({
    ID: 'ff00112233445566778899aabbccddeeff00112233445566778899aabbccddee',
    Names: 'runova-cache-1',
    Image: 'redis:7',
    State: 'exited',
    Status: 'Exited (0) 3 days ago',
    Labels:
      'com.docker.compose.project=runova,com.docker.compose.project.working_dir=/home/me/projects/runova',
  }),
  JSON.stringify({
    ID: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    Names: 'lonely-nginx',
    Image: 'nginx:latest',
    State: 'running',
    Status: 'Up 5 minutes',
    Labels: 'maintainer=NGINX Docker Maintainers <docker-maint@nginx.com>',
  }),
].join('\n');

/** Real `docker stats --no-stream --format '{{json .}}'` output. Stopped containers are absent. */
const STATS_OUTPUT = [
  JSON.stringify({
    Container: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    CPUPerc: '0.42%',
    MemUsage: '38.32MiB / 7.653GiB',
  }),
  JSON.stringify({
    Container: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CPUPerc: '12.50%',
    MemUsage: '4.5MB / 2GB',
  }),
].join('\n');

beforeEach(() => {
  execState.calls = [];
  execState.byCommand = new Map();
  execState.respond = null;
});

function argsFor(subcommand: string): string[] | undefined {
  return execState.calls.find((call) => call.args[0] === subcommand)?.args;
}

describe('listContainers', () => {
  beforeEach(() => {
    execState.byCommand.set('ps', { stdout: `${PS_OUTPUT}\n` });
    execState.byCommand.set('stats', { stdout: `${STATS_OUTPUT}\n` });
  });

  it('asks for untruncated IDs so the stats output can be matched back', async () => {
    await listContainers();

    // Without --no-trunc the 12 char ps ID never equals the full stats Container ID.
    expect(argsFor('ps')).toEqual(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    expect(argsFor('stats')).toEqual(['stats', '--no-stream', '--format', '{{json .}}']);
    expect(execState.calls[0].file).toBe('docker');
    expect(execState.calls[0].options.windowsHide).toBe(true);
  });

  it('gives docker stats a longer timeout because it has to sample once', async () => {
    await listContainers();

    const ps = execState.calls.find((call) => call.args[0] === 'ps');
    const stats = execState.calls.find((call) => call.args[0] === 'stats');
    expect(ps?.options.timeout).toBe(10_000);
    expect(stats?.options.timeout).toBe(15_000);
  });

  it('merges ps and stats into one container per line', async () => {
    const containers = await listContainers();

    expect(containers).toHaveLength(3);
    expect(containers[0]).toEqual({
      id: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
      name: 'runova-db-1',
      image: 'postgres:16-alpine',
      state: 'running',
      status: 'Up 2 hours',
      composeProject: 'runova',
      cpuPercent: 0.42,
      // MiB and GiB are binary units, so 38.32MiB is not 38.32 million bytes.
      memUsedBytes: 38.32 * 1024 ** 2,
      memLimitBytes: 7.653 * 1024 ** 3,
    });
  });

  it('parses the decimal unit spelling docker also uses', async () => {
    const containers = await listContainers();

    const nginx = containers.find((one) => one.name === 'lonely-nginx');
    expect(nginx?.memUsedBytes).toBe(4.5 * 1000 ** 2);
    expect(nginx?.memLimitBytes).toBe(2 * 1000 ** 3);
    expect(nginx?.cpuPercent).toBe(12.5);
  });

  it('leaves usage null for a container docker stats did not report', async () => {
    const containers = await listContainers();

    const cache = containers.find((one) => one.name === 'runova-cache-1');
    // A stopped container has no stats line at all, which is not an error.
    expect(cache?.cpuPercent).toBeNull();
    expect(cache?.memUsedBytes).toBeNull();
    expect(cache?.memLimitBytes).toBeNull();
    expect(cache?.state).toBe('exited');
  });

  it('reads the compose project out of the flat label blob', async () => {
    const containers = await listContainers();

    expect(containers[1].composeProject).toBe('runova');
    // A label value may itself contain commas and an equals sign, so a plain split is not enough.
    expect(containers[2].composeProject).toBeNull();
  });

  it('still lists containers when docker stats fails outright', async () => {
    execState.byCommand.set('stats', { error: { message: 'cannot connect' } });

    const containers = await listContainers();

    expect(containers).toHaveLength(3);
    expect(containers[0].cpuPercent).toBeNull();
  });

  it('falls back to exited for a state docker reports that we do not model', async () => {
    execState.byCommand.set('ps', {
      stdout: JSON.stringify({
        ID: 'abc',
        Names: 'odd',
        Image: 'busybox',
        State: 'removing',
        Status: 'Removal in progress',
        Labels: '',
      }),
    });

    const containers = await listContainers();

    expect(containers[0].state).toBe('exited');
  });

  it.each(['running', 'exited', 'paused', 'restarting', 'created', 'dead'])(
    'keeps the known state %s',
    async (state) => {
      execState.byCommand.set('ps', {
        stdout: JSON.stringify({
          ID: 'abc',
          Names: 'x',
          Image: 'busybox',
          State: state.toUpperCase(),
          Status: '',
          Labels: '',
        }),
      });

      const containers = await listContainers();

      expect(containers[0].state).toBe(state);
    },
  );

  it('returns nothing when there are no containers', async () => {
    execState.byCommand.set('ps', { stdout: '\n' });
    execState.byCommand.set('stats', { stdout: '' });

    await expect(listContainers()).resolves.toEqual([]);
  });

  it('leaves memory null when the usage string is not parseable', async () => {
    execState.byCommand.set('ps', {
      stdout: JSON.stringify({
        ID: 'abc',
        Names: 'x',
        Image: 'busybox',
        State: 'running',
        Status: '',
        Labels: '',
      }),
    });
    execState.byCommand.set('stats', {
      stdout: JSON.stringify({ Container: 'abc', CPUPerc: '--', MemUsage: '-- / --' }),
    });

    const containers = await listContainers();

    expect(containers[0].memUsedBytes).toBeNull();
    expect(containers[0].memLimitBytes).toBeNull();
    expect(containers[0].cpuPercent).toBeNaN();
  });
});

describe('listContainersForProject', () => {
  beforeEach(() => {
    execState.byCommand.set('ps', { stdout: PS_OUTPUT });
    execState.byCommand.set('stats', { stdout: STATS_OUTPUT });
  });

  it('returns only the containers compose started in that exact folder', async () => {
    const containers = await listContainersForProject('/home/me/projects/runova');

    expect(containers.map((one) => one.name)).toEqual(['runova-db-1', 'runova-cache-1']);
  });

  it.each([
    '/home/me/projects/runova/',
    '\\home\\me\\projects\\runova',
    '/HOME/ME/Projects/Runova',
  ])('matches %s despite separator, case and trailing slash differences', async (folder) => {
    const containers = await listContainersForProject(folder);

    // The label is written by compose on whichever machine ran it, so the comparison is fuzzy.
    expect(containers).toHaveLength(2);
  });

  it('excludes a container with no compose working dir label', async () => {
    const containers = await listContainersForProject('/home/me/projects/runova');

    // A plain `docker run` container has no reliable link to a folder.
    expect(containers.some((one) => one.name === 'lonely-nginx')).toBe(false);
  });

  it('returns nothing for an unrelated folder', async () => {
    await expect(listContainersForProject('/home/me/projects/other')).resolves.toEqual([]);
  });
});

describe('listRunningContainersForProject', () => {
  beforeEach(() => {
    execState.byCommand.set('ps', { stdout: PS_OUTPUT });
    execState.byCommand.set('stats', { stdout: STATS_OUTPUT });
  });

  it('asks docker for running containers only, without sampling stats', async () => {
    await listRunningContainersForProject('/home/me/projects/runova');

    // `docker stats` waits for a usage sample, which would hold the stop prompt back for seconds.
    expect(argsFor('stats')).toBeUndefined();
    expect(argsFor('ps')).toEqual([
      'ps',
      '--no-trunc',
      '--filter',
      'status=running',
      '--format',
      '{{json .}}',
    ]);
    expect(execState.calls[0].file).toBe('docker');
    expect(execState.calls[0].options.windowsHide).toBe(true);
  });

  it('gives up sooner than the regular listing, so a hung daemon cannot linger', async () => {
    await listRunningContainersForProject('/home/me/projects/runova');

    expect(execState.calls[0].options.timeout).toBe(4_000);
  });

  it('returns only running containers that compose started in that folder', async () => {
    const containers = await listRunningContainersForProject('/home/me/projects/runova');

    // The exited cache container shares the folder but is not using anything; nginx has no folder.
    expect(containers.map((one) => one.name)).toEqual(['runova-db-1']);
  });

  it('leaves usage null because it never asked for stats', async () => {
    const [db] = await listRunningContainersForProject('/home/me/projects/runova');

    expect(db.state).toBe('running');
    expect(db.status).toBe('Up 2 hours');
    expect(db.cpuPercent).toBeNull();
    expect(db.memUsedBytes).toBeNull();
  });

  it.each([
    '/home/me/projects/runova/',
    '\\home\\me\\projects\\runova',
    '/HOME/ME/Projects/Runova',
  ])('matches %s despite separator, case and trailing slash differences', async (folder) => {
    await expect(listRunningContainersForProject(folder)).resolves.toHaveLength(1);
  });

  it('returns nothing for an unrelated folder', async () => {
    await expect(listRunningContainersForProject('/home/me/projects/other')).resolves.toEqual([]);
  });

  it.each([
    ['docker is not installed', { message: 'spawn docker ENOENT' }],
    ['the daemon is not running', { message: 'failed', stderr: 'error during connect' }],
    ['docker ps times out', { message: 'Command failed: timed out' }],
  ])('returns nothing instead of throwing when %s', async (_name, error) => {
    execState.byCommand.set('ps', { error });

    // A project that does not use Docker must never see a prompt or an error about it.
    await expect(listRunningContainersForProject('/home/me/projects/runova')).resolves.toEqual([]);
  });

  it('returns nothing when docker prints something that is not json', async () => {
    execState.byCommand.set('ps', { stdout: 'not json at all' });

    await expect(listRunningContainersForProject('/home/me/projects/runova')).resolves.toEqual([]);
  });
});

describe('isDockerAvailable', () => {
  it('is true when docker version answers', async () => {
    execState.byCommand.set('version', { stdout: '{"Client":{"Version":"27.3.1"}}' });

    await expect(isDockerAvailable()).resolves.toBe(true);
    expect(argsFor('version')).toEqual(['version', '--format', 'json']);
  });

  it('is false when the daemon is not reachable', async () => {
    execState.byCommand.set('version', {
      error: { message: 'error during connect', stderr: 'The system cannot find the file' },
    });

    await expect(isDockerAvailable()).resolves.toBe(false);
  });
});

describe('lifecycle actions', () => {
  it.each([
    ['start', startContainer],
    ['stop', stopContainer],
    ['restart', restartContainer],
  ] as const)('%s passes the id straight through', async (subcommand, action) => {
    await expect(action('deadbeef')).resolves.toEqual({ ok: true });
    expect(argsFor(subcommand)).toEqual([subcommand, 'deadbeef']);
  });

  it.each([
    ['start', startContainer],
    ['stop', stopContainer],
    ['restart', restartContainer],
  ] as const)('%s surfaces docker stderr rather than the spawn message', async (sub, action) => {
    execState.byCommand.set(sub, {
      error: {
        message: 'Command failed: docker start x',
        stderr: `Error response from daemon: No such container: x\n`,
      },
    });

    // The daemon's own wording is what the user can act on.
    await expect(action('x')).resolves.toEqual({
      ok: false,
      error: 'Error response from daemon: No such container: x',
    });
  });

  it('falls back to the error message when stderr is empty', async () => {
    execState.byCommand.set('stop', { error: { message: 'timed out', stderr: '   ' } });

    await expect(stopContainer('x')).resolves.toEqual({ ok: false, error: 'timed out' });
  });
});

describe('removeContainer', () => {
  it('removes the container without volumes or image by default', async () => {
    const result = await removeContainer('c1', { removeVolumes: false, removeImage: false });

    expect(result).toEqual({ ok: true });
    expect(argsFor('rm')).toEqual(['rm', '-f', 'c1']);
    expect(argsFor('inspect')).toBeUndefined();
    expect(argsFor('rmi')).toBeUndefined();
  });

  it('adds -v when volumes are to go too', async () => {
    await removeContainer('c1', { removeVolumes: true, removeImage: false });

    expect(argsFor('rm')).toEqual(['rm', '-f', '-v', 'c1']);
  });

  it('looks the image up before removing the container, since after that it is gone', async () => {
    execState.byCommand.set('inspect', { stdout: 'postgres:16-alpine\n' });

    const result = await removeContainer('c1', { removeVolumes: false, removeImage: true });

    expect(result).toEqual({ ok: true });
    expect(argsFor('inspect')).toEqual(['inspect', '-f', '{{.Config.Image}}', 'c1']);
    expect(argsFor('rmi')).toEqual(['rmi', 'postgres:16-alpine']);
    expect(execState.calls.map((call) => call.args[0])).toEqual(['inspect', 'rm', 'rmi']);
  });

  it('still removes the container when the image lookup fails', async () => {
    execState.byCommand.set('inspect', { error: { message: 'No such object' } });

    await expect(
      removeContainer('c1', { removeVolumes: false, removeImage: true }),
    ).resolves.toEqual({ ok: true });
    expect(argsFor('rmi')).toBeUndefined();
  });

  it('reports success even when the image is still in use elsewhere', async () => {
    execState.byCommand.set('inspect', { stdout: 'redis:7' });
    execState.byCommand.set('rmi', {
      error: { message: 'conflict', stderr: 'image is being used by running container' },
    });

    // The container is gone, which is what was asked for; a shared image is not a failure.
    await expect(
      removeContainer('c1', { removeVolumes: false, removeImage: true }),
    ).resolves.toEqual({ ok: true });
  });

  it('reports the failure when the container itself cannot be removed', async () => {
    execState.byCommand.set('rm', {
      error: { message: 'failed', stderr: 'Error response from daemon: removal in progress' },
    });

    await expect(
      removeContainer('c1', { removeVolumes: false, removeImage: true }),
    ).resolves.toEqual({
      ok: false,
      error: 'Error response from daemon: removal in progress',
    });
    // Removing the image of a container that survived would be destructive.
    expect(argsFor('rmi')).toBeUndefined();
  });
});

describe('sampleDockerActivity', () => {
  const DB_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';

  function psLine(id: string, name: string, image = 'busybox'): string {
    return JSON.stringify({
      ID: id,
      Names: name,
      Image: image,
      State: 'running',
      Status: 'Up 1 minute',
      Labels: '',
    });
  }

  it('reads only running containers and keeps their full ids', async () => {
    execState.byCommand.set('ps', { stdout: `${psLine(DB_ID, 'db', 'postgres:16')}\n` });
    execState.byCommand.set('stats', {
      stdout: `${JSON.stringify({
        Container: DB_ID,
        CPUPerc: '0.42%',
        MemUsage: '38MiB / 7GiB',
        NetIO: '1.5kB / 2.5kB',
        BlockIO: '0B / 1MB',
      })}\n`,
    });

    const sample = await sampleDockerActivity();

    expect(argsFor('ps')).toEqual([
      'ps',
      '--no-trunc',
      '--filter',
      'status=running',
      '--format',
      '{{json .}}',
    ]);
    expect(sample).toEqual({
      available: true,
      containers: [
        {
          id: DB_ID,
          name: 'db',
          image: 'postgres:16',
          cpuPercent: 0.42,
          memBytes: 38 * 1024 ** 2,
          netBytes: 4000,
          blockBytes: 1_000_000,
        },
      ],
    });
  });

  it('uses the short ps timeout, not the stats one', async () => {
    execState.byCommand.set('ps', { stdout: `${psLine(DB_ID, 'db')}\n` });
    await sampleDockerActivity();
    expect(execState.calls.find((call) => call.args[0] === 'ps')?.options.timeout).toBe(4_000);
  });

  it('skips docker stats when nothing is running', async () => {
    execState.byCommand.set('ps', { stdout: '' });

    await expect(sampleDockerActivity()).resolves.toEqual({ available: true, containers: [] });
    expect(argsFor('stats')).toBeUndefined();
  });

  it('reports Docker as unavailable when the CLI or daemon cannot be reached', async () => {
    execState.byCommand.set('ps', { error: { message: 'Cannot connect to the Docker daemon' } });

    await expect(sampleDockerActivity()).resolves.toEqual({ available: false, containers: [] });
  });

  it('leaves every figure null when docker stats fails, so the tracker reads it as unknown', async () => {
    execState.byCommand.set('ps', { stdout: `${psLine(DB_ID, 'db')}\n` });
    execState.byCommand.set('stats', { error: { message: 'timed out' } });

    const sample = await sampleDockerActivity();

    expect(sample.available).toBe(true);
    expect(sample.containers[0]).toMatchObject({
      cpuPercent: null,
      memBytes: null,
      netBytes: null,
      blockBytes: null,
    });
  });

  it('treats a placeholder counter as unreadable rather than as zero', async () => {
    execState.byCommand.set('ps', { stdout: `${psLine(DB_ID, 'db')}\n` });
    execState.byCommand.set('stats', {
      stdout: `${JSON.stringify({
        Container: DB_ID,
        CPUPerc: '--',
        MemUsage: '-- / --',
        NetIO: '--',
        BlockIO: '-- / --',
      })}\n`,
    });

    const sample = await sampleDockerActivity();

    expect(sample.containers[0]).toMatchObject({
      cpuPercent: null,
      memBytes: null,
      netBytes: null,
      blockBytes: null,
    });
  });

  it('leaves out the security scan containers Runova starts itself', async () => {
    execState.byCommand.set('ps', {
      stdout: [psLine('1'.repeat(64), 'runova-scan-ab12-sonar'), psLine(DB_ID, 'db')].join('\n'),
    });

    const sample = await sampleDockerActivity();

    expect(sample.containers.map((one) => one.name)).toEqual(['db']);
  });
});

describe('listImages', () => {
  const NGINX_ID = `sha256:${'a'.repeat(64)}`;
  const NODE_ID = `sha256:${'b'.repeat(64)}`;
  const DANGLING_ID = `sha256:${'c'.repeat(64)}`;

  function imageLine(overrides: Record<string, string>): string {
    return JSON.stringify({
      Containers: 'N/A',
      CreatedAt: '2024-05-01 10:00:00 +0200 CEST',
      CreatedSince: '5 months ago',
      Digest: '<none>',
      ID: NGINX_ID,
      Repository: 'nginx',
      SharedSize: 'N/A',
      Size: '187MB',
      Tag: '1.27',
      UniqueSize: 'N/A',
      VirtualSize: '187MB',
      ...overrides,
    });
  }

  const IMAGE_LS = [
    imageLine({}),
    // A second tag on the same image is its own line in `docker image ls`.
    imageLine({ Tag: 'latest' }),
    imageLine({
      ID: NODE_ID,
      Repository: 'node',
      Tag: '22',
      Size: '1.1GB',
      CreatedAt: '2024-06-10 08:30:00 -0500 CDT',
      CreatedSince: '4 months ago',
    }),
    imageLine({
      ID: DANGLING_ID,
      Repository: '<none>',
      Tag: '<none>',
      Size: '12.5kB',
      CreatedSince: '2 days ago',
    }),
  ].join('\n');

  function answer(containerImages: string[] | null): void {
    execState.respond = (args) => {
      if (args[0] === 'image' && args[1] === 'ls') return { stdout: `${IMAGE_LS}\n` };
      if (args[0] === 'ps') {
        return {
          stdout: containerImages ? containerImages.map((_, i) => `container-${i}`).join('\n') : '',
        };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: `${(containerImages ?? []).join('\n')}\n` };
      }
      return undefined;
    };
  }

  it('asks for untruncated image ids so they match what containers point at', async () => {
    answer(['x']);

    await listImages();

    expect(argsFor('image')).toEqual(['image', 'ls', '--no-trunc', '--format', '{{json .}}']);
    expect(argsFor('ps')).toEqual(['ps', '-a', '-q', '--no-trunc']);
    expect(argsFor('container')).toEqual([
      'container',
      'inspect',
      '--format',
      '{{.Image}}',
      'container-0',
    ]);
  });

  it('folds every tag of one image into a single entry', async () => {
    answer(null);

    const images = await listImages();

    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({
      id: NGINX_ID,
      tags: ['nginx:1.27', 'nginx:latest'],
      dangling: false,
      createdAt: Date.parse('2024-05-01T10:00:00+02:00'),
      createdSince: '5 months ago',
      sizeBytes: 187 * 1000 ** 2,
      containers: 0,
    });
    expect(images[1]).toMatchObject({
      id: NODE_ID,
      tags: ['node:22'],
      createdAt: Date.parse('2024-06-10T08:30:00-05:00'),
      sizeBytes: 1.1 * 1000 ** 3,
    });
  });

  it('marks <none>:<none> images as dangling, with no tags', async () => {
    answer(null);

    const dangling = (await listImages()).find((image) => image.id === DANGLING_ID);

    expect(dangling).toMatchObject({ tags: [], dangling: true, sizeBytes: 12.5 * 1000 });
  });

  it('counts the containers, running or not, that use each image', async () => {
    answer([NGINX_ID, NGINX_ID, NODE_ID]);

    const images = await listImages();

    expect(images.map((image) => image.containers)).toEqual([2, 1, 0]);
  });

  it('skips the inspect call when there are no containers at all', async () => {
    answer(null);

    await listImages();

    expect(argsFor('container')).toBeUndefined();
  });

  it('leaves a date or size it cannot read as null instead of guessing', async () => {
    execState.respond = (args) =>
      args[0] === 'image'
        ? { stdout: imageLine({ CreatedAt: 'sometime', Size: 'N/A' }) }
        : { stdout: '' };

    const [image] = await listImages();

    expect(image.createdAt).toBeNull();
    expect(image.sizeBytes).toBeNull();
  });

  it('throws the docker error when the image list itself fails', async () => {
    execState.respond = (args) =>
      args[0] === 'image'
        ? { error: { message: 'exit 1', stderr: 'Cannot connect to the Docker daemon' } }
        : undefined;

    await expect(listImages()).rejects.toThrow('Cannot connect to the Docker daemon');
  });
});

describe('removeImages', () => {
  it('removes a tagged image by its tags and a dangling one by id, never forcing', async () => {
    const result = await removeImages([
      { id: 'sha256:aaa', tags: ['nginx:1.27', 'nginx:latest'] },
      { id: 'sha256:ccc', tags: [] },
    ]);

    const rmiCalls = execState.calls.filter((call) => call.args[0] === 'rmi');
    expect(rmiCalls.map((call) => call.args)).toEqual([
      ['rmi', 'nginx:1.27', 'nginx:latest'],
      ['rmi', 'sha256:ccc'],
    ]);
    expect(result).toEqual({ removed: ['sha256:aaa', 'sha256:ccc'], failed: [] });
  });

  it('keeps going past a failure and reports it with the docker message', async () => {
    execState.respond = (args) =>
      args[1] === 'base:1'
        ? {
            error: {
              message: 'exit 1',
              stderr: 'Error response from daemon: conflict: image has dependent child images',
            },
          }
        : undefined;

    const result = await removeImages([
      { id: 'sha256:base', tags: ['base:1'] },
      { id: 'sha256:other', tags: ['other:2'] },
    ]);

    expect(result).toEqual({
      removed: ['sha256:other'],
      failed: [
        {
          id: 'sha256:base',
          error: 'Error response from daemon: conflict: image has dependent child images',
        },
      ],
    });
  });

  it('refuses a reference that docker would read as a flag', async () => {
    const result = await removeImages([{ id: 'sha256:aaa', tags: ['-f'] }]);

    expect(execState.calls).toHaveLength(0);
    expect(result.removed).toEqual([]);
    expect(result.failed[0]?.id).toBe('sha256:aaa');
  });
});

describe('pullImage', () => {
  it("pulls with the user's own docker setup when no sign-in is given", async () => {
    const result = await pullImage('hubber/api:1.4');

    expect(result).toEqual({ ok: true });
    expect(execState.calls[0].args).toEqual(['pull', 'hubber/api:1.4']);
    // Pulls of big images take minutes, far past the ten seconds other commands get.
    expect(execState.calls[0].options.timeout).toBe(10 * 60_000);
  });

  it('signs in through a throwaway config so ~/.docker is never touched', async () => {
    let seenConfig: unknown = null;
    let configDir = '';
    execState.respond = (args) => {
      if (args[0] !== '--config') return undefined;
      configDir = args[1];
      seenConfig = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
      return { stdout: '' };
    };

    const result = await pullImage('hubber/private:2', {
      username: 'hubber',
      secret: 'dckr_pat_x',
    });

    expect(result).toEqual({ ok: true });
    expect(execState.calls[0].args).toEqual(['--config', configDir, 'pull', 'hubber/private:2']);
    expect(seenConfig).toEqual({
      auths: {
        'https://index.docker.io/v1/': {
          auth: Buffer.from('hubber:dckr_pat_x').toString('base64'),
        },
      },
    });
    expect(existsSync(configDir)).toBe(false);
  });

  it('cleans the throwaway config up when the pull fails too', async () => {
    let configDir = '';
    execState.respond = (args) => {
      configDir = args[1];
      return { error: { message: 'exit 1', stderr: 'pull access denied' } };
    };

    const result = await pullImage('hubber/private:2', { username: 'hubber', secret: 'x' });

    expect(result).toEqual({ ok: false, error: 'pull access denied' });
    expect(existsSync(configDir)).toBe(false);
  });

  it('refuses a reference that docker would read as a flag', async () => {
    const result = await pullImage('--help');

    expect(result.ok).toBe(false);
    expect(execState.calls).toHaveLength(0);
  });
});
