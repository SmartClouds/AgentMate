import type { GithubWorkflowRunInfo } from '../../../shared/apiTypes';
import type { AutoFixRunWait } from '../../../shared/ciAutoFixTypes';

/** How far apart this machine's clock and GitHub's may be when matching a dispatched run. */
const CLOCK_SKEW_MS = 30_000;

/**
 * The run a waiting session should follow, from a workflow's latest runs. After a push it is the
 * run of that commit on the branch. After a dispatch it is the first dispatched run on the branch
 * that GitHub created since then.
 */
export function pickWaitedRun(
  runs: GithubWorkflowRunInfo[],
  branch: string,
  wait: AutoFixRunWait,
): { id: number; runNumber: number } | null {
  const onBranch = runs.filter((run) => run.headBranch === branch);
  const match =
    wait.kind === 'commit'
      ? onBranch.find((run) => run.headSha === wait.sha)
      : onBranch
          .filter(
            (run) =>
              run.event === 'workflow_dispatch' &&
              Date.parse(run.createdAt) >= wait.since - CLOCK_SKEW_MS,
          )
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  return match ? { id: match.id, runNumber: match.runNumber } : null;
}
