import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayDriver } from '../service';
import { handleRelayMcp } from './tools';

/** The Relay MCP tools, against real files and a driver stand-in. */

let folder: string;
const START = Date.now() - 60_000;

const HANDOFF = (outcome: string, next = 'Nothing.') =>
  [
    '---',
    'task: T002',
    `outcome: ${outcome}`,
    'tests: passed',
    'leg: 1',
    '---',
    '## Purpose',
    'Search.',
    '## Done so far',
    'All.',
    '## Decisions',
    'None.',
    '## Tried and rejected',
    'None.',
    '## Next step',
    next,
  ].join('\n');

function driver() {
  const leg = {
    taskId: 'T002',
    legNo: 1,
    budget: 200_000,
    contextTokens: 50_000,
    handoffMtimeAtStart: START,
    planFirst: false,
    continuation: false,
  };
  const relay = {
    projectId: 'p1',
    docsFolder: 'docs',
    options: { guardShare: 0.8, commitPerTask: true },
  };
  return {
    legForSession: vi.fn((tabId: string) => (tabId === 'tab-1' ? { relay, leg } : null)),
    reportLeg: vi.fn(async () => undefined),
    addProposal: vi.fn(() => ({ id: 'proposal-1' })),
  } as unknown as RelayDriver & {
    reportLeg: ReturnType<typeof vi.fn>;
    addProposal: ReturnType<typeof vi.fn>;
  };
}

function context(fake = driver()) {
  return {
    fake,
    ctx: {
      driver: fake,
      projectFolder: async () => ({ folderPath: folder, name: 'Clinic' }),
    },
  };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'relay-tools-'));
  mkdirSync(join(folder, 'docs', 'tasks', 'handoffs'), { recursive: true });
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T001-login.md'),
    renderTaskFile({ id: 'T001', title: 'Login', status: 'done' }),
  );
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T002-search.md'),
    renderTaskFile({ id: 'T002', title: 'Search', status: 'in-progress', depends: ['T001'] }),
  );
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

function writeHandoff(text: string, fresh = true): void {
  const path = join(folder, 'docs', 'tasks', 'handoffs', 'T002.md');
  writeFileSync(path, text);
  const at = new Date(fresh ? Date.now() : START - 10_000);
  utimesSync(path, at, at);
}

describe('handleRelayMcp', () => {
  it('refuses a session that runs no leg, and a malformed request', async () => {
    const { ctx } = context();
    expect(await handleRelayMcp(ctx, { sessionId: 'tab-9', tool: 'current_leg' })).toMatchObject({
      payload: { ok: false },
    });
    expect(await handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'rm_rf' })).toMatchObject({
      status: 400,
    });
  });

  it('describes the current leg with its dependencies', async () => {
    const { ctx } = context();
    const answer = await handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'current_leg' });
    expect(answer.payload.data).toMatchObject({
      taskId: 'T002',
      taskFile: 'docs/tasks/T002-search.md',
      handoff: 'docs/tasks/handoffs/T002.md',
      dependsOn: [{ id: 'T001', handoff: 'docs/tasks/handoffs/T001.md' }],
      commitWhenDone: true,
    });
  });

  it('says how much context is used', async () => {
    const { ctx } = context();
    const answer = await handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'context_status' });
    expect(answer.payload.text).toBe('About 50K of 200K tokens used (25%). Hand off at 80%.');
  });

  it('checks the handoff before it records the end of a leg', async () => {
    const { ctx, fake } = context();
    const finish = (args: Record<string, unknown>) =>
      handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'finish_leg', args });

    expect((await finish({ outcome: 'done', tests: 'passed' })).payload.error).toMatch(/^Write/);
    writeHandoff(HANDOFF('done'), false);
    expect((await finish({ outcome: 'done', tests: 'passed' })).payload.error).toMatch(/^Write/);
    writeHandoff(HANDOFF('continue', ''));
    const wrong = (await finish({ outcome: 'done', tests: 'passed' })).payload.error;
    expect(wrong).toContain('next');
    expect(wrong).toContain('outcome: done');
    expect(fake.reportLeg).not.toHaveBeenCalled();

    writeHandoff(HANDOFF('done'));
    expect((await finish({ outcome: 'done', tests: 'passed' })).payload.ok).toBe(true);
    expect(fake.reportLeg).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ outcome: 'done', tests: 'passed' }),
    );
  });

  it('lists and reads tasks', async () => {
    const { ctx } = context();
    const list = await handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'list_tasks' });
    expect(list.payload.data).toEqual([
      expect.objectContaining({ id: 'T001', status: 'done' }),
      expect.objectContaining({ id: 'T002', depends: ['T001'] }),
    ]);
    const task = await handleRelayMcp(ctx, {
      sessionId: 'tab-1',
      tool: 'get_task',
      args: { id: 't001' },
    });
    expect(task.payload.text).toContain('title: Login');
    expect(
      (await handleRelayMcp(ctx, { sessionId: 'tab-1', tool: 'get_task', args: { id: '../x' } }))
        .payload.ok,
    ).toBe(false);
  });

  it('passes a valid proposal to the user and refuses a broken one', async () => {
    const { ctx, fake } = context();
    const sent = await handleRelayMcp(ctx, {
      sessionId: 'tab-1',
      tool: 'propose_tasks',
      args: { proposal: { summary: 'Follow-up', add: [{ title: 'Cache search' }] } },
    });
    expect(sent.payload.ok).toBe(true);
    expect(fake.addProposal).toHaveBeenCalledWith(
      'p1',
      'Clinic',
      'T002',
      expect.objectContaining({ summary: 'Follow-up' }),
      [expect.objectContaining({ kind: 'add', id: 'T003' })],
    );
    const broken = await handleRelayMcp(ctx, {
      sessionId: 'tab-1',
      tool: 'propose_tasks',
      args: { proposal: { add: [{ title: 5 }] } },
    });
    expect(broken.payload.ok).toBe(false);
  });
});
