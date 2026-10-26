import type { AppNotification } from '@runova/core';
import type { GithubActionsActivity, GithubActionsHistoryItem } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Ban,
  Check,
  CircleCheck,
  Clock,
  ExternalLink,
  FolderKanban,
  GitBranch,
  Github,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Chip, type ChipTone, SECTION_HEADING } from '@/components/pageKit';
import { CopyRunErrorButton } from '@/components/pipelines/CopyRunErrorButton';
import {
  RunAnnotations,
  useRunAnnotations,
  useSeenOnce,
} from '@/components/pipelines/RunAnnotations';
import { type RunnerRunTarget, RunnersPanel } from '@/components/pipelines/RunnersPanel';
import {
  type RunOutcome,
  type RunTone,
  runDuration,
  runTone,
  withWarnings,
} from '@/components/pipelines/runStatus';
import { StopRunButton } from '@/components/pipelines/StopRunButton';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { RefreshFailureBell, refreshTooltip } from '@/components/ui/refresh-failure-bell';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { appRoute } from '@/hooks/useAppNotificationMessages';
import { useLastGoodData } from '@/hooks/useLastGoodData';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';
import { useTerminalStore } from '@/stores/terminalStore';

const GH_INSTALL_URL = 'https://cli.github.com/';

/** The page's cards: the app's glass card, rounded like the API Client and Settings cards. */
const PANEL = 'glass flex min-h-0 flex-col overflow-hidden rounded-[calc(var(--radius)+2px)]';

/** A card's title bar, with the request tab strip's soft hairline under it. */
const CARD_HEADER =
  'flex h-11 shrink-0 items-center gap-2 pl-4 pr-2 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]';

type FilterKey = 'all' | 'running' | 'passed' | 'failed' | 'other';

const FILTERS: { key: FilterKey; label: string; matches: (outcome: RunOutcome) => boolean }[] = [
  { key: 'all', label: 'All', matches: () => true },
  {
    key: 'running',
    label: 'Running',
    matches: (outcome) => outcome === 'running' || outcome === 'queued',
  },
  { key: 'passed', label: 'Passed', matches: (outcome) => outcome === 'passed' },
  { key: 'failed', label: 'Failed', matches: (outcome) => outcome === 'failed' },
  {
    key: 'other',
    label: 'Cancelled',
    matches: (outcome) => outcome === 'cancelled' || outcome === 'other',
  },
];

/** The dot in front of each status filter, in the colour its runs are drawn in. */
const FILTER_DOT: Record<FilterKey, string> = {
  all: 'bg-primary',
  running: 'bg-warning',
  passed: 'bg-success',
  failed: 'bg-destructive',
  other: 'bg-muted-foreground/60',
};

/**
 * A run's colours from the theme tokens. runStatus.tsx is shared with the dashboard and draws
 * with fixed palette colours, so this page maps the tone itself.
 */
function toneColours(tone: RunTone): { chip: ChipTone; tile: string; bar: string } {
  if (tone.outcome === 'failed') {
    return {
      chip: 'destructive',
      tile: 'bg-destructive/12 text-destructive',
      bar: 'bg-destructive',
    };
  }
  if (tone.warned || tone.outcome === 'running' || tone.outcome === 'queued') {
    return { chip: 'warning', tile: 'bg-warning/12 text-warning', bar: 'bg-warning' };
  }
  if (tone.outcome === 'passed') {
    return { chip: 'success', tile: 'bg-success/12 text-success', bar: 'bg-success' };
  }
  return {
    chip: 'neutral',
    tile: 'bg-foreground/[0.06] text-muted-foreground',
    bar: 'bg-muted-foreground/40',
  };
}

function RunGlyph({ tone }: { tone: RunTone }): React.JSX.Element {
  const icon =
    tone.outcome === 'failed' || tone.warned ? (
      <TriangleAlert className="h-3.5 w-3.5" />
    ) : tone.outcome === 'running' ? (
      <Play className="h-3.5 w-3.5" />
    ) : tone.outcome === 'queued' ? (
      <Clock className="h-3.5 w-3.5" />
    ) : tone.outcome === 'passed' ? (
      <CircleCheck className="h-3.5 w-3.5" />
    ) : (
      <Ban className="h-3.5 w-3.5" />
    );
  return (
    <span
      className={cn(
        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        toneColours(tone).tile,
      )}
    >
      {icon}
    </span>
  );
}

function matchesSearch(item: GithubActionsHistoryItem, query: string): boolean {
  const haystack = [
    item.displayTitle,
    item.workflowName,
    item.repo,
    item.projectName,
    item.headBranch,
    `#${item.runNumber}`,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Whatever is standing between the user and a run list: no CLI, no login, no repos, no runs. */
function SetupHint({
  activity,
  onSignIn,
  onRetry,
  retrying,
}: {
  activity: GithubActionsActivity | undefined;
  onSignIn: () => void;
  onRetry: () => void;
  retrying: boolean;
}): React.JSX.Element {
  let body: React.ReactNode = 'No workflow runs yet.';
  // A network hiccup (TLS handshake, DNS, rate limit) is the one failure the user
  // can fix by simply asking again, so only that case gets a retry button.
  let failed = false;
  if (activity?.cliAvailable === false) {
    body = (
      <>
        Install the{' '}
        <button
          type="button"
          className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => void window.runova.shell.openExternal(GH_INSTALL_URL)}
        >
          GitHub CLI
        </button>{' '}
        to see your Actions history here.
      </>
    );
  } else if (activity?.authenticated === false) {
    body = (
      <>
        Run{' '}
        <button
          type="button"
          className="cursor-pointer rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-foreground transition-colors hover:bg-primary/12 hover:text-primary"
          onClick={onSignIn}
        >
          gh auth login
        </button>{' '}
        to load runs from your repos.
      </>
    );
  } else if (activity?.error) {
    // The raw gh/API failure is long and unreadable in the middle of the page,
    // so it lives in a tooltip and the page just says the load did not work.
    body = (
      <SimpleTooltip label={activity.error} className="max-w-sm" wrapTrigger>
        <span className="cursor-help underline decoration-dotted underline-offset-4">
          Could not load runs from GitHub.
        </span>
      </SimpleTooltip>
    );
    failed = true;
  } else if ((activity?.repoCount ?? 0) === 0) {
    body = 'Add a GitHub remote on a project and its Actions runs show up here.';
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
        <Github className="h-6 w-6" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold tracking-tight">GitHub Actions</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {failed ? (
        <Button disabled={retrying} onClick={onRetry}>
          <RefreshCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} />
          {retrying ? 'Retrying...' : 'Try again'}
        </Button>
      ) : null}
    </div>
  );
}

function RunRow({
  item,
  unread,
  focused,
  rowRef,
  onOpen,
  onOpenProject,
}: {
  item: GithubActionsHistoryItem;
  unread: boolean;
  /** The run someone arrived here to see, e.g. from the desktop pet. */
  focused: boolean;
  rowRef: (node: HTMLLIElement | null) => void;
  onOpen: () => void;
  onOpenProject: () => void;
}): React.JSX.Element {
  const [seenRef, seen] = useSeenOnce<HTMLLIElement>();
  const annotationsQuery = useRunAnnotations(item, seen);
  const annotations = annotationsQuery.data?.ok ? annotationsQuery.data : null;
  const tone = withWarnings(runTone(item), annotations?.counts.warning ?? 0);
  const colours = toneColours(tone);
  const failed = tone.outcome === 'failed';
  const duration = runDuration(item);

  return (
    <li
      ref={(node) => {
        rowRef(node);
        seenRef(node);
      }}
      className={cn(
        'relative rounded-lg transition-shadow',
        unread && 'bg-destructive/[0.04]',
        focused && 'run-blink ring-2 ring-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]',
      )}
    >
      {/* The main menu's small accent bar, in the run's colour. */}
      <span
        aria-hidden
        className={cn('absolute left-0 top-4 h-5 w-[3px] rounded-full', colours.bar)}
      />
      <div className="flex items-start gap-1 py-1.5 pl-1.5 pr-1.5">
        <button
          type="button"
          disabled={!item.htmlUrl}
          onClick={onOpen}
          className="group/run flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-foreground/[0.05] focus:outline-none focus-visible:bg-foreground/[0.06] disabled:cursor-default disabled:hover:bg-transparent"
        >
          <RunGlyph tone={tone} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[13px] font-medium leading-snug">
                {item.displayTitle || item.workflowName}
              </span>
              <Chip tone={colours.chip}>{tone.label}</Chip>
              {unread ? <Chip tone="destructive">New</Chip> : null}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="truncate font-mono">{item.repo}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{item.workflowName}</span>
              {item.headBranch ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <GitBranch className="h-2.5 w-2.5 shrink-0 opacity-70" />
                    <span className="truncate">{item.headBranch}</span>
                  </span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span className="tabular-nums">#{item.runNumber}</span>
              {duration ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{duration}</span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span className="tabular-nums">{timeAgo(item.updatedAt)}</span>
            </span>
          </span>
          {item.htmlUrl ? (
            <ExternalLink className="mt-2 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/run:text-muted-foreground" />
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pt-1.5">
          {failed ? (
            <CopyRunErrorButton
              input={{
                repo: item.repo,
                runId: item.id,
                workflowName: item.workflowName,
                displayTitle: item.displayTitle,
                runNumber: item.runNumber,
                headBranch: item.headBranch,
              }}
            />
          ) : null}
          {item.status !== 'completed' ? <StopRunButton item={item} /> : null}
          {item.projectId ? (
            <SimpleTooltip label={`Open ${item.projectName}`}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Open ${item.projectName}`}
                onClick={onOpenProject}
              >
                <FolderKanban className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
          ) : null}
        </div>
      </div>
      {annotations ? (
        <RunAnnotations
          run={item}
          annotations={annotations.annotations}
          counts={annotations.counts}
        />
      ) : null}
    </li>
  );
}

/** One row in the filter card: the main menu's row, with its sliding pill and accent bar. */
function FilterRow({
  active,
  label,
  count,
  leading,
  mono = false,
  layoutId,
  pillTransition,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  leading: React.ReactNode;
  mono?: boolean;
  layoutId: string;
  pillTransition: React.ComponentProps<typeof motion.span>['transition'];
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // `isolate` keeps the pill behind the row's text without lifting every child.
        'relative isolate flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'font-medium text-primary'
          : 'text-foreground/85 hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId={layoutId}
          transition={pillTransition}
          className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
        >
          <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
        </motion.span>
      )}
      {leading}
      <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>{label}</span>
      <span
        className={cn(
          'shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums',
          active ? 'bg-primary/15 text-primary' : 'bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading runs" className="flex flex-col gap-1 p-2">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FiltersSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 p-2 pt-3">
      <Skeleton className="mb-2 h-8 w-full rounded-full" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-7 w-full rounded-lg" />
      ))}
    </div>
  );
}

export default function PipelinesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openSession = useTerminalStore((s) => s.openSession);
  usePageHeader('Pipelines', 'Every GitHub Actions run across your projects.');

  const [filter, setFilter] = useState<FilterKey>('all');
  const [repo, setRepo] = useState('');
  const [search, setSearch] = useState('');
  /** A run asked for by a deep link, waiting for the list to load. */
  const [pendingFocus, setPendingFocus] = useState<{ runId: number; repo: string } | null>(null);
  /**
   * The run being pointed at. A new object for every focus, even of the same run, so the scroll
   * and the blink happen again on a second click.
   */
  const [focus, setFocus] = useState<{ runId: number; nonce: number } | null>(null);
  const focusCount = useRef(0);
  const focusedRunId = focus?.runId ?? null;
  /** Bumped by the Refresh button, which tells the runner panel to look again too. */
  const [runnersRefresh, setRunnersRefresh] = useState(0);
  const rowNodes = useRef(new Map<number, HTMLLIElement>());
  const [sidebarWidth, setSidebarWidth] = usePanelWidth('pipelinesFilters');
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  const bindRow = useCallback((runId: number) => {
    return (node: HTMLLIElement | null): void => {
      if (node) rowNodes.current.set(runId, node);
      else rowNodes.current.delete(runId);
    };
  }, []);

  const activityQuery = useQuery({
    queryKey: queryKeys.githubActionsActivity,
    queryFn: () => window.runova.pipelines.dashboardActivity(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const notificationsQuery = useQuery({
    queryKey: queryKeys.appNotifications,
    queryFn: () => window.runova.appNotifications.list(),
  });

  useEffect(() => {
    return window.runova.appNotifications.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotifications });
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotificationUnread });
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubActionsActivity });
    });
  }, [queryClient]);

  // `/pipelines?run=123&repo=owner/name`, the route the desktop pet opens after
  // announcing a failure. Filters get cleared so the run cannot be hidden by
  // whatever was set last time, and the query string is dropped once it is read
  // so a later refresh does not jump around again. The list is refreshed first:
  // a run that failed seconds ago is not in a cached response yet, and without
  // that it would look like it had dropped off.
  useEffect(() => {
    const runId = Number(searchParams.get('run'));
    if (!Number.isInteger(runId) || runId <= 0) return;
    const wanted = { runId, repo: searchParams.get('repo') ?? '' };
    setFilter('all');
    setRepo('');
    setSearch('');
    setSearchParams({}, { replace: true });
    let live = true;
    void queryClient
      .refetchQueries({ queryKey: queryKeys.githubActionsActivity })
      .catch(() => undefined)
      .finally(() => {
        if (live) setPendingFocus(wanted);
      });
    return () => {
      live = false;
    };
  }, [queryClient, searchParams, setSearchParams]);

  const markRead = useMutation({
    mutationFn: (id: string) => window.runova.appNotifications.markRead(id),
    onSuccess: (items) => {
      queryClient.setQueryData(queryKeys.appNotifications, items);
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotificationUnread });
    },
  });
  const markAllRead = useMutation({
    mutationFn: () => window.runova.appNotifications.markAllRead(),
    onSuccess: (items) => {
      queryClient.setQueryData(queryKeys.appNotifications, items);
      void queryClient.invalidateQueries({ queryKey: queryKeys.appNotificationUnread });
    },
  });

  // A failed refresh keeps the last list that loaded on screen and flags it on the refresh button.
  const lastGood = useLastGoodData({
    storageKey: 'github-actions-activity',
    query: activityQuery,
    failureOf: (result) => (result.ok ? null : result.error || 'GitHub did not return any runs.'),
    title: 'Could not refresh runs',
  });

  const activity = lastGood.data;
  const runs = useMemo(() => activity?.runs ?? [], [activity]);
  const notifications: AppNotification[] = notificationsQuery.data ?? [];
  const unreadCount = notifications.filter((item) => !item.read).length;

  /** Failure notices the watcher raised, keyed by run URL so a row can show its unread state. */
  const unreadByUrl = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of notifications) {
      if (!item.read && item.htmlUrl) map.set(item.htmlUrl, item.id);
    }
    return map;
  }, [notifications]);

  /**
   * Unread notices that belong to a page elsewhere in the app (a Deploy server's alert, say).
   * They have no run row to mark, so they get rows of their own that open their page.
   */
  const elsewhere = useMemo(
    () =>
      notifications.flatMap((item) => {
        const route = !item.read && !item.htmlUrl ? appRoute(item) : null;
        return route ? [{ item, route }] : [];
      }),
    [notifications],
  );

  const counts = useMemo(() => {
    const tally: Record<FilterKey, number> = {
      all: runs.length,
      running: 0,
      passed: 0,
      failed: 0,
      other: 0,
    };
    for (const run of runs) {
      const { outcome } = runTone(run);
      for (const entry of FILTERS) {
        if (entry.key !== 'all' && entry.matches(outcome)) tally[entry.key] += 1;
      }
    }
    return tally;
  }, [runs]);

  /** Every repo with a run in the list, by name, with how many runs it has and how many failed. */
  const repos = useMemo(() => {
    const tally = new Map<string, { count: number; failed: number }>();
    for (const run of runs) {
      const entry = tally.get(run.repo) ?? { count: 0, failed: 0 };
      entry.count += 1;
      if (runTone(run).outcome === 'failed') entry.failed += 1;
      tally.set(run.repo, entry);
    }
    return [...tally.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({ name, ...entry }));
  }, [runs]);

  const visible = useMemo(() => {
    const entry = FILTERS.find((item) => item.key === filter) ?? FILTERS[0];
    const query = search.trim();
    return runs.filter((run) => {
      if (!entry.matches(runTone(run).outcome)) return false;
      if (repo && run.repo !== repo) return false;
      if (query && !matchesSearch(run, query)) return false;
      return true;
    });
  }, [filter, repo, runs, search]);

  // The list is in by now, so find the requested run and point at it.
  useEffect(() => {
    if (!pendingFocus) return;
    const match = runs.find(
      (run) =>
        run.id === pendingFocus.runId && (!pendingFocus.repo || run.repo === pendingFocus.repo),
    );
    setPendingFocus(null);
    if (!match) {
      // With no runs at all the page already explains itself, so stay quiet.
      if (runs.length > 0) toast.info('That run has dropped off the recent list.');
      return;
    }
    focusCount.current += 1;
    setFocus({ runId: match.id, nonce: focusCount.current });
  }, [pendingFocus, runs]);

  // Scroll it into view and start the blink over. This lives apart from the effect above,
  // which re-runs as soon as it clears pendingFocus and would cancel the frame. The frame
  // wait lets the rows the filter reset just brought back mount.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const node = rowNodes.current.get(focus.runId);
      if (!node) return;
      // A second click on the same run leaves the class in place, so the CSS animation would
      // not run again by itself. jsdom has no getAnimations, hence the check.
      if (typeof node.getAnimations === 'function') {
        for (const animation of node.getAnimations()) {
          if ('animationName' in animation && animation.animationName === 'run-blink') {
            animation.currentTime = 0;
            animation.play();
          }
        }
      }
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  // The ring is a "here it is" pointer, not a state, so it fades on its own.
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setFocus(null), 6000);
    return () => clearTimeout(timer);
  }, [focus]);

  const loading = activityQuery.isPending && activity === undefined;
  const connected = activity?.ok === true && activity.cliAvailable && activity.authenticated;
  const ready = connected && runs.length > 0;
  const filtersDirty = filter !== 'all' || repo !== '' || search.trim() !== '';
  const repoCount = activity?.repoCount ?? 0;

  function clearFilters(): void {
    setFilter('all');
    setRepo('');
    setSearch('');
  }

  function handleSignIn(): void {
    openSession({ title: 'GitHub login', initialInput: 'gh auth login' });
    toast.info('Press Enter in the terminal to sign in to GitHub.');
  }

  function handleRefresh(): void {
    lastGood.refresh();
    // The runner panel has no button of its own, so one refresh covers both. It refetches on
    // its own when the count changes, asking GitHub afresh rather than trusting a recent refusal.
    setRunnersRefresh((count) => count + 1);
  }

  /**
   * A runner's job or a waiting job. A run in the list gets the same treatment as a deep link
   * (filters cleared, scrolled to, ringed); one that has dropped off opens on GitHub instead.
   */
  function focusRun({ runId, repo: runRepo, htmlUrl }: RunnerRunTarget): void {
    if (!runs.some((run) => run.id === runId && run.repo === runRepo)) {
      if (htmlUrl) void window.runova.shell.openExternal(htmlUrl);
      return;
    }
    clearFilters();
    setPendingFocus({ runId, repo: runRepo });
  }

  function handleGrantAccess(): void {
    openSession({
      title: 'GitHub org access',
      initialInput: 'gh auth refresh -h github.com -s admin:org',
    });
    toast.info('Press Enter in the terminal, then approve the new scope in your browser.');
  }

  function handleOpenRun(item: GithubActionsHistoryItem): void {
    const notificationId = item.htmlUrl ? unreadByUrl.get(item.htmlUrl) : undefined;
    if (notificationId) markRead.mutate(notificationId);
    if (item.htmlUrl) void window.runova.shell.openExternal(item.htmlUrl);
  }

  // The run card's title bar. Refresh is always there: it is how a failed or missing load is
  // asked for again, whatever the card below it shows.
  const runsHeader = (
    <div className={CARD_HEADER}>
      <h2 className="text-sm font-semibold tracking-tight">Runs</h2>
      {ready ? (
        <span className="rounded-full bg-foreground/[0.06] px-2 text-[11px] font-medium leading-5 tabular-nums text-muted-foreground">
          {visible.length}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {unreadCount > 0 ? (
          <Button
            variant="soft"
            size="sm"
            disabled={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            <Check className="h-3.5 w-3.5" /> Mark all read
          </Button>
        ) : null}
        <SimpleTooltip
          label={refreshTooltip('Refresh runs', lastGood.failure, lastGood.savedAt)}
          className="max-w-sm"
        >
          <span className="relative inline-flex">
            <Button
              variant="ghost"
              size="icon"
              disabled={activityQuery.isFetching}
              aria-label={lastGood.failure ? 'Refresh runs, last refresh failed' : 'Refresh runs'}
              onClick={handleRefresh}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', activityQuery.isFetching && 'animate-spin')}
              />
            </Button>
            <RefreshFailureBell failure={lastGood.failure} />
          </span>
        </SimpleTooltip>
      </div>
    </div>
  );

  const notices =
    elsewhere.length > 0 ? (
      <div className="space-y-1.5 px-2 pb-1 pt-2">
        <h3 className={cn(SECTION_HEADING, 'px-2')}>Needs attention</h3>
        <ul aria-label="Other notices" className="space-y-1">
          {elsewhere.map(({ item, route }) => (
            <li
              key={item.id}
              className="rounded-lg bg-destructive/[0.05] ring-1 ring-inset ring-destructive/25"
            >
              <button
                type="button"
                onClick={() => {
                  markRead.mutate(item.id);
                  navigate(route);
                }}
                className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-destructive/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium leading-snug">{item.title}</span>
                    <Chip tone="destructive">New</Chip>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{item.body}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {timeAgo(item.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const runsBody = loading ? (
    <ListSkeleton />
  ) : !ready ? (
    <SetupHint
      activity={activity}
      onSignIn={handleSignIn}
      onRetry={handleRefresh}
      retrying={activityQuery.isFetching}
    />
  ) : visible.length === 0 ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-14 text-center">
      <Search className="h-5 w-5 text-muted-foreground/60" />
      <div className="space-y-1">
        <p className="text-sm font-medium">No runs match these filters</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {runs.length} run{runs.length === 1 ? '' : 's'} loaded across {repoCount} repo
          {repoCount === 1 ? '' : 's'}.
        </p>
      </div>
      <Button variant="soft" onClick={clearFilters}>
        <X className="h-3.5 w-3.5" /> Clear filters
      </Button>
    </div>
  ) : (
    <>
      <ul aria-label="Workflow runs" className="settings-rows px-2 pt-1">
        {visible.map((item) => (
          <RunRow
            key={`${item.repo}-${item.id}`}
            item={item}
            unread={item.htmlUrl ? unreadByUrl.has(item.htmlUrl) : false}
            focused={focusedRunId === item.id}
            rowRef={bindRow(item.id)}
            onOpen={() => handleOpenRun(item)}
            onOpenProject={() => {
              if (item.projectId) navigate(`/projects/${item.projectId}?tab=git`);
            }}
          />
        ))}
      </ul>
      <p className="px-4 pb-4 pt-2 text-center text-[11px] text-muted-foreground">
        Showing {visible.length} of {runs.length} runs across {repoCount} repo
        {repoCount === 1 ? '' : 's'}.
      </p>
    </>
  );

  const runsCard = (
    <section aria-label="Runs" className={cn(PANEL, 'min-w-0 flex-1')}>
      {runsHeader}
      <div className="rail-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {notices}
        {runsBody}
      </div>
    </section>
  );

  // Filters only make sense once there are runs to filter; until then the run card stands alone.
  const showFilters = loading || ready;

  return (
    // The page already sits in the content island, so its areas are glass cards on it with a
    // small gap between them, the way the API Client lays out its sidebar and request area.
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
      {connected ? (
        <RunnersPanel
          runs={runs}
          refreshCount={runnersRefresh}
          onFocusRun={focusRun}
          onGrantAccess={handleGrantAccess}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {showFilters ? (
          <>
            <aside
              aria-label="Run filters"
              // The cap keeps a wide saved width from squeezing the run list on a narrow window.
              style={{ width: sidebarWidth, maxWidth: '38%' }}
              className={cn(PANEL, 'shrink-0')}
            >
              {loading ? (
                <FiltersSkeleton />
              ) : (
                <>
                  <div className="flex h-11 shrink-0 items-center gap-1 pl-3.5 pr-2">
                    <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Filters</h2>
                    {filtersDirty ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={clearFilters}
                        className="shrink-0 text-muted-foreground"
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <div className="shrink-0 px-2 pb-2">
                    <div className="search-pill flex h-8 items-center gap-1.5 rounded-full pl-3 pr-1 transition-colors">
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && search) {
                            event.preventDefault();
                            event.stopPropagation();
                            setSearch('');
                          }
                        }}
                        placeholder="Search runs"
                        aria-label="Search runs"
                        spellCheck={false}
                        className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
                      />
                      {search ? (
                        <button
                          type="button"
                          aria-label="Clear search"
                          onClick={() => setSearch('')}
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    <LayoutGroup id="pipelines-status">
                      <div role="group" aria-label="Status" className="flex flex-col gap-px">
                        <h3 className={cn(SECTION_HEADING, 'px-2.5 pb-1 pt-1')}>Status</h3>
                        {FILTERS.map((entry) => (
                          <FilterRow
                            key={entry.key}
                            active={filter === entry.key}
                            label={entry.label}
                            count={counts[entry.key]}
                            layoutId="pipelines-status-active"
                            pillTransition={pillTransition}
                            leading={
                              <span
                                aria-hidden
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  FILTER_DOT[entry.key],
                                )}
                              />
                            }
                            onClick={() => setFilter(entry.key)}
                          />
                        ))}
                      </div>
                    </LayoutGroup>
                    <LayoutGroup id="pipelines-repos">
                      <div
                        role="group"
                        aria-label="Repositories"
                        className="mt-3 flex flex-col gap-px"
                      >
                        <h3 className={cn(SECTION_HEADING, 'px-2.5 pb-1 pt-1')}>Repositories</h3>
                        <FilterRow
                          active={repo === ''}
                          label="All repos"
                          count={runs.length}
                          layoutId="pipelines-repo-active"
                          pillTransition={pillTransition}
                          leading={
                            <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          }
                          onClick={() => setRepo('')}
                        />
                        {repos.map((entry) => (
                          <FilterRow
                            key={entry.name}
                            active={repo === entry.name}
                            label={entry.name}
                            count={entry.count}
                            mono
                            layoutId="pipelines-repo-active"
                            pillTransition={pillTransition}
                            leading={
                              <span
                                aria-hidden
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  entry.failed > 0 ? 'bg-destructive' : 'bg-success',
                                )}
                              />
                            }
                            onClick={() => setRepo(entry.name)}
                          />
                        ))}
                      </div>
                    </LayoutGroup>
                  </div>
                </>
              )}
            </aside>
            <ResizeHandle
              orientation="vertical"
              label="Resize filters"
              size={sidebarWidth}
              min={PANEL_WIDTHS.pipelinesFilters.min}
              max={PANEL_WIDTHS.pipelinesFilters.max}
              defaultSize={PANEL_WIDTHS.pipelinesFilters.default}
              onSizeChange={setSidebarWidth}
              quiet
              className="w-2"
            />
          </>
        ) : null}
        {runsCard}
      </div>
    </div>
  );
}
