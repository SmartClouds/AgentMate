import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestDiscovery, TestRunEvent, TestRunSnapshot, TestRunSummary } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';

/**
 * The Tests panel IPC surface with a real project folder, real discovery and a real (fake runner)
 * process. Only Electron and the project store are stubbed.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const sent: { channel: string; payload: unknown }[] = [];
const projects: { id: string; folderPath: string }[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}));
vi.mock('../store', () => ({ store: { getProjects: async () => projects } }));
vi.mock('../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

const { seedWorkspace, waitFor } = await import('../tests/fakeRunners');

let root = '';

async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler({}, ...args)) as T;
}

const runEvents = (): TestRunEvent[] =>
  sent
    .filter((entry) => entry.channel === IPC.tests.onRunEvent)
    .map((entry) => entry.payload as TestRunEvent);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runova-ipc-tests-'));
  await seedWorkspace(root);
  projects.splice(0, projects.length, { id: 'p1', folderPath: root });
  process.env.FAKE_ARGS_LOG = join(root, 'args.log');
  delete process.env.FAKE_VITEST_MODE;
  handlers.clear();
  sent.length = 0;
  vi.resetModules();
  const { registerTestHandlers } = await import('./tests');
  registerTestHandlers();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('tests IPC', () => {
  it('discovers the tests in a project folder', async () => {
    const discovery = await ipc<TestDiscovery>(IPC.tests.discover, 'p1');
    expect(discovery.projects.map((project) => project.id)).toEqual(['go:svc', 'vitest:web']);
    await expect(ipc(IPC.tests.discover, 'missing')).rejects.toThrow(/not found/);
  });

  it('runs tests, broadcasts events to every window and keeps the last run', async () => {
    expect(await ipc<TestRunSnapshot | null>(IPC.tests.lastRun, 'p1')).toBeNull();
    const summary = await ipc<TestRunSummary>(IPC.tests.run, 'p1', [
      { testProjectId: 'vitest:web' },
    ]);
    expect(summary).toMatchObject({ projectId: 'p1', running: true });

    await waitFor(() => runEvents().some((event) => event.type === 'done'), 30_000);
    expect(runEvents()[0]).toMatchObject({
      type: 'started',
      projectId: 'p1',
      runId: summary.runId,
    });

    const snapshot = await ipc<TestRunSnapshot>(IPC.tests.lastRun, 'p1');
    expect(snapshot.summary).toMatchObject({ running: false, passed: 1, failed: 1 });
    expect(await ipc<boolean>(IPC.tests.cancel, 'p1')).toBe(false);
  }, 60_000);

  it('drops picks that are not in the discovered tests and refuses a run with nothing left', async () => {
    await ipc(IPC.tests.discover, 'p1');
    await expect(
      ipc(IPC.tests.run, 'p1', [
        { testProjectId: 'vitest:web', files: ['../../outside.test.ts'] },
        { testProjectId: 'made:up' },
      ]),
    ).rejects.toThrow(/Nothing to run/);
    await expect(ipc(IPC.tests.run, 'p1', 'not an array')).rejects.toThrow(/Nothing to run/);
  });

  it('describes the command for one test', async () => {
    const command = await ipc<string | null>(IPC.tests.command, 'p1', {
      testProjectId: 'go:svc',
      tests: [{ file: 'svc/calc/calc_test.go', path: ['TestAdd'] }],
    });
    expect(command).toBe("go test -run '^(?:TestAdd)$' ./calc");
  });
});
