import type { AppNotification, Project } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubWorkflowRunInfo } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import type { PetPipelineMessage } from '../../shared/pet';
import { FakeBrowserWindow } from '../../test/main/electronMock';

/**
 * The watcher is the only thing that turns a red run on GitHub into something the user sees, so
 * the cases that matter are the ones about not crying wolf: never replaying old runs after a
 * restart, never announcing the same run twice, and never speaking for a workflow the user muted.
 */

interface StoreState {
  projects: Project[];
  watch: { lastCompletedRunId: Record<string, number> };
  watchWrites: number;
  notifications: AppNotification[];
  settings: Record<string, unknown>;
}

const state = vi.hoisted(
  () =>
    ({
      projects: [],
      watch: { lastCompletedRunId: {} },
      watchWrites: 0,
      notifications: [],
      settings: {},
    }) as unknown as StoreState,
);

vi.mock('../store', () => ({
  store: {
    getProjects: async () => state.projects,
    getPipelineWatch: async () => state.watch,
    setPipelineWatch: async (next: { lastCompletedRunId: Record<string, number> }) => {
      state.watch = next;
      state.watchWrites += 1;
    },
    getAppNotifications: async () => state.notifications,
    setAppNotifications: async (next: AppNotification[]) => {
      state.notifications = next;
    },
    getSettings: async () => state.settings,
  },
}));

const github = vi.hoisted(() => ({
  githubRepoForFolder: vi.fn(),
  listRepoWorkflows: vi.fn(),
  listRepoRunsByWorkflow: vi.fn(),
  fetchProjectPipelineStatus: vi.fn(),
}));

vi.mock('./githubActions', () => github);

const pet = vi.hoisted(() => ({ messages: [] as PetPipelineMessage[] }));

vi.mock('../pet/petWindow', () => ({
  petManager: {
    sendPipelineMessage: (payload: PetPipelineMessage) => pet.messages.push(payload),
  },
}));

let watcher: typeof import('./watcher');

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    folderPath: '/work/demo',
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Project;
}

function run(overrides: Partial<GithubWorkflowRunInfo> = {}): GithubWorkflowRunInfo {
  return {
    id: 10,
    workflowId: 100,
    name: 'CI',
    displayTitle: 'Fix the flake',
    runNumber: 42,
    headBranch: 'main',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://github.com/acme/demo/actions/runs/10',
    createdAt: '2026-03-15T09:00:00.000Z',
    updatedAt: '2026-03-15T09:10:00.000Z',
    ...overrides,
  };
}

/**
 * Drains the promise chain a tick runs through. `process.nextTick` is not one of the timers the
 * fake clock replaces, so this settles real microtasks without moving the clock forward and
 * triggering another interval tick.
 */
async function settle(turns = 40): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

/** One tick, driven the way the interval does, with everything it awaits settled. */
async function tickOnce(): Promise<void> {
  watcher.startPipelineWatcher();
  await settle();
  watcher.stopPipelineWatcher();
}

function petSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    desktopPetEnabled: true,
    desktopPetPipelineOnFail: true,
    desktopPetPipelineOnPass: true,
    desktopPetCharacterId: 'cat',
    desktopPetCustoms: [],
    desktopPetName: 'Pixel',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  state.projects = [];
  state.watch = { lastCompletedRunId: {} };
  state.watchWrites = 0;
  state.notifications = [];
  state.settings = petSettings();
  pet.messages.length = 0;
  github.githubRepoForFolder.mockReset();
  github.listRepoWorkflows.mockReset();
  github.listRepoRunsByWorkflow.mockReset();
  github.fetchProjectPipelineStatus.mockReset();
  github.githubRepoForFolder.mockResolvedValue({ owner: 'acme', repo: 'demo' });
  github.listRepoWorkflows.mockResolvedValue([
    { id: 100, name: 'CI', path: '.github/workflows/ci.yml' },
  ]);
  github.listRepoRunsByWorkflow.mockResolvedValue(new Map());
  // Module level timer and re-entrancy flags have to start clean for every test.
  vi.resetModules();
  watcher = await import('./watcher');
});

afterEach(() => {
  watcher.stopPipelineWatcher();
  vi.useRealTimers();
});

describe('startPipelineWatcher', () => {
  it('ticks immediately and then on the interval', async () => {
    state.projects = [project()];

    watcher.startPipelineWatcher();
    await settle();
    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);

    // A user should not have to wait for the first interval to see anything.
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();
    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(2);
  });

  it('keeps one interval when started twice', async () => {
    state.projects = [project()];

    watcher.startPipelineWatcher();
    watcher.startPipelineWatcher();
    await settle();
    github.listRepoRunsByWorkflow.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);
    await settle();

    // A second interval would double every API call for the rest of the session.
    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);
  });

  it('stops ticking once it is stopped', async () => {
    state.projects = [project()];

    watcher.startPipelineWatcher();
    await settle();
    watcher.stopPipelineWatcher();
    github.listRepoRunsByWorkflow.mockClear();

    await vi.advanceTimersByTimeAsync(180_000);
    await settle();

    expect(github.listRepoRunsByWorkflow).not.toHaveBeenCalled();
  });

  it('stopping twice is harmless', () => {
    watcher.stopPipelineWatcher();
    expect(() => watcher.stopPipelineWatcher()).not.toThrow();
  });
});

describe('first sighting of a workflow', () => {
  it('records where the workflow stands without announcing anything', async () => {
    state.projects = [project()];
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    // Announcing on the first tick would replay old failures after every app restart.
    expect(state.notifications).toEqual([]);
    expect(pet.messages).toEqual([]);
    expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(10);
    expect(state.watchWrites).toBe(1);
  });

  it('records zero when the workflow has never completed a run', async () => {
    state.projects = [project()];
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, status: 'in_progress', conclusion: null })]]]),
    );

    await tickOnce();

    // Zero, not "unknown", so the next completed run is treated as fresh.
    expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(0);
  });
});

describe('announcing a finished run', () => {
  beforeEach(() => {
    state.projects = [project()];
    state.watch = { lastCompletedRunId: { 'proj-1:100': 9 } };
  });

  it('adds an inbox notification and tells the pet when a run fails', async () => {
    const window = new FakeBrowserWindow();
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      kind: 'pipeline-failure',
      title: 'CI failed',
      body: 'Demo · main · run #42',
      projectId: 'proj-1',
      projectName: 'Demo',
      htmlUrl: 'https://github.com/acme/demo/actions/runs/10',
      read: false,
    });
    // The bell badge only updates when the renderer is told the list changed.
    expect(window.webContents.sentOn(IPC.appNotifications.onChanged)).toHaveLength(1);
    expect(pet.messages).toHaveLength(1);
    expect(pet.messages[0]).toMatchObject({
      kind: 'fail',
      petName: 'Pixel',
      text: 'CI on Demo just failed.',
      projectName: 'Demo',
      workflowName: 'CI',
      // The ref rides along so clicking the bubble opens this run.
      run: { runId: 10, repo: 'acme/demo' },
    });
    expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(10);
  });

  it('files a failure auto-fix already took on as read, and keeps the pet quiet', async () => {
    // Auto-fix tells the user itself when it needs them or gives up, so a second alarm for the
    // same run would only be noise.
    const { setAutoFixClaimer } = await import('./autoFix/claims');
    setAutoFixClaimer((projectId, runId) => projectId === 'proj-1' && runId === 10);
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.notifications[0]).toMatchObject({
      kind: 'pipeline-failure',
      title: 'CI failed',
      body: 'Demo · main · run #42 · Auto-fix is on it',
      read: true,
    });
    expect(pet.messages).toEqual([]);
  });

  it('counts a timed out run as a failure', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'timed_out' })]]]),
    );

    await tickOnce();

    expect(state.notifications).toHaveLength(1);
    expect(pet.messages[0].kind).toBe('fail');
  });

  it('speaks for a pass and files it in the inbox already read', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'success' })]]]),
    );

    await tickOnce();

    // A green run is logged for later but stays out of the unread badge.
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      kind: 'pipeline-success',
      title: 'CI passed',
      read: true,
    });
    expect(pet.messages).toHaveLength(1);
    expect(pet.messages[0]).toMatchObject({ kind: 'pass', text: 'CI on Demo passed.' });
    expect(pet.messages[0].run).toBeUndefined();
  });

  it.each(['cancelled', 'skipped', 'neutral', 'stale', 'action_required'] as const)(
    'says nothing about a %s run',
    async (conclusion) => {
      github.listRepoRunsByWorkflow.mockResolvedValue(
        new Map([[100, [run({ id: 10, conclusion })]]]),
      );

      await tickOnce();

      expect(state.notifications).toEqual([]);
      expect(pet.messages).toEqual([]);
      // The mark still moves, so the run is not reconsidered next tick.
      expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(10);
    },
  );

  it('announces several new runs oldest first and marks the newest', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([
        [
          100,
          [
            run({ id: 12, conclusion: 'failure', htmlUrl: 'https://example.invalid/12' }),
            run({ id: 11, conclusion: 'success' }),
            // Already seen, so it must not be announced again.
            run({ id: 9, conclusion: 'failure', htmlUrl: 'https://example.invalid/9' }),
          ],
        ],
      ]),
    );

    await tickOnce();

    expect(pet.messages.map((message) => message.kind)).toEqual(['pass', 'fail']);
    // Oldest first in, so the newest ends up on top of the inbox.
    expect(state.notifications.map((item) => item.kind)).toEqual([
      'pipeline-failure',
      'pipeline-success',
    ]);
    expect(state.notifications[0].htmlUrl).toBe('https://example.invalid/12');
    expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(12);
  });

  it('ignores runs that are still going', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([
        [
          100,
          [
            run({ id: 11, status: 'in_progress', conclusion: null }),
            run({ id: 10, conclusion: 'failure' }),
          ],
        ],
      ]),
    );

    await tickOnce();

    expect(state.notifications).toHaveLength(1);
    // The in-flight run keeps its turn for a later tick.
    expect(state.watch.lastCompletedRunId['proj-1:100']).toBe(10);
  });

  it('writes nothing when there is nothing new', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 9, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.watchWrites).toBe(0);
    expect(state.notifications).toEqual([]);
  });

  it('does not add a second notification for a run already in the inbox', async () => {
    state.notifications = [
      {
        id: 'existing',
        kind: 'pipeline-failure',
        title: 'CI failed',
        body: 'old',
        htmlUrl: 'https://github.com/acme/demo/actions/runs/10',
        createdAt: '2026-03-01T00:00:00.000Z',
        read: true,
      } as unknown as AppNotification,
    ];
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    // Restoring a backup or re-adding a project must not duplicate the inbox.
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].id).toBe('existing');
  });

  it('caps the inbox so it cannot grow without bound', async () => {
    state.notifications = Array.from({ length: 200 }, (_item, index) => ({
      id: `old-${index}`,
      kind: 'pipeline-failure',
      title: 'CI failed',
      body: 'old',
      htmlUrl: `https://example.invalid/old-${index}`,
      createdAt: '2026-03-01T00:00:00.000Z',
      read: true,
    })) as unknown as AppNotification[];
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.notifications).toHaveLength(200);
    // Newest first, so the fresh failure is the one at the top.
    expect(state.notifications[0].htmlUrl).toBe('https://github.com/acme/demo/actions/runs/10');
    expect(state.notifications.some((item) => item.id === 'old-199')).toBe(false);
  });

  it('falls back to the run name when the workflow has none', async () => {
    github.listRepoWorkflows.mockResolvedValue([{ id: 100, name: '', path: 'ci.yml' }]);
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure', name: 'Nightly' })]]]),
    );

    await tickOnce();

    expect(state.notifications[0].title).toBe('Nightly failed');
  });

  it('names the branch as unknown when the run has none', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure', headBranch: '' })]]]),
    );

    await tickOnce();

    expect(state.notifications[0].body).toBe('Demo · unknown branch · run #42');
  });
});

describe('pet settings', () => {
  beforeEach(() => {
    state.projects = [project()];
    state.watch = { lastCompletedRunId: { 'proj-1:100': 9 } };
  });

  it('stays quiet when the pet is switched off entirely', async () => {
    state.settings = petSettings({ desktopPetEnabled: false });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(pet.messages).toEqual([]);
    // The inbox notification is not a pet feature, so it still lands.
    expect(state.notifications).toHaveLength(1);
  });

  it('honours the per-outcome switches', async () => {
    state.settings = petSettings({ desktopPetPipelineOnFail: false });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([
        [100, [run({ id: 11, conclusion: 'success' }), run({ id: 10, conclusion: 'failure' })]],
      ]),
    );

    await tickOnce();

    expect(pet.messages.map((message) => message.kind)).toEqual(['pass']);
  });

  it('keeps a failure out of the inbox when failure notices are off, but the pet still speaks', async () => {
    const window = new FakeBrowserWindow();
    state.settings = petSettings({ pipelineFailureNotify: false });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.notifications).toEqual([]);
    expect(window.webContents.sentOn(IPC.appNotifications.onChanged)).toHaveLength(0);
    expect(pet.messages.map((message) => message.kind)).toEqual(['fail']);
  });

  it('still logs a pass when failure notices are off', async () => {
    state.settings = petSettings({ pipelineFailureNotify: false });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'success' })]]]),
    );

    await tickOnce();

    // The switch is about failures, a green run keeps its read entry.
    expect(state.notifications.map((item) => item.kind)).toEqual(['pipeline-success']);
  });

  it('sends the failure without a run to open when clicking should not open it', async () => {
    state.settings = petSettings({ pipelineFailureOpen: 'none' });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    // No ref means the bubble is not a link, and the notice itself is unaffected.
    expect(pet.messages).toHaveLength(1);
    expect(pet.messages[0].run).toBeUndefined();
    expect(state.notifications).toHaveLength(1);
  });

  it("points the bubble at the project's workspace when that is where clicks should go", async () => {
    state.settings = petSettings({ pipelineFailureOpen: 'workspace' });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(pet.messages[0].run).toEqual({
      runId: 10,
      repo: 'acme/demo',
      workspaceProjectId: 'proj-1',
    });
  });

  it('keeps the Pipelines page when the setting names it', async () => {
    state.settings = petSettings({ pipelineFailureOpen: 'pipelines' });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(pet.messages[0].run).toEqual({ runId: 10, repo: 'acme/demo' });
  });

  it('treats a profile with neither new setting as having both on', async () => {
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    expect(state.notifications).toHaveLength(1);
    expect(pet.messages[0].run).toEqual({ runId: 10, repo: 'acme/demo' });
  });

  it('uses the built-in character name when there is no nickname', async () => {
    state.settings = petSettings({ desktopPetName: '', desktopPetCharacterId: 'unknown-id' });
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'success' })]]]),
    );

    await tickOnce();

    expect(pet.messages[0].petName).toBe('Your pet');
  });
});

describe('which projects and workflows are watched', () => {
  it('skips archived projects', async () => {
    state.projects = [project({ archived: true })];

    await tickOnce();

    expect(github.githubRepoForFolder).not.toHaveBeenCalled();
  });

  it('skips a project with no GitHub remote', async () => {
    state.projects = [project()];
    github.githubRepoForFolder.mockResolvedValue(null);

    await tickOnce();

    expect(github.listRepoWorkflows).not.toHaveBeenCalled();
  });

  it('skips a muted workflow', async () => {
    state.projects = [
      project({ githubActionsMuted: [{ workflowId: 100, path: 'ci.yml', name: 'CI' }] }),
    ];
    state.watch = { lastCompletedRunId: { 'proj-1:100': 9 } };
    github.listRepoRunsByWorkflow.mockResolvedValue(
      new Map([[100, [run({ id: 10, conclusion: 'failure' })]]]),
    );

    await tickOnce();

    // Muting is the user asking not to hear about this workflow at all.
    expect(state.notifications).toEqual([]);
    expect(pet.messages).toEqual([]);
    expect(github.listRepoRunsByWorkflow).not.toHaveBeenCalled();
  });

  it('reads a repo shared by two projects only once per tick', async () => {
    state.projects = [
      project({ id: 'a', name: 'A', folderPath: '/work/a' }),
      project({ id: 'b', name: 'B', folderPath: '/work/b' }),
    ];
    github.githubRepoForFolder.mockResolvedValue({ owner: 'ACME', repo: 'Demo' });

    await tickOnce();

    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);
    // Both projects still get their own watch entry.
    expect(Object.keys(state.watch.lastCompletedRunId).sort()).toEqual(['a:100', 'b:100']);
  });

  it('keeps going when one repo cannot be read', async () => {
    state.projects = [
      project({ id: 'a', name: 'A', folderPath: '/work/a' }),
      project({ id: 'b', name: 'B', folderPath: '/work/b' }),
    ];
    github.listRepoWorkflows.mockImplementation(async (owner: string) => {
      if (owner === 'broken') throw new Error('HTTP 403: rate limited');
      return [{ id: 100, name: 'CI', path: 'ci.yml' }];
    });
    github.githubRepoForFolder.mockImplementation(async (folder: string) =>
      folder === '/work/a' ? { owner: 'broken', repo: 'demo' } : { owner: 'acme', repo: 'demo' },
    );

    await tickOnce();

    // One rate limited repo must not silence every other project.
    expect(state.watch.lastCompletedRunId).toEqual({ 'b:100': 0 });
  });
});

describe('forgetWatchedWorkflows', () => {
  it('drops the marks for the workflows it is given', async () => {
    state.watch = {
      lastCompletedRunId: { 'proj-1:100': 10, 'proj-1:200': 20, 'proj-2:100': 30 },
    };

    await watcher.forgetWatchedWorkflows('proj-1', [100]);

    // Switching a workflow back on should report from now, not replay the gap.
    expect(state.watch.lastCompletedRunId).toEqual({ 'proj-1:200': 20, 'proj-2:100': 30 });
    expect(state.watchWrites).toBe(1);
  });

  it('writes nothing for an empty list', async () => {
    await watcher.forgetWatchedWorkflows('proj-1', []);
    expect(state.watchWrites).toBe(0);
  });
});

describe('schedulePipelineCheck', () => {
  it('runs a tick for a project that exists', async () => {
    state.projects = [project()];

    watcher.schedulePipelineCheck('proj-1');
    await settle();

    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a project that is gone', async () => {
    state.projects = [project()];

    watcher.schedulePipelineCheck('deleted-id');
    await settle();

    expect(github.githubRepoForFolder).not.toHaveBeenCalled();
  });

  it('runs a tick when no project is named', async () => {
    state.projects = [project()];

    watcher.schedulePipelineCheck();
    await settle();

    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('refreshProjectPipelineStatus', () => {
  it('reports the status of one project', async () => {
    state.projects = [project()];
    github.fetchProjectPipelineStatus.mockResolvedValue({ projectId: 'proj-1', workflows: [] });

    await expect(watcher.refreshProjectPipelineStatus('proj-1')).resolves.toEqual({
      projectId: 'proj-1',
      workflows: [],
    });
    expect(github.fetchProjectPipelineStatus).toHaveBeenCalledWith(state.projects[0]);
  });

  it('throws for a project that is not there', async () => {
    state.projects = [];
    await expect(watcher.refreshProjectPipelineStatus('ghost')).rejects.toThrow(
      'Project ghost not found',
    );
  });
});

describe('schedulePipelineCheck', () => {
  it('runs again when asked while a tick is already going', async () => {
    // Two projects tagged at once: each push asks for a check. The second request lands while
    // the first check is still reading GitHub, from before the second tag's run existed.
    state.projects = [
      project({ id: 'proj-1', folderPath: '/work/one' }),
      project({ id: 'proj-2', folderPath: '/work/two' }),
    ];
    github.githubRepoForFolder.mockImplementation(async (folder: string) =>
      folder === '/work/one' ? { owner: 'acme', repo: 'one' } : { owner: 'acme', repo: 'two' },
    );
    let releaseFirst!: (runs: Map<number, GithubWorkflowRunInfo[]>) => void;
    github.listRepoRunsByWorkflow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );

    watcher.schedulePipelineCheck('proj-1');
    await settle();
    watcher.schedulePipelineCheck('proj-2');
    await settle();
    // Still stuck on the first repo of the first check.
    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(1);

    releaseFirst(new Map());
    await settle(80);

    // The first check finishes both repos, then the queued one reads both again.
    const repos = github.listRepoRunsByWorkflow.mock.calls.map((call) => call[1]);
    expect(repos).toEqual(['one', 'two', 'one', 'two']);
  });

  it('folds several requests made during one tick into a single rerun', async () => {
    state.projects = [project()];
    let releaseFirst!: (runs: Map<number, GithubWorkflowRunInfo[]>) => void;
    github.listRepoRunsByWorkflow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );

    watcher.schedulePipelineCheck();
    await settle();
    watcher.schedulePipelineCheck();
    watcher.schedulePipelineCheck();
    watcher.schedulePipelineCheck();
    await settle();

    releaseFirst(new Map());
    await settle(80);

    expect(github.listRepoRunsByWorkflow).toHaveBeenCalledTimes(2);
  });
});
