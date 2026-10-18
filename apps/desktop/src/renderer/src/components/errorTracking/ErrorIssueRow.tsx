import type { ErrorIssueSummary } from '@shared/errorTrackingTypes';
import { Copy, ExternalLink, Wand2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatAgo, formatClock } from '../health/healthView';
import { formatCount, LEVEL_META, sparklineBars } from './errorView';

/**
 * One issue in the Errors list: a dense row, not a card. The level is a stripe on the left (and a
 * word for screen readers), then what broke and where, the trend, the counts and when it was last
 * seen. The title opens the issue; the actions show on hover and on keyboard focus.
 */

function Sparkline({ trend, tone }: { trend: readonly number[]; tone: string }) {
  const bars = sparklineBars(trend);
  const peak = Math.max(1, ...bars);
  const width = 3;
  const gap = 1;
  const height = 22;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${bars.length * (width + gap) - gap} ${height}`}
      className="h-[22px] w-24 shrink-0"
      preserveAspectRatio="none"
    >
      {bars.map((count, i) => {
        const h = count === 0 ? 1.5 : Math.max(3, (count / peak) * height);
        return (
          <rect
            // The bars never move or reorder, so the slot is the identity.
            key={i}
            data-testid="trend-bar"
            x={i * (width + gap)}
            y={height - h}
            width={width}
            height={h}
            rx={1}
            className={cn(count === 0 ? 'fill-foreground/[0.12]' : cn('fill-current', tone))}
          />
        );
      })}
    </svg>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn('w-14 shrink-0 text-right', className)}>
      <div className="text-xs font-semibold tabular-nums text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

export function ErrorIssueRow({
  issue,
  now,
  onOpen,
  onFix,
  onCopy,
  selected = false,
}: {
  issue: ErrorIssueSummary;
  now: number;
  onOpen: (issue: ErrorIssueSummary) => void;
  onFix: (issue: ErrorIssueSummary) => void;
  onCopy: (issue: ErrorIssueSummary) => void;
  selected?: boolean;
}): React.JSX.Element {
  const meta = LEVEL_META[issue.level] ?? LEVEL_META.error;
  const lastSeen = Date.parse(issue.lastSeen);
  return (
    <li
      className={cn(
        'group relative flex min-w-0 items-center gap-3 py-2.5 pl-2 pr-2.5 transition-colors hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03]',
        selected && 'bg-primary/[0.06]',
      )}
    >
      <span aria-hidden className={cn('w-1 self-stretch shrink-0 rounded-full', meta.stripe)} />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label={issue.title}
            onClick={() => onOpen(issue)}
            className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium leading-tight outline-none after:absolute after:inset-0 after:content-[''] hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {issue.title}
          </button>
          {issue.isNew && (
            <Chip tone="primary" className="h-4 px-1.5 text-[10px]">
              New
            </Chip>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn('shrink-0 font-medium', meta.text)}>{meta.label}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <Chip className="h-4 px-1.5 font-mono text-[10px]">{issue.shortId}</Chip>
          {issue.culprit && <span className="truncate font-mono">{issue.culprit}</span>}
        </div>
      </div>

      <div className="hidden shrink-0 @2xl/issues:block">
        <Sparkline trend={issue.trend} tone={meta.text} />
      </div>
      <Stat label="events" value={formatCount(issue.count)} />
      <Stat
        label="users"
        value={formatCount(issue.userCount)}
        className="hidden @xl/issues:block"
      />
      <SimpleTooltip label={Number.isNaN(lastSeen) ? undefined : formatClock(lastSeen)}>
        <div className="relative z-10 w-20 shrink-0 text-right">
          <div className="text-xs font-medium tabular-nums text-foreground/85">
            {Number.isNaN(lastSeen) ? 'Unknown' : formatAgo(lastSeen, now)}
          </div>
          <div className="text-[10px] text-muted-foreground">last seen</div>
        </div>
      </SimpleTooltip>

      <div className="relative z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <SimpleTooltip label="Hand this issue to your agent to fix">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Fix with AI"
            onClick={() => onFix(issue)}
          >
            <Wand2 />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Copy a prompt with the stack trace for any AI">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copy for AI"
            onClick={() => onCopy(issue)}
          >
            <Copy />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Open in Sentry">
          <Button size="icon-sm" variant="ghost" asChild>
            <a href={issue.permalink} target="_blank" rel="noreferrer" aria-label="Open in Sentry">
              <ExternalLink />
            </a>
          </Button>
        </SimpleTooltip>
      </div>
    </li>
  );
}

/** A row's shape while the first list loads, so the list does not jump when it lands. */
export function ErrorIssueRowSkeleton(): React.JSX.Element {
  return (
    <div
      aria-hidden
      data-testid="issue-row-skeleton"
      className="flex items-center gap-3 py-3 pl-2 pr-2.5"
    >
      <Skeleton className="h-9 w-1 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="hidden h-5 w-24 @2xl/issues:block" />
      <Skeleton className="h-6 w-12" />
      <Skeleton className="h-6 w-16" />
    </div>
  );
}
