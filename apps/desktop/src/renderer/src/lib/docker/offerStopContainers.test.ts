import type { DockerContainer } from '@shared/apiTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { queryClient } from '../../queryClient';
import {
  dismissStopContainers,
  resolveStopContainers,
  useStopContainersPromptStore,
} from '../../stores/stopContainersPromptStore';
import { queryKeys } from '../queryKeys';
import { offerStopContainers } from './offerStopContainers';

const toast = vi.hoisted(() => ({
  loading: vi.fn(() => 'toast-1'),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * After a run is stopped, anything its project still has running in Docker is offered for
 * stopping. The run itself is already gone by then, so every path here must stay quiet when there
 * is nothing to say: no Docker, no containers, or a setting that says never.
 */

function container(id: string, over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id,
    name: `${id}-1`,
    image: 'postgres:16',
    state: 'running',
    status: 'Up 2 hours',
    composeProject: 'shop',
    cpuPercent: null,
    memUsedBytes: null,
    memLimitBytes: null,
    ...over,
  };
}

const DB = container('db');
const CACHE = container('cache', { image: 'redis:7' });

type Mode = 'ask' | 'stop' | 'keep';

interface Setup {
  mode?: Mode;
  /** Containers per project folder. A folder that is not listed has nothing running. */
  running?: Record<string, DockerContainer[] | Error>;
  stop?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  settingsGet?: () => Promise<unknown>;
}

let runningForProject: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let settingsUpdate: ReturnType<typeof vi.fn>;

function setup({ mode = 'ask', running = {}, stop: stopImpl, settingsGet }: Setup = {}): void {
  runningForProject = vi.fn(async (folder: string) => {
    const found = running[folder];
    if (found instanceof Error) throw found;
    return found ?? [];
  });
  stop = vi.fn(stopImpl ?? (async () => ({ ok: true })));
  settingsUpdate = vi.fn(async () => undefined);
  installRunovaBridge({
    'settings.get': settingsGet ?? (async () => ({ stopDockerWithRun: mode })),
    'settings.update': settingsUpdate,
    'docker.runningForProject': runningForProject,
    'docker.stop': stop,
  });
}

function promptState() {
  return useStopContainersPromptStore.getState();
}

async function promptOpens(): Promise<void> {
  await vi.waitFor(() => expect(promptState().open).toBe(true));
}

beforeEach(() => {
  dismissStopContainers();
  for (const fn of Object.values(toast)) fn.mockClear();
  setup();
});

describe('when there is nothing to ask', () => {
  it('does not touch Docker for a run that has no folder', async () => {
    await offerStopContainers([{ title: 'Web Shop' }]);

    expect(runningForProject).not.toHaveBeenCalled();
    expect(promptState().open).toBe(false);
  });

  it('does nothing at all for an empty list', async () => {
    await offerStopContainers([]);

    expect(runningForProject).not.toHaveBeenCalled();
  });

  it('does not even look at Docker when the setting says never stop them', async () => {
    setup({ mode: 'keep', running: { 'E:\\shop': [DB] } });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(runningForProject).not.toHaveBeenCalled();
    expect(promptState().open).toBe(false);
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it('stays silent when the project has no running containers', async () => {
    setup({ running: { 'E:\\shop': [] } });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(runningForProject).toHaveBeenCalledWith('E:\\shop');
    expect(promptState().open).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays silent when looking up containers fails', async () => {
    setup({ running: { 'E:\\shop': new Error('ipc went away') } });

    await expect(
      offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]),
    ).resolves.toBeUndefined();

    expect(promptState().open).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('asks when the setting cannot be read, since asking is the safe default', async () => {
    setup({
      settingsGet: async () => {
        throw new Error('settings unavailable');
      },
      running: { 'E:\\shop': [DB] },
    });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    dismissStopContainers();
    await done;

    expect(stop).not.toHaveBeenCalled();
  });
});

describe('when the setting is to ask', () => {
  it('opens the dialog with the running containers and the project name', async () => {
    setup({ running: { 'E:\\shop': [DB, CACHE] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();

    expect(promptState().projects).toEqual(['Web Shop']);
    expect(promptState().containers.map((one) => one.id)).toEqual(['db', 'cache']);
    // Nothing is stopped until the user says so.
    expect(stop).not.toHaveBeenCalled();

    dismissStopContainers();
    await done;
  });

  it('stops exactly the containers the user left selected, with progress as a toast', async () => {
    setup({ running: { 'E:\\shop': [DB, CACHE] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: ['cache'], remember: false });
    await done;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('cache');
    expect(toast.loading).toHaveBeenCalledWith('Stopping 1 container…');
    expect(toast.success).toHaveBeenCalledWith('Stopped 1 container.', { id: 'toast-1' });
  });

  it('keeps everything running when the user keeps them', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: [], remember: false });
    await done;

    expect(stop).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('asks once for runs that share a folder, and once for a container found twice', async () => {
    setup({ running: { 'E:\\shop': [DB], 'E:\\shop-admin': [DB, CACHE] } });

    const done = offerStopContainers([
      { cwd: 'E:\\shop', title: 'Web Shop' },
      { cwd: 'E:\\shop', title: 'Web Shop' },
      { cwd: 'E:\\shop-admin', title: 'Admin' },
    ]);
    await promptOpens();

    expect(runningForProject).toHaveBeenCalledTimes(2);
    expect(promptState().projects).toEqual(['Web Shop', 'Admin']);
    expect(promptState().containers.map((one) => one.id)).toEqual(['db', 'cache']);

    dismissStopContainers();
    await done;
  });

  it('only names the projects that actually have containers running', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([
      { cwd: 'E:\\shop', title: 'Web Shop' },
      { cwd: 'E:\\docs', title: 'Docs' },
    ]);
    await promptOpens();

    expect(promptState().projects).toEqual(['Web Shop']);

    dismissStopContainers();
    await done;
  });

  it('keeps going when one folder cannot be looked up', async () => {
    setup({ running: { 'E:\\shop': new Error('boom'), 'E:\\shop-admin': [CACHE] } });

    const done = offerStopContainers([
      { cwd: 'E:\\shop', title: 'Web Shop' },
      { cwd: 'E:\\shop-admin', title: 'Admin' },
    ]);
    await promptOpens();

    expect(promptState().containers.map((one) => one.id)).toEqual(['cache']);

    dismissStopContainers();
    await done;
  });
});

describe('remembering the answer', () => {
  it('saves "always stop" when the user stops them and ticks remember', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: ['db'], remember: true });
    await done;

    expect(settingsUpdate).toHaveBeenCalledWith({ stopDockerWithRun: 'stop' });
  });

  it('saves "never stop" when the user keeps them and ticks remember', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: [], remember: true });
    await done;

    expect(settingsUpdate).toHaveBeenCalledWith({ stopDockerWithRun: 'keep' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('saves nothing when remember was not ticked', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: ['db'], remember: false });
    await done;

    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('saves nothing when the dialog is dismissed', async () => {
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    dismissStopContainers();
    await done;

    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('refreshes the settings cache so the Settings page shows the saved choice', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    setup({ running: { 'E:\\shop': [DB] } });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await promptOpens();
    resolveStopContainers({ stopIds: ['db'], remember: true });
    await done;

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
    invalidate.mockRestore();
  });
});

describe('when the setting is to always stop', () => {
  it('stops everything without asking', async () => {
    setup({ mode: 'stop', running: { 'E:\\shop': [DB, CACHE] } });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(promptState().open).toBe(false);
    expect(stop).toHaveBeenCalledWith('db');
    expect(stop).toHaveBeenCalledWith('cache');
    expect(toast.loading).toHaveBeenCalledWith('Stopping 2 containers…');
    expect(toast.success).toHaveBeenCalledWith('Stopped 2 containers.', { id: 'toast-1' });
  });
});

describe('stopping', () => {
  it('stops the containers side by side rather than one after another', async () => {
    const release: Array<() => void> = [];
    setup({
      mode: 'stop',
      running: { 'E:\\shop': [DB, CACHE] },
      stop: () => new Promise((resolve) => release.push(() => resolve({ ok: true }))),
    });

    const done = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    // A graceful docker stop can take ~10s, so waiting for the first would double the wait.
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));

    for (const resolve of release) resolve();
    await done;
  });

  it('reports how many failed instead of claiming success', async () => {
    setup({
      mode: 'stop',
      running: { 'E:\\shop': [DB, CACHE] },
      stop: async (id) => (id === 'db' ? { ok: false, error: 'busy' } : { ok: true }),
    });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(toast.error).toHaveBeenCalledWith('1 of 2 containers failed to stop.', {
      id: 'toast-1',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('counts a rejected call as a failure rather than leaving the toast spinning', async () => {
    setup({
      mode: 'stop',
      running: { 'E:\\shop': [DB] },
      stop: async () => {
        throw new Error('ipc went away');
      },
    });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(toast.error).toHaveBeenCalledWith('The container failed to stop.', { id: 'toast-1' });
  });

  it('refreshes the docker lists afterwards so the Docker tab and status bar catch up', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    setup({ mode: 'stop', running: { 'E:\\shop': [DB] } });

    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.dockerList });
    invalidate.mockRestore();
  });

  it('does not offer a container that is already on its way down', async () => {
    let finish: () => void = () => undefined;
    setup({
      mode: 'stop',
      running: { 'E:\\shop': [DB] },
      stop: () => new Promise((resolve) => (finish = () => resolve({ ok: true }))),
    });
    const first = offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    // docker still lists it as running until the stop completes, so a second run stopping
    // right now must not ask about it again or stop it twice.
    await offerStopContainers([{ cwd: 'E:\\shop', title: 'Web Shop' }]);

    expect(stop).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
