import type { RelayProposal } from '@runova/core';
import type { RelayPlannerResult } from '@shared/relayTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayPlanDialogStore } from './relayPlanDialogStore';
import {
  cancelPlanJob,
  findPlanJobByRequestId,
  type PlanJobStart,
  planJobKey,
  startPlanJob,
  updatePlanProposal,
  useRelayPlanJobsStore,
} from './relayPlanJobsStore';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const PROPOSAL: RelayProposal = {
  summary: 'Two tasks.',
  add: [
    { id: 'T014', title: 'Search API' },
    { id: 'T015', title: 'Search UI' },
  ],
  change: [],
  split: [],
  remove: [],
};
const PLANNED: RelayPlannerResult = {
  ok: true,
  proposal: PROPOSAL,
  entries: [
    { kind: 'add', id: 'T014', title: 'Search API', fields: [] },
    { kind: 'add', id: 'T015', title: 'Search UI', fields: [] },
  ],
  cliName: 'Claude Code',
};
const SPLIT: PlanJobStart = {
  kind: 'split',
  projectId: 'p1',
  projectName: 'Apollo',
  text: 'Add a patient search page',
  budget: 400_000,
};
const KEY = planJobKey('split', 'p1');

function job(key = KEY) {
  return useRelayPlanJobsStore.getState().jobs[key];
}

/** A planner whose answer the test hands over when it chooses. */
function pending() {
  let finish: (result: RelayPlannerResult) => void = () => undefined;
  const run = vi.fn(
    (_requestId: string) =>
      new Promise<RelayPlannerResult>((resolve) => {
        finish = resolve;
      }),
  );
  return { run, finish: (result: RelayPlannerResult) => finish(result) };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('relayPlanJobsStore', () => {
  it('keeps a running planner, with what it was started from, while no dialog is open', async () => {
    const planner = pending();
    const done = startPlanJob(SPLIT, planner.run);

    const requestId = planner.run.mock.calls[0][0];
    expect(requestId).toMatch(/^relay-plan-/);
    expect(job()).toMatchObject({
      ...SPLIT,
      key: KEY,
      requestId,
      status: 'running',
      result: null,
    });

    planner.finish(PLANNED);
    await done;
    expect(job()).toMatchObject({ status: 'done', result: PLANNED, proposal: PROPOSAL });
  });

  it('announces a finished plan with a way back to it', async () => {
    await startPlanJob(SPLIT, async () => PLANNED);

    expect(toast.success).toHaveBeenCalledWith('Tasks for Apollo are ready', {
      description: '2 tasks to look over before they go on the board.',
      action: { label: 'Review', onClick: expect.any(Function) },
    });
    toast.success.mock.calls[0][1].action.onClick();
    expect(useRelayPlanDialogStore.getState()).toMatchObject({
      open: true,
      request: { kind: 'split', projectId: 'p1', request: 'Add a patient search page' },
    });
  });

  it('stays quiet when the dialog is already showing the plan', async () => {
    useRelayPlanJobsStore.getState().setShownKey(KEY);
    await startPlanJob(SPLIT, async () => PLANNED);
    expect(toast.success).not.toHaveBeenCalled();
    expect(job()?.status).toBe('done');
  });

  it('names revisions and catch-ups by what they change', async () => {
    await startPlanJob({ ...SPLIT, kind: 'revise' }, async () => PLANNED);
    await startPlanJob({ ...SPLIT, kind: 'catch-up' }, async () => PLANNED);
    await startPlanJob({ ...SPLIT, kind: 'revise', projectId: 'p2' }, async () => ({
      ...PLANNED,
      entries: [],
    }));
    expect(toast.success.mock.calls.map(([title]) => title)).toEqual([
      'Board review for Apollo is ready',
      'The rest of Apollo is planned',
      "Nothing to change on Apollo's board",
    ]);
  });

  it('keeps a failure to show, and says so', async () => {
    await startPlanJob(SPLIT, async () => ({ ok: false, error: 'Not signed in.' }));
    expect(job()).toMatchObject({ status: 'failed', error: 'Not signed in.' });
    expect(toast.error).toHaveBeenCalledWith('Planning for Apollo stopped', {
      description: 'Not signed in.',
      action: { label: 'Details', onClick: expect.any(Function) },
    });
  });

  it('treats a planner that threw as one that failed', async () => {
    await startPlanJob(SPLIT, async () => {
      throw new Error('IPC went away');
    });
    expect(job()).toMatchObject({ status: 'failed', error: 'IPC went away' });
  });

  it('drops a run that main reports as cancelled, without a word', async () => {
    await startPlanJob(SPLIT, async () => ({ ok: false, error: 'x', cancelled: true }));
    expect(job()).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('cancels a running planner in main and ignores its late answer', async () => {
    const planner = pending();
    const done = startPlanJob(SPLIT, planner.run);
    const requestId = planner.run.mock.calls[0][0];

    cancelPlanJob(KEY);
    expect(window.runova.relay.cancelPlanner).toHaveBeenCalledWith(requestId);
    expect(job()).toBeUndefined();

    planner.finish(PLANNED);
    await done;
    expect(job()).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('drops a finished plan without asking main to cancel anything', async () => {
    await startPlanJob(SPLIT, async () => PLANNED);
    cancelPlanJob(KEY);
    expect(job()).toBeUndefined();
    expect(window.runova.relay.cancelPlanner).not.toHaveBeenCalled();
  });

  it('replaces a running planner for the same project, and keeps only the new answer', async () => {
    const first = pending();
    const second = pending();
    const firstDone = startPlanJob(SPLIT, first.run);
    const firstId = first.run.mock.calls[0][0];
    const secondDone = startPlanJob({ ...SPLIT, text: 'Search, take two' }, second.run);

    expect(window.runova.relay.cancelPlanner).toHaveBeenCalledWith(firstId);
    first.finish({ ...PLANNED, cliName: 'old' });
    await firstDone;
    expect(job()?.status).toBe('running');

    second.finish(PLANNED);
    await secondDone;
    expect(job()).toMatchObject({ status: 'done', text: 'Search, take two', result: PLANNED });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('runs plans for different projects and kinds side by side', async () => {
    const one = pending();
    const two = pending();
    void startPlanJob(SPLIT, one.run);
    void startPlanJob({ ...SPLIT, kind: 'revise' }, two.run);
    void startPlanJob({ ...SPLIT, projectId: 'p2' }, pending().run);
    expect(Object.keys(useRelayPlanJobsStore.getState().jobs).sort()).toEqual([
      'revise:p1',
      'split:p1',
      'split:p2',
    ]);
    expect(window.runova.relay.cancelPlanner).not.toHaveBeenCalled();
  });

  it('finds a job by its request id, for a click on the OS notification', async () => {
    const planner = pending();
    void startPlanJob(SPLIT, planner.run);
    const requestId = planner.run.mock.calls[0][0];
    expect(findPlanJobByRequestId(requestId)?.key).toBe(KEY);
    expect(findPlanJobByRequestId('relay-plan-unknown')).toBeUndefined();
  });

  it('keeps the edits the user made to the proposal', async () => {
    await startPlanJob(SPLIT, async () => PLANNED);
    const trimmed = { ...PROPOSAL, add: [PROPOSAL.add[0]] };
    updatePlanProposal(KEY, trimmed);
    expect(job()?.proposal).toEqual(trimmed);
    expect(job()?.result).toEqual(PLANNED);
    updatePlanProposal('split:nobody', trimmed);
    expect(job('split:nobody')).toBeUndefined();
  });
});
