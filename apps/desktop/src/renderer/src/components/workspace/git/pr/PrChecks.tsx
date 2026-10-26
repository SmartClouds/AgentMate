import { checkBucket, type Project, type PullRequestInfo, summarizeChecks } from '@runova/core';
import { CircleCheck } from '@/components/icons';
import { RunStatusIcon, runTone } from '@/components/pipelines/runStatus';
import { cn } from '@/lib/utils';
import { FailedRunActions, RunChip } from '../PipelinesSection';
import { PrCard } from './PrCard';

const ORDER = { failed: 0, running: 1, other: 2, passed: 3 } as const;

export function checksSummaryText(pr: PullRequestInfo): string {
  const summary = summarizeChecks(pr.checks);
  return [
    summary.failed ? `${summary.failed} failed` : null,
    summary.running ? `${summary.running} running` : null,
    summary.passed ? `${summary.passed} passed` : null,
    summary.other ? `${summary.other} skipped` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The PR's status checks, failures first, each failed Actions run one click from an AI fix. */
export function PrChecks({
  project,
  pr,
  repo,
}: {
  project: Project;
  pr: PullRequestInfo;
  /** `owner/repo`, which the run lookups need. */
  repo: string;
}): React.JSX.Element {
  const summary = summarizeChecks(pr.checks);
  const rows = [...pr.checks].sort((a, b) => ORDER[checkBucket(a)] - ORDER[checkBucket(b)]);
  const tone = summary.failed ? 'destructive' : summary.running ? 'warning' : 'default';

  return (
    <PrCard
      title="Checks"
      icon={CircleCheck}
      tone={tone}
      summary={pr.checks.length ? checksSummaryText(pr) : undefined}
      defaultOpen={summary.failed > 0 || summary.running > 0 || pr.checks.length <= 4}
    >
      {pr.checks.length === 0 ? (
        <p className="px-3.5 py-1 text-[11px] text-muted-foreground">
          No checks on this pull request.
        </p>
      ) : (
        <ul className="space-y-px">
          {rows.map((check) => {
            // Checks carry GitHub's own lowercase values, the same ones a run has.
            const itemTone = runTone(check as Parameters<typeof runTone>[0]);
            const failed = checkBucket(check) === 'failed';
            return (
              <li
                key={`${check.workflow ?? ''}/${check.name}`}
                className={cn(
                  'mx-1.5 rounded-lg',
                  failed && 'bg-destructive/[0.05] ring-1 ring-inset ring-destructive/15',
                )}
              >
                <button
                  type="button"
                  disabled={!check.detailsUrl}
                  onClick={() =>
                    check.detailsUrl && void window.runova.shell.openExternal(check.detailsUrl)
                  }
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:hover:bg-transparent',
                    !failed && 'hover:bg-foreground/[0.06]',
                  )}
                >
                  <RunStatusIcon tone={itemTone} className="h-5 w-5 shrink-0 rounded-md" />
                  <span className="min-w-0 flex-1">
                    <span
                      data-testid="pr-check-name"
                      className="block truncate text-[12px] font-medium"
                    >
                      {check.name}
                    </span>
                    {check.workflow ? (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {check.workflow}
                      </span>
                    ) : null}
                  </span>
                  <RunChip tone={itemTone} />
                </button>
                {failed && check.runId ? (
                  <FailedRunActions
                    project={project}
                    className="pl-8"
                    run={{
                      repo,
                      runId: check.runId,
                      workflowName: check.workflow ?? check.name,
                      displayTitle: pr.title,
                      headBranch: pr.head,
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PrCard>
  );
}
