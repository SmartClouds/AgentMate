import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  History,
  TriangleAlert,
  Undo,
} from '@/components/icons';
import { Chip, EmptyState } from '@/components/pageKit';
import { changeStateText } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { ago, dateTime } from '../security/format';
import {
  CARD_BODY,
  CARD_ROWS,
  CODE_WELL,
  RowsSkeleton,
  SecurityCard,
} from '../security/SecurityCard';

/**
 * Every change set, newest first: what it did, who made it from where, and how it ended (kept,
 * reverted, or rolled back by the timer because nobody kept it). Each one opens to the exact
 * commands it ran.
 */

function StateMark({ change }: { change: FirewallChangeSetInfo }) {
  if (change.state === 'confirmed') return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (change.state === 'rolledBack') return <Undo className="h-3.5 w-3.5 text-warning" />;
  if (change.state === 'awaitingConfirmation' || change.state === 'applying') {
    return <Clock className="h-3.5 w-3.5 text-warning" />;
  }
  return <CircleX className="h-3.5 w-3.5 text-destructive" />;
}

export function HistoryCard({
  changes,
  loading,
  error,
  now,
}: {
  changes: FirewallChangeSetInfo[] | undefined;
  loading: boolean;
  error: string | null;
  now: number;
}): React.JSX.Element {
  return (
    <SecurityCard
      icon={<History />}
      title="Change history"
      description="What was applied, and whether it was kept."
    >
      {loading && !changes ? (
        <RowsSkeleton rows={2} />
      ) : error && !changes ? (
        <p role="alert" className={cn(CARD_BODY, 'text-sm text-destructive')}>
          {error}
        </p>
      ) : !changes || changes.length === 0 ? (
        <div className={CARD_BODY}>
          <EmptyState
            size="sm"
            icon={History}
            title="No changes yet."
            description="Changes made here show up with how they ended."
          />
        </div>
      ) : (
        <ul aria-label="Change history" className={CARD_ROWS}>
          {changes.map((change) => (
            <li key={change.id} aria-label={change.summary}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
                  />
                  <span className="mt-0.5">
                    <StateMark change={change} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{change.summary}</span>
                    <span className="block text-xs text-muted-foreground">
                      {changeStateText(change)} · {ago(change.createdAtUnixMs, now)}
                      {change.requestedBy ? ` by ${change.requestedBy}` : ''}
                      {change.appliedFrom ? ` from ${change.appliedFrom}` : ''}
                    </span>
                  </span>
                  {change.guardOverridden && (
                    <Chip tone="destructive">
                      <TriangleAlert /> SSH check overridden
                    </Chip>
                  )}
                </summary>
                <div className="space-y-2 pb-3 pl-16 pr-4">
                  <p className="text-xs text-muted-foreground">
                    {dateTime(change.createdAtUnixMs)}
                    {change.error ? `. ${change.error}` : ''}
                  </p>
                  <pre className={cn(CODE_WELL, 'p-2 text-[11px]')}>
                    {change.commands.join('\n')}
                  </pre>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </SecurityCard>
  );
}
