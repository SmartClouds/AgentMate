import type { FileSite, FilesChangesSnapshot } from '@shared/deployFilesTypes';
import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CloudUpload,
  FolderOpen,
  RefreshCw,
  Spinner,
} from '@/components/icons';
import { Chip, GLASS_CARD, LoadFailure, Notice, Problem } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isRunActive, selectSiteRun, useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { ChangesList } from './ChangesList';
import { changesSummaryText, deployButtonText, lastDeployText } from './copy';
import { DeployReview } from './DeployReview';
import { selectedTotals } from './deployPlan';
import { useFileSiteChanges } from './hooks';
import { filesProblem, filesProblemText } from './messages';
import { RunProgressCard } from './RunProgressCard';
import { RunSummaryCard } from './RunSummaryCard';
import { useDeployFlow } from './useDeployFlow';

/**
 * A site's Changes (E23): what changed in the deploy folder since the last deploy, the Deploy
 * button, and the whole deploy from there. The progress takes the button's place and the review
 * sits above the list, so nothing ever covers the page. The project Deploy tab draws the same
 * panel with the file list folded away.
 */

/** Codes after which the plan has to be made again rather than the deploy tried again. */
const CHECK_AGAIN = new Set(['planExpired', 'conflict', 'localChanged']);

/**
 * Codes that only a change to the site's login fixes: a certificate to look at and trust, a name
 * the certificate was issued for, or a host key that was never trusted. Edit has Test connection.
 */
const EDIT_SITE = new Set(['tlsUntrusted', 'tlsNameMismatch', 'hostKeyUnknown']);

export function DeployPanel({
  site,
  onEdit,
  onOpenSettings,
  compact = false,
  showLastDeploy = true,
}: {
  site: FileSite;
  /** Opens the site's edit dialog, for a deploy folder that has to be picked again. */
  onEdit: () => void;
  /** Goes to the site's Settings, for its ignore lines. */
  onOpenSettings?: () => void;
  /** The list starts folded, for a card on a project's Deploy tab. */
  compact?: boolean;
  /** Off where a header above already says when the site was last deployed. */
  showLastDeploy?: boolean;
}): React.JSX.Element {
  const changes = useFileSiteChanges(site.id);
  const snapshot = changes.data ?? null;
  const [listOpen, setListOpen] = useState(!compact);
  const flow = useDeployFlow({ site, files: snapshot?.files ?? [] });
  const { run, start } = flow;
  const active = isRunActive(run);
  // The unticked files live in the run store, so they outlast this panel.
  const deselected = run.deselected;
  const siteId = site.id;
  const setDeselected = useCallback(
    (next: Set<string>) => useDeployFilesRunStore.getState().setDeselected(siteId, next),
    [siteId],
  );

  // A check asked for from outside (the needs-review notice) waits for the first snapshot, so it
  // knows what is ticked, and is taken once: coming back to Changes never asks again.
  const startRequested = run.startRequested;
  const snapshotState = snapshot?.state ?? null;
  useEffect(() => {
    if (!startRequested || snapshotState === null || snapshotState === 'scanning') return;
    const store = useDeployFilesRunStore.getState();
    if (!store.takeStartRequest(siteId)) return;
    const now = selectSiteRun(siteId)(store);
    if (snapshotState === 'ready' && !isRunActive(now) && !now.planning && !now.review) {
      void start(null);
    }
  }, [startRequested, snapshotState, siteId, start]);

  if (changes.isError) {
    return (
      <LoadFailure message={filesProblem(changes.error)} retry={() => void changes.refetch()} />
    );
  }
  if (!snapshot) return <PanelSkeleton compact={compact} />;

  const files = snapshot.files;
  const totals = selectedTotals(files, deselected);
  const scanning = snapshot.state === 'scanning';
  const blocked = snapshot.state === 'folderMissing' || snapshot.state === 'tooManyFiles';

  let bar: React.ReactNode;
  if (active) {
    bar = (
      <RunProgressCard
        progress={run.progress}
        samples={run.samples}
        onCancel={() => void flow.cancel()}
        cancelling={flow.cancelling}
      />
    );
  } else if (snapshot.state === 'folderMissing') {
    bar = (
      <Notice
        tone="warning"
        icon={FolderOpen}
        action={
          <Button size="sm" variant="soft" onClick={onEdit}>
            Pick the folder again
          </Button>
        }
      >
        <p className="font-medium">The deploy folder is gone</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          It may have been moved or renamed, or its drive is not connected:
        </p>
        <p className="mt-1 break-all font-mono text-xs">{site.localFolder}</p>
      </Notice>
    );
  } else if (snapshot.state === 'tooManyFiles') {
    bar = (
      <Notice
        tone="warning"
        action={
          onOpenSettings && (
            <Button size="sm" variant="soft" onClick={onOpenSettings}>
              Edit the ignore lines
            </Button>
          )
        }
      >
        {snapshot.error?.trim() || filesProblemText('tooManyFiles')}
      </Notice>
    );
  } else if (snapshot.state === 'error') {
    bar = (
      <Problem
        message={`Couldn't read the deploy folder. ${snapshot.error ?? ''}`.trim()}
        onRetry={() => void changes.refetch()}
      />
    );
  } else if (files.length === 0 && !scanning) {
    bar = (
      <section
        aria-label="Changes"
        className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3.5')}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-success/12 text-success [&_svg]:size-4">
          <CircleCheck />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Everything is deployed</p>
          <p className="text-xs text-muted-foreground">{lastDeployText(site.lastDeploy)}</p>
        </div>
      </section>
    );
  } else {
    const planning = run.planning;
    const off = run.review
      ? 'Finish the review below first.'
      : scanning
        ? 'Still looking through the deploy folder.'
        : totals.count === 0
          ? 'Tick at least one file to deploy.'
          : null;
    bar = (
      <section
        aria-label="Changes"
        className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3.5')}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary [&_svg]:size-4">
          <CloudUpload />
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {changesSummaryText(files.length, snapshot.totals.bytes)}
            {scanning && (
              <Chip dot pulse tone="primary">
                Checking the folder
              </Chip>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {showLastDeploy
              ? lastDeployText(site.lastDeploy)
              : 'Untick anything that should wait for a later deploy.'}
          </p>
        </div>
        <SimpleTooltip label={planning ? null : off} wrapTrigger>
          <Button
            disabled={planning || off !== null}
            onClick={() => void flow.start(null)}
            className="shrink-0"
          >
            {planning ? <Spinner className="motion-safe:animate-spin" /> : <CloudUpload />}
            {planning ? 'Checking the server…' : deployButtonText(totals.count, totals.bytes)}
          </Button>
        </SimpleTooltip>
      </section>
    );
  }

  const problem = run.problem;
  const hasList =
    !blocked &&
    snapshot.state !== 'error' &&
    (files.length > 0 || scanning || snapshot.leftOut.length > 0);

  return (
    <div className="flex flex-col gap-2">
      {bar}
      {problem && !active && (
        <Notice
          role="alert"
          tone="destructive"
          action={
            problem.code && CHECK_AGAIN.has(problem.code) ? (
              <Button size="sm" variant="soft" onClick={() => void flow.start(null)}>
                <RefreshCw /> Check the server again
              </Button>
            ) : problem.code && EDIT_SITE.has(problem.code) ? (
              <Button size="sm" variant="soft" onClick={onEdit}>
                Edit the site
              </Button>
            ) : undefined
          }
        >
          {problem.message}
        </Notice>
      )}
      {run.result && !active && (
        <RunSummaryCard
          result={run.result}
          notes={run.notes}
          onRetryFailed={(paths) => void flow.start(paths)}
          onDismiss={flow.dismiss}
          retrying={run.planning}
        />
      )}
      {run.review && !active && (
        <DeployReview
          review={run.review}
          allowed={flow.allowed}
          onChooseConflicts={flow.chooseConflicts}
          onChooseFirstDeploy={flow.chooseFirstDeploy}
          onReupload={flow.setReupload}
          onContinue={() => void flow.proceed()}
          onCancel={flow.back}
        />
      )}
      {hasList && (
        <ListCard
          snapshot={snapshot}
          open={listOpen}
          onOpenChange={compact ? setListOpen : undefined}
        >
          {scanning && files.length === 0 ? (
            <div className="space-y-1.5" aria-busy="true">
              <p className="text-xs text-muted-foreground">Looking through the deploy folder…</p>
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-7 w-full rounded-md" />
              ))}
            </div>
          ) : (
            <ChangesList
              snapshot={snapshot}
              deselected={deselected}
              onDeselectedChange={setDeselected}
              disabled={active || run.planning}
            />
          )}
        </ListCard>
      )}
    </div>
  );
}

function ListCard({
  snapshot,
  open,
  onOpenChange,
  children,
}: {
  snapshot: FilesChangesSnapshot;
  open: boolean;
  /** Present when the list can be folded away. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  if (onOpenChange) {
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <div className="space-y-2">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="self-start"
        >
          <Chevron />
          {open ? 'Hide the files' : `Show the files (${snapshot.files.length})`}
        </Button>
        {open && children}
      </div>
    );
  }
  return <div className={cn(GLASS_CARD, 'p-3')}>{children}</div>;
}

function PanelSkeleton({ compact }: { compact: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div aria-busy="true" className={cn(GLASS_CARD, 'flex items-center gap-3 px-4 py-3.5')}>
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-9 w-40 rounded-lg" />
      </div>
      {!compact && (
        <div aria-busy="true" className={cn(GLASS_CARD, 'space-y-2 p-3')}>
          <Skeleton className="h-8 w-full rounded-full" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-full rounded-md" />
          ))}
        </div>
      )}
    </div>
  );
}
