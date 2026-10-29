import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The renderer reaches the local docker CLI only through these channels, so each one has to hand
 * its arguments to the right function and pass the answer back untouched.
 */

const cli = vi.hoisted(() => ({
  isDockerAvailable: vi.fn(),
  listContainers: vi.fn(),
  listContainersForProject: vi.fn(),
  listRunningContainersForProject: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  removeContainer: vi.fn(),
  listImages: vi.fn(),
  removeImages: vi.fn(),
}));

// A process boundary: the real module spawns the docker binary.
vi.mock('../docker/dockerCli', () => cli);

useTempUserData();

expectChannelsCovered(IPC.docker);

beforeEach(async () => {
  for (const fn of Object.values(cli)) fn.mockReset();
  await loadIpc(
    () => import('./docker'),
    (module) => module.registerDockerHandlers(),
  );
});

describe('docker:availability', () => {
  it('reports whether the docker cli answers', async () => {
    cli.isDockerAvailable.mockResolvedValue(true);

    await expect(invoke(IPC.docker.availability)).resolves.toBe(true);
  });
});

describe('docker:list', () => {
  it('returns every container', async () => {
    cli.listContainers.mockResolvedValue([{ id: 'a' }]);

    await expect(invoke(IPC.docker.list)).resolves.toEqual([{ id: 'a' }]);
  });
});

describe('docker:listForProject', () => {
  it('passes the folder through', async () => {
    cli.listContainersForProject.mockResolvedValue([{ id: 'a' }]);

    await expect(invoke(IPC.docker.listForProject, 'E:\\shop')).resolves.toEqual([{ id: 'a' }]);
    expect(cli.listContainersForProject).toHaveBeenCalledWith('E:\\shop');
  });
});

describe('docker:runningForProject', () => {
  it('passes the folder through and returns only what the cli found running', async () => {
    cli.listRunningContainersForProject.mockResolvedValue([{ id: 'db', state: 'running' }]);

    await expect(invoke(IPC.docker.runningForProject, 'E:\\shop')).resolves.toEqual([
      { id: 'db', state: 'running' },
    ]);
    expect(cli.listRunningContainersForProject).toHaveBeenCalledWith('E:\\shop');
    // The full listing samples stats, which is what this channel exists to avoid.
    expect(cli.listContainersForProject).not.toHaveBeenCalled();
  });
});

describe('container lifecycle', () => {
  it.each([
    [IPC.docker.start, cli.startContainer],
    [IPC.docker.stop, cli.stopContainer],
    [IPC.docker.restart, cli.restartContainer],
  ] as const)('%s hands the id over and returns the result', async (channel, action) => {
    action.mockResolvedValue({ ok: true });

    await expect(invoke(channel, 'abc123')).resolves.toEqual({ ok: true });
    expect(action).toHaveBeenCalledWith('abc123');
  });

  it('docker:remove passes the options along', async () => {
    cli.removeContainer.mockResolvedValue({ ok: true });
    const options = { removeVolumes: true, removeImage: false };

    await expect(invoke(IPC.docker.remove, 'abc123', options)).resolves.toEqual({ ok: true });
    expect(cli.removeContainer).toHaveBeenCalledWith('abc123', options);
  });
});

describe('docker:listImages', () => {
  it('returns every image', async () => {
    cli.listImages.mockResolvedValue([{ id: 'sha256:a' }]);

    await expect(invoke(IPC.docker.listImages)).resolves.toEqual([{ id: 'sha256:a' }]);
  });
});

describe('docker:removeImages', () => {
  it('hands the targets over and returns what was removed', async () => {
    const result = { removed: ['sha256:a'], failed: [] };
    cli.removeImages.mockResolvedValue(result);
    const targets = [{ id: 'sha256:a', tags: ['nginx:1.27'] }];

    await expect(invoke(IPC.docker.removeImages, targets)).resolves.toEqual(result);
    expect(cli.removeImages).toHaveBeenCalledWith(targets);
  });

  it('refuses anything that is not a list of image targets', async () => {
    await expect(invoke(IPC.docker.removeImages, [{ id: 7, tags: 'x' }])).rejects.toThrow();
    await expect(invoke(IPC.docker.removeImages, 'sha256:a')).rejects.toThrow();
    expect(cli.removeImages).not.toHaveBeenCalled();
  });
});
