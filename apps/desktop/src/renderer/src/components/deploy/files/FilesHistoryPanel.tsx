import type { FilesHistoryEntry } from '@shared/deployFilesTypes';
import { useState } from 'react';
import { ChevronDown, ChevronRight, History, RefreshCw } from '@/components/icons';
import { Chip, EmptyState, Problem } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { durationText, plural, relativeTimeText, runCountsText, TRIGGER_LABEL } from './copy';
import { useFileSiteHistory } from './hooks';
import { filesProblem, filesProblemText, RUN_STATE_LABEL } from './messages';
import { STATE_LOOK } from './RunSummaryCard';

/**
 * Recent deploys to an FTP or SFTP site (E23), newest first: how each ended, what it sent, how
 * long it took and whether you or Deploy on save started it. A run with failed files opens to
 * show each one and why.
 */
export function FilesHistoryPanel({ siteId }: { siteId: string }): React.JSX.Element {
  const history = useFileSiteHistory(siteId);

  let body: React.ReactNode;
  if (history.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  } else if (history.isError) {
    body = <Problem message={filesProblem(history.error)} onRetry={() => void history.refetch()} />;
  } else if (history.data.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={History}
        title="No deploys yet"
        description="Deploys to this site show up here, newest first, with what each one sent."
      />
    );
  } else {
    body = (
      <ul aria-label="Deploys" className="settings-rows">
        {history.data.map((entry) => (
          <HistoryRow key={entry.runId} entry={entry} />
        ))}
      </ul>
    );
  }

  return (
    <DeployCard
      icon={<History />}
      title="History"
      description="The last deploys to this site. A run that stopped part way kept what it sent, and the next one picks up the rest."
      actions={
        <Button
          size="sm"
          variant="soft"
          disabled={history.isFetching}
          onClick={() => void history.refetch()}
        >
          <RefreshCw className={cn(history.isFetching && 'motion-safe:animate-spin')} /> Refresh
        </Button>
      }
    >
      {body}
    </DeployCard>
  );
}

function HistoryRow({ entry }: { entry: FilesHistoryEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const look = STATE_LOOK[entry.state];
  const Icon = look.icon;
  const failures = entry.failed.length;
  return (
    <li className="flex items-start gap-3 py-3">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', look.iconClass)} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={look.tone}>{RUN_STATE_LABEL[entry.state]}</Chip>
          <span className="text-xs tabular-nums text-foreground/90">{runCountsText(entry)}</span>
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>{relativeTimeText(entry.startedAt)}</span>
          <span aria-hidden>·</span>
          <span>took {durationText(entry.finishedAt - entry.startedAt)}</span>
          <span aria-hidden>·</span>
          <span className="sr-only">Started by</span>
          <Chip className="h-4 px-1.5 text-[10px]">{TRIGGER_LABEL[entry.trigger]}</Chip>
        </p>
        {entry.state === 'failed' && entry.error && (
          <p className="text-xs text-destructive">
            {filesProblemText(entry.error.code, entry.error.message)}
          </p>
        )}
        {failures > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            className="-ml-2"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            {open ? 'Hide the failed files' : `Show ${plural(failures, 'failed file')}`}
          </Button>
        )}
        {open && (
          <ul
            aria-label="Failed files"
            className="settings-rows overflow-hidden rounded-lg bg-foreground/[0.03] px-3 ring-1 ring-inset ring-foreground/[0.07]"
          >
            {entry.failed.map((failure) => (
              <li key={failure.path} className="space-y-0.5 py-1.5">
                <p className="truncate font-mono text-xs">{failure.path}</p>
                <p className="text-[11px] text-destructive">
                  {filesProblemText(failure.code, failure.message)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
