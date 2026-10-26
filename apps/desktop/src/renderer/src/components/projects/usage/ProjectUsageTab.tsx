import type { ProjectUsageReport } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PROVIDER_LABEL } from '@/components/agentHistory/historyFilters';
import { ChartColumn, CircleInfo, RefreshCw } from '@/components/icons';
import { LoadFailure, PillTabs, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { SectionCard, SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { CountUp } from '@/components/usage/CountUp';
import { queryKeys } from '@/lib/queryKeys';
import { formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { formatMoney } from './formatMoney';
import { SpendChart } from './SpendChart';
import { UsageBreakdowns } from './UsageBreakdowns';

type Report = Extract<ProjectUsageReport, { status: 'ok' }>;

const PERIODS = [
  { value: 'all', label: 'All time', days: null },
  { value: '30', label: '30 days', days: 30 },
  { value: '7', label: '7 days', days: 7 },
] as const;

type PeriodValue = (typeof PERIODS)[number]['value'];

const exact = new Intl.NumberFormat();

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** "3 Gemini and 1 Cursor", "3 Gemini, 1 Cursor and 2 Qwen". */
function listCounts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function HeroStat({
  label,
  note,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(SECTION_WELL, 'min-w-0')}>
      <p className={SECTION_HEADING}>{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums tracking-tight">{children}</p>
      <p className="mt-0.5 min-h-4 truncate text-[11px] text-muted-foreground">{note}</p>
    </div>
  );
}

function Headline({ report }: { report: Report }): React.JSX.Element {
  const { tokens, costUsd, costPartial } = report;
  const costText = (n: number): string => `${formatMoney(n) ?? '$0.00'}${costPartial ? '+' : ''}`;
  const agents = report.byAgent.length;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <HeroStat
        label="Est. cost"
        note={costUsd !== null ? 'list price estimate' : 'no known price for these models'}
      >
        {costUsd !== null ? (
          <CountUp value={costUsd} format={costText} className="widget-gradient-text" />
        ) : (
          <span className="text-base text-muted-foreground">
            {tokens.total === 0 ? '$0.00' : 'Unpriced'}
          </span>
        )}
      </HeroStat>
      <HeroStat label="Tokens" note={tokens.total >= 1000 ? exact.format(tokens.total) : undefined}>
        <CountUp value={tokens.total} format={formatTokens} />
      </HeroStat>
      <HeroStat
        label="Conversations"
        note={`across ${agents} ${plural(agents, 'agent', 'agents')}`}
      >
        <CountUp value={report.conversations} format={(n) => String(Math.round(n))} />
      </HeroStat>
    </div>
  );
}

function HeadlineSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading usage" className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[5.75rem] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

function CardsSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-44 rounded-[calc(var(--radius)+2px)]" />
      ))}
    </div>
  );
}

function Footnote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-1.5">
      <CircleInfo className="mt-px h-3 w-3 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

/** Everything that makes the numbers above less than the whole story. */
function Footnotes({ report }: { report: Report }): React.JSX.Element {
  const notCounted = report.uncounted.reduce((n, entry) => n + entry.conversations, 0);
  const worktrees = report.folders - 1;
  return (
    <ul className="space-y-1 px-2 pb-1 pt-0.5 text-[11px] leading-snug text-muted-foreground">
      <Footnote>
        Costs are estimated at public list prices, so they are not what a subscription plan charges
        you.
      </Footnote>
      {report.costPartial ? (
        <Footnote>Some models have no known price, so the cost is a minimum.</Footnote>
      ) : null}
      {worktrees > 0 ? (
        <Footnote>
          {`Counts the project folder and its ${worktrees} git ${plural(worktrees, 'worktree', 'worktrees')}.`}
        </Footnote>
      ) : null}
      {notCounted > 0 ? (
        <Footnote>
          {`${listCounts(
            report.uncounted.map(
              (entry) => `${entry.conversations} ${PROVIDER_LABEL[entry.provider]}`,
            ),
          )} ${plural(notCounted, 'conversation is', 'conversations are')} not counted, since ${plural(
            report.uncounted.length,
            'that agent does',
            'those agents do',
          )} not record token usage.`}
        </Footnote>
      ) : null}
      {report.unreadable > 0 ? (
        <Footnote>
          {`${report.unreadable} ${plural(report.unreadable, 'conversation', 'conversations')} could not be read and ${plural(report.unreadable, 'is', 'are')} left out.`}
        </Footnote>
      ) : null}
      {report.truncated ? (
        <Footnote>Only the newest conversations were read, so older ones are left out.</Footnote>
      ) : null}
      {report.byAgent.some((agent) => agent.provider === 'opencode') ? (
        <Footnote>
          OpenCode keeps one total per conversation, so its usage is dated by the
          conversation&apos;s last update.
        </Footnote>
      ) : null}
    </ul>
  );
}

/**
 * A project's Usage tab: what every agent conversation in it has used and, at list price, cost.
 * Reading a long history takes a few seconds, so each period shimmers in place until it lands.
 */
export function ProjectUsageTab({ projectId }: { projectId: string }): React.JSX.Element {
  const [period, setPeriod] = useState<PeriodValue>('all');
  const days = PERIODS.find((entry) => entry.value === period)?.days ?? null;

  const usage = useQuery({
    queryKey: queryKeys.projectUsage(projectId, days),
    queryFn: () => window.runova.agents.projectUsage(projectId, days),
    staleTime: 30_000,
    meta: { silentLoading: true },
  });

  // Typed outright: the inferred query type does not narrow in a conditional expression.
  const data: ProjectUsageReport | undefined = usage.data;
  const report = data?.status === 'ok' ? data : null;
  const failed = usage.isError || (!usage.isPending && !report);
  const hasUsage = report !== null && report.conversations > 0;

  return (
    <div className="space-y-2" aria-busy={usage.isFetching}>
      <SectionCard
        icon={ChartColumn}
        title="Usage and cost"
        description="Tokens and estimated cost of every agent conversation in this project."
        actions={
          <>
            <PillTabs
              id="project-usage-period"
              label="Period"
              kind="toggle"
              size="xs"
              items={PERIODS.map(({ value, label }) => ({ value, label }))}
              value={period}
              onChange={setPeriod}
            />
            <SimpleTooltip label="Read the conversations again">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={usage.isFetching}
                onClick={() => void usage.refetch()}
              >
                <RefreshCw className={cn(usage.isFetching && 'animate-spin')} />
              </Button>
            </SimpleTooltip>
          </>
        }
        bodyClassName="space-y-4"
      >
        {usage.isPending ? <HeadlineSkeleton /> : null}
        {failed ? (
          <LoadFailure
            message={
              data?.status === 'unavailable'
                ? "This project's conversations could not be found."
                : 'Usage could not be read.'
            }
            retry={() => void usage.refetch()}
          />
        ) : null}
        {report && !hasUsage ? (
          <SectionEmptyState
            inset
            icon={ChartColumn}
            title="No usage yet"
            description={
              period === 'all'
                ? 'Once an agent works in this project, its tokens and estimated cost show up here.'
                : 'No agent used tokens in this period. Try a longer period.'
            }
          />
        ) : null}
        {report && hasUsage ? (
          <>
            <Headline report={report} />
            <SpendChart byDay={report.byDay} days={days} />
          </>
        ) : null}
      </SectionCard>

      {usage.isPending ? <CardsSkeleton /> : null}
      {report && hasUsage ? <UsageBreakdowns report={report} /> : null}
      {report ? <Footnotes report={report} /> : null}
    </div>
  );
}
