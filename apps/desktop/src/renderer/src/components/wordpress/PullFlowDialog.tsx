import type { WpItemRef, WpPlannedChange } from '@runova/core';
import type { DeployWordPressPlan, DeployWordPressPullResult } from '@shared/deployWordPressTypes';
import { wordPressErrorCode, wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { CloudDownload, RefreshCw, Spinner } from '@/components/icons';
import {
  OutcomeBanner,
  ReviewHeading,
  RunError,
  WarningList,
} from '@/components/projects/wordpress/FlowParts';
import { OperationTimeline } from '@/components/projects/wordpress/OperationTimeline';
import {
  needsNewPlan,
  type OutcomeCopy,
  planExpired,
} from '@/components/projects/wordpress/wordpressCopy';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { findWordPressRun, useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { ChangeDiff, ChangeList, changeKey } from './ChangeList';
import { type ConflictResolution, ConflictResolver, defaultResolutions } from './ConflictResolver';
import { LeftOutList } from './LeftOutList';

/**
 * Pulls the site's latest theme and plugin files into a WordPress project (E21): plan, review
 * (incoming changes, conflicts with local edits and a choice for each), progress, result.
 *
 * The Deploy UI opens it from a site's Items panel with these props, so they stay as they are.
 */
export interface PullFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  siteId: string;
  /** Only these of the project's items; all of them when left out. */
  items?: WpItemRef[];
}

type Step = 'plan' | 'review' | 'run';

const SILENT = { silentLoading: true } as const;

function pullOutcome(result: DeployWordPressPullResult): OutcomeCopy {
  const downloaded = result.downloaded === 1 ? '1 file' : `${result.downloaded} files`;
  const deleted = result.deletedLocal === 1 ? '1 file' : `${result.deletedLocal} files`;
  return {
    tone: 'success',
    title: 'Pulled',
    detail: `${downloaded} downloaded, ${deleted} removed here because the site removed them.`,
  };
}

export function PullFlowDialog({
  open,
  onOpenChange,
  projectId,
  siteId,
  items,
}: PullFlowDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const startPull = useWordPressOperationStore((state) => state.pull);
  const cancelRun = useWordPressOperationStore((state) => state.cancel);
  const clearRun = useWordPressOperationStore((state) => state.clear);

  const [step, setStep] = useState<Step>('plan');
  const [plan, setPlan] = useState<DeployWordPressPlan | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});
  const [selected, setSelected] = useState<WpPlannedChange | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const planRequest = useRef(0);
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const project = projectsQuery.data?.find((candidate) => candidate.id === projectId);
  const sitesQuery = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: () => window.runova.deployWordPress.listSites(),
    enabled: open,
    meta: SILENT,
  });
  const site = sitesQuery.data?.find((candidate) => candidate.id === siteId);
  const siteName = site?.label || site?.siteName || 'the site';

  async function makePlan(): Promise<void> {
    planRequest.current += 1;
    const request = planRequest.current;
    setStep('plan');
    setPlan(null);
    setPlanError(null);
    setSelected(null);
    setResolutions({});
    setOperationId(null);
    try {
      const next = await window.runova.deployWordPress.planPull({
        projectId,
        ...(items ? { items } : {}),
      });
      if (request !== planRequest.current) return;
      setPlan(next);
      setResolutions(defaultResolutions(next.conflicts));
      setStep('review');
    } catch (error) {
      if (request !== planRequest.current) return;
      setPlanError(error);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: start over each time it opens, not on every render
  useEffect(() => {
    if (!open) {
      planRequest.current += 1;
      return;
    }
    const existing = findWordPressRun(useWordPressOperationStore.getState().runs, {
      kind: 'pull',
      projectId,
    });
    if (existing) {
      setOperationId(existing.operationId);
      setStep('run');
      return;
    }
    void makePlan();
  }, [open, projectId]);

  const runStatus = run?.status;
  useEffect(() => {
    if (runStatus !== 'done' && runStatus !== 'failed') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectWordPressChanges(projectId) });
  }, [runStatus, projectId, queryClient]);

  function handleOpenChange(next: boolean): void {
    if (!next && run && run.status !== 'running') clearRun(run.operationId);
    onOpenChange(next);
  }

  const conflicts = plan?.conflicts ?? [];
  const pending = plan?.changes.filter((change) => change.action !== 'none') ?? [];
  const downloads = pending.filter((change) => change.action === 'download');
  const deletes = pending.filter((change) => change.action === 'deleteLocal');

  function pull(): void {
    if (!plan) return;
    if (planExpired(plan.expiresAt)) {
      void makePlan();
      return;
    }
    const id = crypto.randomUUID();
    setOperationId(id);
    setStep('run');
    // Every conflict gets an answer, even the ones left on the default.
    const answers = { ...defaultResolutions(conflicts), ...resolutions };
    void startPull(
      {
        planId: plan.planId,
        operationId: id,
        force: false,
        ...(conflicts.length > 0 ? { resolutions: answers } : {}),
      },
      { siteId, projectId },
    );
  }

  const result = run?.result?.kind === 'pull' ? run.result.value : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Pull from {siteName}</DialogTitle>
          <DialogDescription>
            {step === 'run'
              ? 'You can close this window; the pull keeps going.'
              : "What changed on the site since the last sync. Click a file to compare it with this computer's copy."}
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll fill>
          {step === 'plan' ? (
            planError ? (
              <RunError
                message={wordPressErrorMessage(planError)}
                code={wordPressErrorCode(planError)}
              />
            ) : (
              <div role="status" aria-label="Working out the changes" className="space-y-2">
                <Skeleton className="h-5 w-64" />
                <Skeleton className="h-24 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            )
          ) : null}

          {step === 'review' && plan ? (
            <div className="space-y-5">
              <p className="px-1 text-sm">
                {downloads.length === 1
                  ? '1 file to download'
                  : `${downloads.length} files to download`}
                {plan.downloadBytes > 0 ? ` (${formatBytes(plan.downloadBytes)})` : ''},{' '}
                {deletes.length === 1 ? '1 to remove here' : `${deletes.length} to remove here`}
                {conflicts.length > 0 ? `, ${conflicts.length} in conflict` : ''}.
              </p>

              <WarningList warnings={plan.warnings.filter((w) => w !== 'readOnlyScope')} />

              <ConflictResolver
                mode="pull"
                conflicts={conflicts}
                resolutions={resolutions}
                onResolutionsChange={setResolutions}
              />

              <div className="space-y-2">
                <ReviewHeading>Incoming changes</ReviewHeading>
                <ChangeList
                  changes={plan.changes}
                  direction="pull"
                  selectedKey={selected ? changeKey(selected) : null}
                  onSelect={(change) =>
                    setSelected((current) =>
                      current && changeKey(current) === changeKey(change) ? null : change,
                    )
                  }
                />
                {selected && project ? (
                  <ChangeDiff
                    projectId={projectId}
                    folderPath={project.folderPath}
                    change={selected}
                    direction="pull"
                    onClose={() => setSelected(null)}
                  />
                ) : null}
              </div>

              {plan.leftOut.length > 0 ? (
                <div className="space-y-2">
                  <ReviewHeading>Left out</ReviewHeading>
                  <LeftOutList entries={plan.leftOut} direction="pull" />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'run' ? (
            run ? (
              <div className="space-y-4">
                {run.status === 'done' && result ? (
                  <OutcomeBanner outcome={pullOutcome(result)} />
                ) : null}
                {run.status === 'failed' ? (
                  <RunError message={run.error ?? 'The pull failed.'} code={run.errorCode} />
                ) : null}
                <OperationTimeline run={run} />
                {result && result.conflictCopies.length > 0 ? (
                  <div className="space-y-1.5">
                    <ReviewHeading>Copies kept for the conflicts</ReviewHeading>
                    <p className="px-1 text-xs text-muted-foreground">
                      These are in the project folder, so the other version of each file is still
                      there to compare or bring back:
                    </p>
                    <ul aria-label="Conflict copies" className="space-y-0.5 px-1">
                      {result.conflictCopies.map((path) => (
                        <li key={path} className="truncate font-mono text-xs">
                          {path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <Skeleton className="h-40 w-full rounded-lg" />
            )
          ) : null}
        </OverflowScroll>

        <DialogFooter>
          {step === 'plan' ? (
            <>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              {planError ? (
                <Button onClick={() => void makePlan()}>
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              ) : null}
            </>
          ) : null}

          {step === 'review' ? (
            <>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="soft" onClick={() => void makePlan()}>
                <RefreshCw className="h-4 w-4" /> Check again
              </Button>
              <SimpleTooltip
                label={pending.length === 0 ? 'Nothing new on the site.' : null}
                wrapTrigger
              >
                <Button disabled={pending.length === 0} onClick={pull}>
                  <CloudDownload className="h-4 w-4" /> Pull
                </Button>
              </SimpleTooltip>
            </>
          ) : null}

          {step === 'run' && run ? (
            run.status === 'running' ? (
              <>
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  Hide
                </Button>
                <Button
                  variant="soft"
                  disabled={run.cancelling}
                  onClick={() => void cancelRun(run.operationId)}
                >
                  {run.cancelling ? <Spinner className="h-4 w-4 animate-spin" /> : null}
                  {run.cancelling ? 'Cancelling' : 'Cancel pull'}
                </Button>
              </>
            ) : (
              <>
                {run.status === 'failed' && needsNewPlan(run.errorCode) ? (
                  <Button
                    variant="soft"
                    onClick={() => {
                      clearRun(run.operationId);
                      void makePlan();
                    }}
                  >
                    <RefreshCw className="h-4 w-4" /> Check again
                  </Button>
                ) : null}
                <Button onClick={() => handleOpenChange(false)}>Done</Button>
              </>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
