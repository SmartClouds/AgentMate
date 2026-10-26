import type { AgentHistorySession } from '@runova/core';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { ChevronDown, Copy, GitBranch, Play, Search } from '@/components/icons';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { HISTORY_CLI_ID } from '@/lib/workspace/launch';
import {
  groupByDay,
  type HistoryProvider,
  PROVIDER_LABEL,
  type ProviderFilter,
} from './historyFilters';
import { shortModel } from './modelLabel';
import { SessionUsageMenu } from './SessionUsageMenu';

/**
 * The rows, toolbar and placeholders of an AI conversation history list. Presentational only:
 * the caller owns the data, the filters and what resuming means (a local tab, an SSH tab).
 */

export interface HistoryRowProps {
  session: AgentHistorySession;
  /** The tab already running this conversation, if any. */
  openTabId?: string;
  onResume: (session: AgentHistorySession) => void;
  /** Why the conversation cannot be resumed right now. Set, it turns the resume actions off. */
  resumeDisabledReason?: string | null;
  /**
   * Right-clicking the row shows the tokens and cost the conversation used. Off for a
   * conversation on another machine, whose log this one cannot read.
   */
  showUsage?: boolean;
}

export function HistoryRow({
  session,
  openTabId,
  onResume,
  resumeDisabledReason,
  showUsage,
}: HistoryRowProps): React.JSX.Element {
  const blocked = Boolean(resumeDisabledReason);
  const headline = session.title ?? session.firstPrompt ?? 'Untitled conversation';
  const run = [
    session.model ? shortModel(session.model) : null,
    session.effort ? `${session.effort} effort` : null,
  ].filter(Boolean);
  const meta = [timeAgo(new Date(session.updatedAt).toISOString()), ...run];

  function resume(): void {
    if (!blocked) onResume(session);
  }

  const details = (
    <div className="max-w-[20rem] space-y-1.5 py-0.5 text-left">
      {session.title && session.firstPrompt ? (
        <p className="font-medium leading-snug">{session.title}</p>
      ) : null}
      {session.firstPrompt ? (
        <p className="leading-snug text-muted-foreground">
          <span className="text-foreground/80">First: </span>
          {session.firstPrompt}
        </p>
      ) : null}
      {session.lastPrompt ? (
        <p className="leading-snug text-muted-foreground">
          <span className="text-foreground/80">Last: </span>
          {session.lastPrompt}
        </p>
      ) : null}
      {run.length > 0 ? (
        <p className="leading-snug text-muted-foreground">
          <span className="text-foreground/80">Ran on: </span>
          {run.join(' · ')}
        </p>
      ) : null}
      <p className="text-[10px] text-muted-foreground">
        {PROVIDER_LABEL[session.provider]}
        {session.startedAt ? ` · started ${new Date(session.startedAt).toLocaleString()}` : ''}
      </p>
      {resumeDisabledReason ? (
        <p className="text-[10px] text-warning">{resumeDisabledReason}</p>
      ) : null}
    </div>
  );

  const row = (
    <div className="group/history relative mx-1">
      <SimpleTooltip label={details} side="left">
        {/* Not `disabled`: a disabled trigger never opens its tooltip, and the details still
            matter when the conversation cannot be resumed. */}
        <button
          type="button"
          onClick={resume}
          aria-disabled={blocked || undefined}
          className={cn(
            'flex w-full items-start gap-2 rounded-md py-1.5 pl-2 pr-2 text-left group-focus-within/history:pr-12 group-hover/history:pr-12 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            blocked ? 'cursor-default' : 'hover:bg-foreground/[0.05]',
            openTabId && 'bg-primary/[0.07]',
          )}
        >
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-foreground/[0.06]">
            <CliLogo cliId={HISTORY_CLI_ID[session.provider]} className="h-2.5 w-2.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-[12px] leading-4',
                session.title ? 'font-medium' : 'text-foreground/90',
              )}
            >
              {headline}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-muted-foreground">
              {openTabId ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  Open
                </span>
              ) : null}
              <span className="truncate tabular-nums">{meta.join(' · ')}</span>
              {session.gitBranch ? (
                <span className="inline-flex min-w-0 items-center gap-0.5">
                  <GitBranch className="h-2 w-2 shrink-0" />
                  <span className="truncate font-mono">{session.gitBranch}</span>
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </SimpleTooltip>
      <span className="absolute right-1 top-1.5 hidden items-center gap-0.5 group-focus-within/history:flex group-hover/history:flex">
        <SimpleTooltip label="Copy conversation id">
          <button
            type="button"
            aria-label="Copy conversation id"
            onClick={() => {
              void navigator.clipboard.writeText(session.id);
              toast.success('Conversation id copied');
            }}
            className="flex h-5 w-5 items-center justify-center rounded bg-card text-muted-foreground shadow-sm hover:bg-foreground/10 hover:text-foreground"
          >
            <Copy className="h-2.5 w-2.5" />
          </button>
        </SimpleTooltip>
        {openTabId ? null : (
          <SimpleTooltip
            label={resumeDisabledReason || 'Resume in a new tab'}
            wrapTrigger={blocked}
          >
            <button
              type="button"
              aria-label="Resume in a new tab"
              onClick={resume}
              disabled={blocked}
              className="flex h-5 w-5 items-center justify-center rounded bg-primary/15 text-primary shadow-sm hover:bg-primary/25 disabled:cursor-not-allowed disabled:bg-foreground/[0.06] disabled:text-muted-foreground"
            >
              <Play className="h-2 w-2" />
            </button>
          </SimpleTooltip>
        )}
      </span>
    </div>
  );

  if (!showUsage) return row;
  // The trigger is the whole row, so a right-click on the hover buttons opens the menu too.
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <SessionUsageMenu session={session} />
    </ContextMenu>
  );
}

export interface HistoryToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  provider: ProviderFilter;
  onProviderChange: (provider: ProviderFilter) => void;
  /** The agents present in the list; the agent filter shows only when there are several. */
  providers: ReadonlySet<HistoryProvider>;
  /** Conversations per agent, shown as counts in the agent filter menu. */
  counts?: ReadonlyMap<HistoryProvider, number>;
}

export function HistoryToolbar({
  query,
  onQueryChange,
  provider,
  onProviderChange,
  providers,
  counts,
}: HistoryToolbarProps): React.JSX.Element {
  // Busiest agent first, so the likeliest pick sits at the top of the menu.
  const ordered = [...providers].sort(
    (a, b) =>
      (counts?.get(b) ?? 0) - (counts?.get(a) ?? 0) ||
      PROVIDER_LABEL[a].localeCompare(PROVIDER_LABEL[b]),
  );
  const total = ordered.reduce((sum, p) => sum + (counts?.get(p) ?? 0), 0);
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
      <Search className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search conversations"
        aria-label="Search conversations"
        className="h-6 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/70"
      />
      {providers.size > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Filter by agent"
            className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-foreground/[0.05] px-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:shrink-0"
          >
            {provider === 'all' ? null : (
              <CliLogo cliId={HISTORY_CLI_ID[provider]} className="h-2.5 w-2.5" />
            )}
            <span className="max-w-24 truncate">
              {provider === 'all' ? 'All agents' : PROVIDER_LABEL[provider]}
            </span>
            <ChevronDown className="h-2 w-2 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Agent">
            <DropdownMenuRadioGroup
              value={provider}
              onValueChange={(value) => onProviderChange(value as ProviderFilter)}
            >
              <DropdownMenuRadioItem value="all">
                <span className="flex-1">All agents</span>
                <span className="tabular-nums text-muted-foreground">{total}</span>
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {ordered.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <CliLogo cliId={HISTORY_CLI_ID[value]} className="h-3 w-3" />
                  <span className="flex-1">{PROVIDER_LABEL[value]}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {counts?.get(value) ?? 0}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** Shimmering stand-ins for history rows while the list loads. */
export function HistorySkeleton({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="space-y-2.5 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-1">
            <Skeleton className="h-3 rounded" style={{ width: `${Math.max(85 - i * 12, 30)}%` }} />
            <Skeleton className="h-2.5 w-16 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface HistoryDayGroupsProps {
  /** Already filtered and sorted newest first. */
  sessions: readonly AgentHistorySession[];
  /** Conversation id to the tab running it. */
  openIds: ReadonlyMap<string, string>;
  onResume: (session: AgentHistorySession) => void;
  resumeDisabledReason?: (session: AgentHistorySession) => string | null;
  /** Offer the tokens and cost menu on every row, see `HistoryRowProps.showUsage`. */
  showUsage?: boolean;
}

/** History rows under Today, Yesterday, This week and so on. */
export function HistoryDayGroups({
  sessions,
  openIds,
  onResume,
  resumeDisabledReason,
  showUsage,
}: HistoryDayGroupsProps): React.JSX.Element {
  const groups = groupByDay(sessions, new Date());
  return (
    <>
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            {group.label}
          </p>
          {group.items.map((session) => (
            <HistoryRow
              key={`${session.provider}:${session.id}`}
              session={session}
              openTabId={openIds.get(session.id)}
              onResume={onResume}
              resumeDisabledReason={resumeDisabledReason?.(session)}
              showUsage={showUsage}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export interface BackgroundToggleProps {
  /** Runs started by tools that the current filters would show. Nothing renders at zero. */
  count: number;
  shown: boolean;
  onToggle: () => void;
}

export function BackgroundToggle({
  count,
  shown,
  onToggle,
}: BackgroundToggleProps): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mx-3 mt-1.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {shown
        ? 'Hide runs started by tools'
        : `Show ${count} run${count === 1 ? '' : 's'} started by tools`}
    </button>
  );
}
