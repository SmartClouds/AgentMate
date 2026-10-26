import { mergeBlockers, type PullRequestInfo, summarizeChecks } from '@runova/core';
import { CircleCheck, ExternalLink, GitMerge, MessageSquare } from '@/components/icons';
import { SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PrPill, type PrTone } from './PrCard';
import { checksSummaryText } from './PrChecks';
import { REVIEW_DECISIONS } from './PrReview';

function statePill(pr: PullRequestInfo): { label: string; tone: PrTone } {
  if (pr.state === 'MERGED') return { label: 'Merged', tone: 'success' };
  if (pr.state === 'CLOSED') return { label: 'Closed', tone: 'destructive' };
  if (pr.isDraft) return { label: 'Draft', tone: 'default' };
  return { label: 'Open', tone: 'success' };
}

/** Number, title, state and size of the PR, with a way out to GitHub. */
export function PrHeader({ pr }: { pr: PullRequestInfo }): React.JSX.Element {
  const pill = statePill(pr);
  return (
    <header className="space-y-1.5 px-3.5 pb-1 pt-2">
      <div className="flex items-start gap-1.5">
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">
          <span className="mr-1 font-normal text-muted-foreground">#{pr.number}</span>
          <span className="break-words">{pr.title}</span>
        </h3>
        <SimpleTooltip label="Open on GitHub">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Open on GitHub"
            onClick={() => void window.runova.shell.openExternal(pr.url)}
            className="shrink-0"
          >
            <ExternalLink />
          </Button>
        </SimpleTooltip>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <PrPill tone={pill.tone}>{pill.label}</PrPill>
        <span className="min-w-0 truncate font-mono">
          {pr.head} → {pr.base}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          <span className="text-success">+{pr.additions}</span>{' '}
          <span className="text-destructive">−{pr.deletions}</span>
        </span>
      </div>
    </header>
  );
}

const STAT_TEXT: Record<PrTone, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: PrTone;
}): React.JSX.Element {
  return (
    <div className={cn(SECTION_WELL, 'min-w-0 px-3 py-2')}>
      <p className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
        <Icon className="h-2.5 w-2.5" />
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 line-clamp-2 text-[12.5px] font-medium leading-snug',
          STAT_TEXT[tone],
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** Where an open PR stands, at a glance: checks, review and whether it can merge. */
export function prStats(pr: PullRequestInfo): Record<
  'checks' | 'review' | 'merge',
  {
    value: string;
    tone: PrTone;
  }
> {
  const checks = summarizeChecks(pr.checks);
  const open = pr.threads.filter((thread) => !thread.isResolved).length;
  const decision = pr.reviewDecision ? REVIEW_DECISIONS[pr.reviewDecision] : undefined;
  const blockers = mergeBlockers(pr);
  return {
    checks: {
      value: checks.total ? checksSummaryText(pr) : 'No checks',
      tone: checks.failed
        ? 'destructive'
        : checks.running
          ? 'warning'
          : checks.total
            ? 'success'
            : 'default',
    },
    review: {
      value:
        [decision?.label, open ? `${open} open ${open === 1 ? 'thread' : 'threads'}` : null]
          .filter(Boolean)
          .join(' · ') || 'No review needed',
      tone:
        decision?.tone === 'destructive'
          ? 'destructive'
          : open
            ? 'warning'
            : (decision?.tone ?? 'default'),
    },
    merge: blockers.length
      ? { value: blockers[0]!.message, tone: 'warning' }
      : { value: `Ready to merge into ${pr.base}`, tone: 'success' },
  };
}

/** The large view's header: the PR's title, branches and size, then a status strip. */
export function PrOverview({ pr }: { pr: PullRequestInfo }): React.JSX.Element {
  const pill = statePill(pr);
  const stats = prStats(pr);
  return (
    <header className="space-y-3 px-5 pb-4 pt-4 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
      <h2 className="text-lg font-semibold leading-snug">
        <span className="mr-1.5 font-normal text-muted-foreground">#{pr.number}</span>
        <span className="break-words">{pr.title}</span>
      </h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PrPill tone={pill.tone}>{pill.label}</PrPill>
        <span className="min-w-0 truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-foreground/85">
          {pr.head}
        </span>
        <span aria-hidden="true">→</span>
        <span className="min-w-0 truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-foreground/85">
          {pr.base}
        </span>
        <span className="tabular-nums">
          <span className="text-success">+{pr.additions}</span>{' '}
          <span className="text-destructive">−{pr.deletions}</span>
        </span>
      </div>
      {pr.state === 'OPEN' ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat icon={CircleCheck} label="Checks" {...stats.checks} />
          <Stat icon={MessageSquare} label="Review" {...stats.review} />
          <Stat icon={GitMerge} label="Merge" {...stats.merge} />
        </div>
      ) : null}
    </header>
  );
}
