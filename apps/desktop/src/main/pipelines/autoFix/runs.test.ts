import { describe, expect, it } from 'vitest';
import type { GithubWorkflowRunInfo } from '../../../shared/apiTypes';
import { pickWaitedRun } from './runs';

/**
 * After a push auto-fix must follow the run of its own commit, not a run someone else started on
 * the branch at the same time. After a dispatch it follows the run that appeared since then.
 */

const SINCE = Date.parse('2026-10-29T10:00:00Z');

function run(patch: Partial<GithubWorkflowRunInfo>): GithubWorkflowRunInfo {
  return {
    id: 1,
    workflowId: 9,
    name: 'CI',
    displayTitle: 'x',
    runNumber: 1,
    headBranch: 'main',
    status: 'queued',
    conclusion: null,
    htmlUrl: '',
    createdAt: '2026-10-29T10:00:30Z',
    updatedAt: '2026-10-29T10:00:30Z',
    headSha: 'sha-fix',
    event: 'push',
    ...patch,
  };
}

describe('pickWaitedRun', () => {
  it('finds the run of the pushed commit on the branch', () => {
    const runs = [
      run({ id: 3, runNumber: 9, headSha: 'other' }),
      run({ id: 2, runNumber: 8, headSha: 'sha-fix' }),
    ];
    expect(pickWaitedRun(runs, 'main', { kind: 'commit', sha: 'sha-fix', since: SINCE })).toEqual({
      id: 2,
      runNumber: 8,
    });
  });

  it('skips a run of that commit on another branch', () => {
    const runs = [run({ headBranch: 'feature', headSha: 'sha-fix' })];
    expect(
      pickWaitedRun(runs, 'main', { kind: 'commit', sha: 'sha-fix', since: SINCE }),
    ).toBeNull();
  });

  it('follows the earliest dispatched run since the dispatch', () => {
    const runs = [
      run({ id: 7, runNumber: 12, event: 'workflow_dispatch', createdAt: '2026-10-29T10:05:00Z' }),
      run({ id: 6, runNumber: 11, event: 'workflow_dispatch', createdAt: '2026-10-29T10:00:05Z' }),
      run({ id: 5, runNumber: 10, event: 'workflow_dispatch', createdAt: '2026-10-29T09:30:00Z' }),
    ];
    expect(pickWaitedRun(runs, 'main', { kind: 'dispatch', since: SINCE })).toEqual({
      id: 6,
      runNumber: 11,
    });
  });

  it('allows for the clocks of this machine and GitHub being a little apart', () => {
    const runs = [run({ id: 6, event: 'workflow_dispatch', createdAt: '2026-10-29T09:59:40Z' })];
    expect(pickWaitedRun(runs, 'main', { kind: 'dispatch', since: SINCE })?.id).toBe(6);
  });

  it('ignores runs that were not dispatched', () => {
    const runs = [run({ id: 6, event: 'push' })];
    expect(pickWaitedRun(runs, 'main', { kind: 'dispatch', since: SINCE })).toBeNull();
  });
});
