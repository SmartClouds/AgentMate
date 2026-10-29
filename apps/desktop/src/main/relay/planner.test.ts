import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { HeadlessPromptResult } from '../cli/headlessPrompt';

const cli = vi.hoisted(() => ({
  run: vi.fn<
    (prompt: string, cwd: string, options: Record<string, unknown>) => Promise<HeadlessPromptResult>
  >(),
  cancel: vi.fn(() => true),
}));

vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: cli.run,
  cancelHeadlessPrompt: cli.cancel,
}));

const userData = useTempUserData();
let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'relay-planner-'));
  mkdirSync(join(folder, 'docs', 'tasks'), { recursive: true });
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T001-login.md'),
    renderTaskFile({ id: 'T001', title: 'Login', status: 'done' }),
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

const ANSWER = JSON.stringify({
  summary: 'Search.',
  add: [{ id: 'T002', title: 'Search', depends: ['T001'], estimate: '90k' }],
});

describe('timeouts', () => {
  it('gives a long plan an hour, and a catch-up longer, before it is stopped', async () => {
    const { CATCH_UP_TIMEOUT_MS, PLANNER_TIMEOUT_MS } = await import('./planner');
    expect(PLANNER_TIMEOUT_MS).toBe(60 * 60_000);
    expect(CATCH_UP_TIMEOUT_MS).toBe(90 * 60_000);
  });

  it('runs a split with the planner timeout', async () => {
    cli.run.mockResolvedValue({ ok: true, text: ANSWER, cliName: 'Claude Code' });
    const { decomposeRequest, PLANNER_TIMEOUT_MS } = await import('./planner');
    await decomposeRequest({ requestId: 'r0', projectId: 'p1', request: 'x' });
    expect(cli.run.mock.calls[0][2]).toMatchObject({ timeoutMs: PLANNER_TIMEOUT_MS });
  });
});

describe('decomposeRequest', () => {
  it('runs the planner in the project, read-only, with the chosen model', async () => {
    cli.run.mockResolvedValue({ ok: true, text: `Plan:\n${ANSWER}`, cliName: 'Claude Code' });
    const { decomposeRequest } = await import('./planner');
    const result = await decomposeRequest({
      requestId: 'r1',
      projectId: 'p1',
      request: 'Add patient search',
      cliId: 'claude-code',
      model: 'opus',
      effort: 'high',
      budget: 200_000,
    });
    const [prompt, cwd, options] = cli.run.mock.calls[0];
    expect(cwd).toBe(folder);
    expect(prompt).toContain('Add patient search');
    expect(prompt).toContain('T002');
    expect(prompt).toContain('T001 Login (done)');
    expect(options).toMatchObject({
      requestId: 'r1',
      preferredCliId: 'claude-code',
      strictCli: true,
      runArgs: ['--model', 'opus', '--effort', 'high'],
    });
    expect(options).not.toHaveProperty('allowWrites');
    expect(result).toMatchObject({
      ok: true,
      cliName: 'Claude Code',
      entries: [{ kind: 'add', id: 'T002', title: 'Search' }],
    });
  });

  it('passes on a failure, and explains an answer that is not a plan', async () => {
    const { decomposeRequest } = await import('./planner');
    cli.run.mockResolvedValueOnce({ ok: false, text: '', cliName: null, error: 'No CLI.' });
    expect(await decomposeRequest({ requestId: 'r2', projectId: 'p1', request: 'x' })).toEqual({
      ok: false,
      error: 'No CLI.',
      cancelled: undefined,
    });
    cli.run.mockResolvedValueOnce({ ok: true, text: 'Sorry.', cliName: 'Codex' });
    const failed = await decomposeRequest({ requestId: 'r3', projectId: 'p1', request: 'x' });
    expect(failed).toEqual({ ok: false, error: expect.stringMatching(/^Codex answered, but/) });
    expect(cli.run.mock.calls[0][2]).toMatchObject({ strictCli: false, runArgs: [] });
  });
});

describe('reviseBoard', () => {
  it('lists the board and passes the note', async () => {
    cli.run.mockResolvedValue({ ok: true, text: '{"summary":"none"}', cliName: 'Claude Code' });
    const { reviseBoard, cancelPlanner } = await import('./planner');
    const result = await reviseBoard({ requestId: 'r4', projectId: 'p1', note: 'Add archive.' });
    expect(cli.run.mock.calls[0][0]).toContain('T001 Login [done]');
    expect(cli.run.mock.calls[0][0]).toContain('Add archive.');
    expect(result).toMatchObject({ ok: true, entries: [] });
    cancelPlanner('r4');
    expect(cli.cancel).toHaveBeenCalledWith('r4');
  });
});

describe('catchUpBoard', () => {
  it('asks where the project stands, with the board, the note and a longer timeout', async () => {
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        summary: 'Login is done; search is half built.',
        add: [{ title: 'Search', handoff: { done: 'The API.', next: 'The page.' } }],
      }),
      cliName: 'Claude Code',
    });
    const { catchUpBoard, PLANNER_TIMEOUT_MS } = await import('./planner');
    const result = await catchUpBoard({
      requestId: 'r5',
      projectId: 'p1',
      recordDone: false,
      note: 'The plan is in docs/ROADMAP.md.',
    });
    const [prompt, cwd, options] = cli.run.mock.calls[0];
    expect(cwd).toBe(folder);
    expect(prompt).toContain('T001 Login [done]');
    expect(prompt).toContain('The plan is in docs/ROADMAP.md.');
    expect(prompt).toMatch(/do not add tasks for finished work/i);
    expect(prompt).toContain('T002');
    expect(options.timeoutMs).toBeGreaterThan(PLANNER_TIMEOUT_MS);
    expect(options).not.toHaveProperty('allowWrites');
    expect(result).toMatchObject({
      ok: true,
      entries: [{ kind: 'add', id: 'T002', title: 'Search', handoff: true }],
    });
  });
});
