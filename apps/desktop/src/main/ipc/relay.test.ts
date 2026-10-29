import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type {
  RelayBoard,
  RelayPlannerResult,
  RelaySingleRun,
  RelayTaskDetail,
} from '../../shared/relayTypes';
import { electronState } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { HeadlessPromptResult } from '../cli/headlessPrompt';
import type { RelayRuntime } from '../relay/runtime';

/** The Relay channels: ids in, files read and written by main, run operations to the runtime. */

const cli = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<HeadlessPromptResult>>(),
  cancel: vi.fn(() => true),
}));
const watcher = vi.hoisted(() => ({ watch: vi.fn(), unwatch: vi.fn() }));

vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: cli.run,
  cancelHeadlessPrompt: cli.cancel,
}));
vi.mock('../relay/wiring', () => ({ relayWatcher: () => watcher }));

const userData = useTempUserData();
// The on* channels go main to renderer; the driver tests cover what is sent on them.
expectChannelsCovered(
  IPC.relay,
  Object.entries(IPC.relay)
    .filter(([key]) => key.startsWith('on'))
    .map(([, channel]) => channel),
);

let folder: string;

function runtime(): RelayRuntime {
  return {
    start: vi.fn(async () => ({ ok: false as const, error: 'stub' })),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    markDone: vi.fn(async () => undefined),
    runs: vi.fn(() => []),
    active: vi.fn(() => null),
    reconcile: vi.fn(async () => undefined),
    pendingProposals: vi.fn(() => []),
    decideProposal: vi.fn(async () => null),
  };
}

async function load(live: RelayRuntime | null = runtime()) {
  const module = await loadIpc(
    () => import('./relay'),
    (mod) => mod.registerRelayHandlers(),
  );
  const { setRelayRuntime } = await import('../relay/runtime');
  setRelayRuntime(live);
  return { module, live };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'relay-ipc-'));
  mkdirSync(join(folder, 'docs', 'tasks'), { recursive: true });
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T001-login.md'),
    renderTaskFile({ id: 'T001', title: 'Login', status: 'todo', goal: 'Sign in.' }),
  );
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T002-search.md'),
    renderTaskFile({ id: 'T002', title: 'Search', status: 'todo', depends: ['T001'] }),
  );
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Clinic',
      folderPath: folder,
      cliId: 'claude-code',
      description: '',
      tags: [],
      agentType: 'claude-code',
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  cli.run.mockReset();
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

const taskText = (file: string) => readFileSync(join(folder, 'docs', 'tasks', file), 'utf-8');

describe('the board', () => {
  it('lists the tasks in run order with the settings filled in', async () => {
    await load();
    const board = await invoke<RelayBoard>(IPC.relay.board, 'p1');
    expect(board).toMatchObject({
      projectId: 'p1',
      docsFolder: 'docs',
      exists: true,
      guidePresent: false,
      order: ['T001', 'T002'],
      settings: { docsFolder: 'docs', defaults: { cliId: 'claude-code' } },
      active: null,
    });
    expect(board.tasks.map((task) => [task.id, task.handoff, task.legCount])).toEqual([
      ['T001', null, 0],
      ['T002', null, 0],
    ]);
    expect(board.tasks[0]).not.toHaveProperty('body');
  });

  it('adds up the context each session on a task used, skipping sessions with no reading', async () => {
    await load();
    const { addLegRecord } = await import('../relay/store');
    const record = (legId: string, legNo: number, peakContextTokens: number | null) =>
      addLegRecord('p1', {
        legId,
        relayId: 'r1',
        taskId: 'T001',
        legNo,
        cliId: 'claude-code',
        model: null,
        effort: null,
        tabId: null,
        startedAt: 1,
        endedAt: 2,
        outcome: null,
        tests: null,
        result: 'continue',
        peakContextTokens,
      });
    await record('l1', 1, 120_000);
    await record('l2', 2, null);
    await record('l3', 3, 45_000);
    const board = await invoke<RelayBoard>(IPC.relay.board, 'p1');
    expect(board.tasks.map((task) => [task.id, task.legCount, task.legPeaks])).toEqual([
      ['T001', 3, [120_000, 45_000]],
      ['T002', 0, []],
    ]);
  });

  it('gives one task with its body, and null for one that is not there', async () => {
    await load();
    const detail = await invoke<RelayTaskDetail>(IPC.relay.task, 'p1', 'T001');
    expect(detail.task.body).toContain('Sign in.');
    expect(detail.handoff).toBeNull();
    expect(await invoke(IPC.relay.task, 'p1', 'T404')).toBeNull();
  });

  it('refuses ids that are not ids', async () => {
    await load();
    await expect(invoke(IPC.relay.task, 'p1', '../x')).rejects.toThrow();
    await expect(invoke(IPC.relay.board, 42)).rejects.toThrow();
  });

  it('moves and orders tasks in their files', async () => {
    await load();
    await invoke(IPC.relay.setStatus, 'p1', 'T002', 'testing');
    expect(taskText('T002-search.md')).toContain('status: testing');
    await expect(invoke(IPC.relay.setStatus, 'p1', 'T002', 'finished')).rejects.toThrow();
    await expect(invoke(IPC.relay.setStatus, 'p1', 'T404', 'done')).rejects.toThrow(/board/);
    await invoke(IPC.relay.reorder, 'p1', ['T002', 'T001']);
    expect(taskText('T002-search.md')).toContain('order: 1');
    expect(taskText('T001-login.md')).toContain('order: 2');
  });

  it('writes the guide and keeps the board live while watched', async () => {
    await load();
    await invoke(IPC.relay.ensureGuide, 'p1');
    expect(taskText('RELAY.md')).toContain('# Relay');
    await invoke(IPC.relay.watch, 'p1');
    await invoke(IPC.relay.unwatch, 'p1');
    expect(watcher.watch).toHaveBeenCalledWith('p1');
    expect(watcher.unwatch).toHaveBeenCalledWith('p1');
  });

  it('saves settings', async () => {
    await load();
    const saved = await invoke<{ options: { planFirst: boolean } }>(IPC.relay.saveSettings, 'p1', {
      options: { planFirst: true },
    });
    expect(saved.options.planFirst).toBe(true);
    await expect(
      invoke(IPC.relay.saveSettings, 'p1', { options: { guardShare: 5 } }),
    ).rejects.toThrow();
  });
});

describe('running by hand', () => {
  it('prepares a single run: guide, handoff template, status and a prompt', async () => {
    await load();
    const run = await invoke<RelaySingleRun>(IPC.relay.prepareRun, 'p1', 'T002');
    expect(run).toMatchObject({
      legNo: 1,
      planFirst: false,
      choice: { cliId: 'claude-code', autoSize: false },
    });
    expect(run.prompt).toContain('docs/tasks/handoffs/T001.md');
    expect(taskText('T002-search.md')).toContain('status: in-progress');
    expect(taskText(join('handoffs', 'T002.md'))).toContain('task: T002');
    expect(taskText('RELAY.md')).toContain('# Relay');
  });
});

describe('relays', () => {
  it('hands run operations to the runtime, checked first', async () => {
    const { live } = await load();
    await invoke(IPC.relay.start, { projectId: 'p1', trigger: { kind: 'now' } });
    expect(live?.start).toHaveBeenCalledWith({ projectId: 'p1', trigger: { kind: 'now' } });
    await expect(
      invoke(IPC.relay.start, { projectId: 'p1', trigger: { kind: 'soon' } }),
    ).rejects.toThrow();
    await invoke(IPC.relay.pause, 'r1');
    await invoke(IPC.relay.resume, 'r1');
    await invoke(IPC.relay.cancel, 'r1');
    await invoke(IPC.relay.markDone, 'r1', 'T001');
    expect(await invoke(IPC.relay.runs, 'p1')).toEqual([]);
    await invoke(IPC.relay.reconcile, [{ legId: 'l1', tabId: 't1' }]);
    expect(await invoke(IPC.relay.pendingProposals)).toEqual([]);
    expect(await invoke(IPC.relay.decideProposal, 'x', false)).toBeNull();
    expect(live?.markDone).toHaveBeenCalledWith('r1', 'T001');
    expect(live?.reconcile).toHaveBeenCalledWith([{ legId: 'l1', tabId: 't1' }]);
  });

  it('says Relay is starting before the runtime is up', async () => {
    await load(null);
    await expect(invoke(IPC.relay.pause, 'r1')).rejects.toThrow(/starting/);
  });
});

describe('planning', () => {
  it('decomposes, revises and applies a proposal', async () => {
    await load();
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export', depends: ['T002'] }] }),
      cliName: 'Claude Code',
    });
    const planned = await invoke<RelayPlannerResult>(IPC.relay.decompose, {
      requestId: 'q1',
      projectId: 'p1',
      request: 'Export patients',
    });
    expect(planned).toMatchObject({ ok: true, entries: [{ kind: 'add', id: 'T003' }] });
    expect(
      await invoke<RelayPlannerResult>(IPC.relay.revise, { requestId: 'q2', projectId: 'p1' }),
    ).toMatchObject({ ok: true });
    await invoke(IPC.relay.cancelPlanner, 'q2');
    expect(cli.cancel).toHaveBeenCalledWith('q2');
    if (!planned.ok) throw new Error('planned');
    const applied = await invoke<{ written: string[] }>(
      IPC.relay.applyProposal,
      'p1',
      planned.proposal,
    );
    expect(applied.written).toEqual(['T003-export.md']);
    expect(taskText('T003-export.md')).toContain('depends: [T002]');
  });

  it('tells a user who has moved to another app that the plan is ready', async () => {
    await load();
    electronState.notifications.length = 0;
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export' }] }),
      cliName: 'Claude Code',
    });
    await invoke(IPC.relay.decompose, { requestId: 'q9', projectId: 'p1', request: 'Export' });
    await vi.waitFor(() =>
      expect(JSON.stringify(electronState.notifications)).toContain('Tasks are ready to review'),
    );
  });

  it('catches up a project in progress, and refuses a request without the done choice', async () => {
    await load();
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export', status: 'done' }] }),
      cliName: 'Claude Code',
    });
    const planned = await invoke<RelayPlannerResult>(IPC.relay.catchUp, {
      requestId: 'q3',
      projectId: 'p1',
      recordDone: true,
    });
    expect(planned).toMatchObject({ ok: true, entries: [{ kind: 'add', status: 'done' }] });
    await expect(invoke(IPC.relay.catchUp, { requestId: 'q4', projectId: 'p1' })).rejects.toThrow();
  });
});
