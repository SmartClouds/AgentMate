import type { GitDayCount, GithubNotificationItem, GithubNotifications } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Bell,
  CircleCheck,
  CircleQuestion,
  ExternalLink,
  GitCommit,
  Github,
  GitPullRequest,
  Medal,
  MessageSquare,
  RefreshCw,
  Spinner,
  Tag,
  X,
} from '@/components/icons';
import { Chip, TileHeader } from '@/components/pageKit';
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
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminalStore';

const GH_INSTALL_URL = 'https://cli.github.com/';
const GH_NOTIFICATIONS_URL = 'https://github.com/notifications';
const QUERY_META = { silentLoading: true } as const;
const WEEKDAY_LABELS = ['', 'M', '', 'W', '', 'F', ''];
const HEATMAP_LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;

const REASON_LABELS: Record<string, string> = {
  assign: 'Assigned',
  author: 'Your thread',
  comment: 'Comment',
  invitation: 'Invitation',
  manual: 'Subscribed',
  mention: 'Mentioned',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  state_change: 'Updated',
  subscribed: 'Watching',
  team_mention: 'Team mention',
  ci_activity: 'CI',
  approval_requested: 'Approval requested',
};

const TYPE_LABELS: Record<string, string> = {
  Issue: 'Issue',
  PullRequest: 'Pull request',
  Commit: 'Commit',
  Release: 'Release',
  Discussion: 'Discussion',
  CheckSuite: 'Check suite',
  RepositoryInvitation: 'Invitation',
  Alert: 'Alert',
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatHeatmapDay(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** GitHub-style 5-step green. `count < 0` is padding outside the fetched range. */
function contributionFill(count: number, max: number): string {
  if (count < 0) return 'transparent';
  if (count === 0) return 'hsl(var(--foreground) / 0.08)';
  const t = count / max;
  if (t <= 0.25) return 'hsl(var(--primary) / 0.35)';
  if (t <= 0.5) return 'hsl(var(--primary) / 0.55)';
  if (t <= 0.75) return 'hsl(var(--primary) / 0.78)';
  return 'hsl(var(--primary))';
}

interface HeatmapDay {
  date: string;
  count: number;
}

function buildWeeks(days: GitDayCount[]): HeatmapDay[][] {
  if (days.length === 0) return [];
  const byDate = new Map(days.map((day) => [day.date, day.count]));
  const first = parseLocalDate(days[0].date);
  const last = parseLocalDate(days[days.length - 1].date);
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() - cursor.getDay());
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const weeks: HeatmapDay[][] = [];
  while (cursor <= end) {
    const week: HeatmapDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = localIsoDate(cursor);
      const inRange = cursor >= first && cursor <= last;
      week.push({ date, count: inRange ? (byDate.get(date) ?? 0) : -1 });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function monthLabel(week: HeatmapDay[]): string | null {
  const firstReal = week.find((day) => day.count >= 0);
  if (!firstReal) return null;
  const date = parseLocalDate(firstReal.date);
  if (date.getDate() > 7) return null;
  return date.toLocaleDateString(undefined, { month: 'short' });
}

function ContributionHeatmap({
  days,
  height,
}: {
  days: GitDayCount[];
  height: number;
}): React.JSX.Element {
  const weeks = useMemo(() => buildWeeks(days), [days]);
  const max = Math.max(1, ...days.map((day) => day.count));
  const labels = weeks.map(monthLabel);

  return (
    <div className="flex min-w-0 gap-1.5" style={{ height }}>
      <div className="flex w-3 shrink-0 flex-col pt-3">
        {WEEKDAY_LABELS.map((label, i) => (
          <span
            key={`wd-${i}`}
            className="flex min-h-0 flex-1 items-center text-[9px] leading-none text-muted-foreground"
          >
            {label}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-3 shrink-0 gap-[3px]">
          {labels.map((label, i) => (
            <span
              key={`mo-${weeks[i]?.[0]?.date ?? i}`}
              className="min-w-0 flex-1 truncate text-[9px] leading-none text-muted-foreground"
            >
              {label ?? ''}
            </span>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 gap-[3px]">
          {weeks.map((week) => (
            <div key={week[0].date} className="flex min-w-0 flex-1 flex-col gap-[3px]">
              {week.map((day) => (
                <div key={day.date} className="min-h-0 min-w-0 flex-1">
                  {day.count < 0 ? null : (
                    <SimpleTooltip
                      label={`${formatHeatmapDay(day.date)}: ${day.count} contribution${day.count === 1 ? '' : 's'}`}
                    >
                      <div
                        className="h-full w-full rounded-[2px]"
                        style={{ background: contributionFill(day.count, max) }}
                      />
                    </SimpleTooltip>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NotificationTypeIcon({ type }: { type: string }): React.JSX.Element {
  const className = 'h-3.5 w-3.5';
  if (type === 'PullRequest') return <GitPullRequest className={className} />;
  if (type === 'Commit') return <GitCommit className={className} />;
  if (type === 'Release') return <Tag className={className} />;
  if (type === 'Discussion') return <MessageSquare className={className} />;
  if (type === 'Issue') return <CircleQuestion className={className} />;
  return <Bell className={className} />;
}

function GhSetupHint({
  cliAvailable,
  onInstall,
  onSignIn,
}: {
  cliAvailable: boolean;
  onInstall: () => void;
  onSignIn: () => void;
}): React.JSX.Element {
  if (!cliAvailable) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Install the{' '}
        <button type="button" className="underline underline-offset-2" onClick={onInstall}>
          GitHub CLI
        </button>{' '}
        to see activity.
      </p>
    );
  }
  return (
    <p className="text-center text-sm text-muted-foreground">
      Run{' '}
      <button type="button" className="underline underline-offset-2" onClick={onSignIn}>
        gh auth login
      </button>{' '}
      to see your GitHub activity.
    </p>
  );
}

function NotificationRow({
  item,
  marking,
  onMarkRead,
}: {
  item: GithubNotificationItem;
  marking: boolean;
  onMarkRead: () => void;
}): React.JSX.Element {
  const reason = REASON_LABELS[item.reason] ?? item.reason.replaceAll('_', ' ');
  const typeLabel = TYPE_LABELS[item.type] ?? item.type;

  return (
    <div className="flex items-start gap-1 px-1 py-1">
      <button
        type="button"
        disabled={!item.url}
        onClick={() => {
          if (item.url) void window.runova.shell.openExternal(item.url);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.05] focus:outline-none focus-visible:bg-foreground/[0.06] disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
          <NotificationTypeIcon type={item.type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-3">
            <span className="line-clamp-2 text-sm font-medium leading-snug">{item.title}</span>
            <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
              {timeAgo(item.updatedAt)}
            </span>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {item.repo}
            </span>
            <Chip>{typeLabel}</Chip>
            <span className="text-[11px] text-muted-foreground">{reason}</span>
          </span>
        </span>
        {item.url && (
          <ExternalLink className="mt-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </button>
      <SimpleTooltip label="Mark as read">
        <Button
          variant="ghost"
          size="icon"
          className="mt-1.5 shrink-0"
          disabled={marking}
          aria-label="Mark as read"
          onClick={onMarkRead}
        >
          {marking ? (
            <Spinner className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CircleCheck className="h-3.5 w-3.5" />
          )}
        </Button>
      </SimpleTooltip>
    </div>
  );
}

export function GithubActivityCard({
  className,
  dragHandle,
  onRemove,
  chartHeight,
}: {
  className?: string;
  dragHandle?: ReactNode;
  onRemove?: () => void;
  chartHeight: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const openSession = useTerminalStore((s) => s.openSession);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const activityQuery = useQuery({
    queryKey: queryKeys.githubActivity,
    queryFn: () => window.runova.git.githubActivity(),
    refetchInterval: 10 * 60_000,
    meta: QUERY_META,
  });
  const notificationsQuery = useQuery({
    queryKey: queryKeys.githubNotifications,
    queryFn: () => window.runova.git.githubNotifications(),
    refetchInterval: 2 * 60_000,
    meta: QUERY_META,
  });

  const markOne = useMutation({
    mutationFn: (threadId: string) => window.runova.git.githubMarkNotificationRead(threadId),
    meta: QUERY_META,
    onSuccess: (result, threadId) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      queryClient.setQueryData<GithubNotifications>(queryKeys.githubNotifications, (current) => {
        if (!current?.ok) return current;
        return {
          ...current,
          notifications: current.notifications.filter((item) => item.id !== threadId),
        };
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Could not mark that notification as read.',
      );
    },
  });

  const markAll = useMutation({
    mutationFn: () => window.runova.git.githubMarkNotificationsRead(),
    meta: QUERY_META,
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      queryClient.setQueryData<GithubNotifications>(queryKeys.githubNotifications, (current) => {
        if (!current?.ok) return current;
        return { ...current, notifications: [] };
      });
      toast.success('All GitHub notifications marked as read.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not mark notifications as read.');
    },
  });

  const activity = activityQuery.data;
  const notifications = notificationsQuery.data?.ok ? notificationsQuery.data.notifications : [];
  const unreadCount = notifications.filter((item) => item.unread).length;

  const weekCount = useMemo(() => {
    const days = activity?.days ?? [];
    return days.slice(-7).reduce((sum, day) => sum + day.count, 0);
  }, [activity?.days]);

  function handleInstallGh(): void {
    void window.runova.shell.openExternal(GH_INSTALL_URL);
  }

  function handleSignIn(): void {
    openSession({ title: 'GitHub login', initialInput: 'gh auth login' });
    toast.info('Press Enter in the terminal to sign in to GitHub.');
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.githubActivity }),
      queryClient.invalidateQueries({ queryKey: queryKeys.githubNotifications }),
    ]);
  }

  const loading = activityQuery.isPending;
  const ready = activity?.ok === true;
  const refreshing = activityQuery.isFetching || notificationsQuery.isFetching;
  const medalLabel =
    unreadCount > 0
      ? `${unreadCount} unread GitHub notification${unreadCount === 1 ? '' : 's'}`
      : 'GitHub notifications';

  return (
    <>
      <div className={className}>
        <div className="flex h-full flex-col p-4">
          <TileHeader
            className="mb-2"
            icon={<Github />}
            title="GitHub Activity"
            actions={
              <>
                <SimpleTooltip label={medalLabel}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="relative"
                    onClick={() => setNotificationsOpen(true)}
                    aria-label={medalLabel}
                  >
                    <Medal className="h-3.5 w-3.5" />
                    {unreadCount > 0 && (
                      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Refresh GitHub activity">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void refreshAll()}
                    disabled={refreshing}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                  </Button>
                </SimpleTooltip>
                {dragHandle}
                {onRemove && (
                  <SimpleTooltip label="Remove from dashboard">
                    <Button variant="ghost" size="icon-sm" onClick={onRemove}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </SimpleTooltip>
                )}
              </>
            }
          />
          <div className="mb-2 flex h-8 items-baseline gap-2">
            {loading ? (
              <>
                <Skeleton className="h-8 w-16 self-center" />
                <Skeleton className="h-3 w-28 self-center" />
              </>
            ) : ready ? (
              <>
                <span className="text-2xl font-semibold tabular-nums">
                  {formatCount(weekCount)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  this week
                  {activity.login ? ` · @${activity.login}` : ''}
                </span>
              </>
            ) : (
              <span className="truncate text-sm text-muted-foreground">Not connected</span>
            )}
          </div>
          <div className="mb-2 flex h-6 items-center justify-between gap-3 overflow-x-auto overflow-y-hidden whitespace-nowrap text-xs text-muted-foreground">
            {ready ? (
              <>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-[10px]">Less</span>
                  {HEATMAP_LEVELS.map((level) => (
                    <span
                      key={level}
                      className="inline-block h-2.5 w-2.5 rounded-[2px]"
                      style={{
                        background: contributionFill(level === 0 ? 0 : Math.ceil(level * 4), 4),
                      }}
                    />
                  ))}
                  <span className="text-[10px]">More</span>
                </span>
                <span className="shrink-0">{formatCount(activity.yearCount)} this year</span>
              </>
            ) : (
              <span className="h-6" />
            )}
          </div>
          {loading ? (
            <Skeleton className="w-full" style={{ height: chartHeight }} />
          ) : ready ? (
            <ContributionHeatmap days={activity.days} height={chartHeight} />
          ) : (
            <div className="flex items-center justify-center px-2" style={{ height: chartHeight }}>
              <GhSetupHint
                cliAvailable={activity?.cliAvailable !== false}
                onInstall={handleInstallGh}
                onSignIn={handleSignIn}
              />
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={notificationsOpen}
        onOpenChange={(open) => {
          setNotificationsOpen(open);
          if (open) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.githubNotifications });
          }
        }}
      >
        <DialogContent
          className="max-w-lg gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader className="px-6 pb-3 pt-6">
            <DialogTitle>GitHub notifications</DialogTitle>
            <DialogDescription>
              {activity?.login
                ? `${unreadCount} unread for @${activity.login}`
                : 'Unread items from the GitHub account signed in on this system.'}
            </DialogDescription>
          </DialogHeader>
          <OverflowScroll className="max-h-[min(24rem,50vh)] px-3">
            {notificationsQuery.isPending ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-start gap-3 px-3 py-3">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !notificationsQuery.data?.ok ? (
              <div className="px-3 py-8">
                <GhSetupHint
                  cliAvailable={notificationsQuery.data?.cliAvailable !== false}
                  onInstall={handleInstallGh}
                  onSignIn={handleSignIn}
                />
                {notificationsQuery.data?.authenticated && notificationsQuery.data.error && (
                  <p className="mt-3 text-center text-xs text-destructive">
                    {notificationsQuery.data.error}
                  </p>
                )}
              </div>
            ) : notifications.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                You&apos;re all caught up. No unread GitHub notifications.
              </p>
            ) : (
              <div className="divide-y divide-border/60 py-1">
                {notifications.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    marking={
                      markAll.isPending || (markOne.isPending && markOne.variables === item.id)
                    }
                    onMarkRead={() => markOne.mutate(item.id)}
                  />
                ))}
              </div>
            )}
          </OverflowScroll>
          <DialogFooter
            className={cn(
              'border-t border-border px-6 py-3',
              unreadCount > 0 ? 'sm:justify-between' : 'sm:justify-end',
            )}
          >
            {unreadCount > 0 && (
              <Button
                variant="soft"
                size="sm"
                disabled={markAll.isPending}
                onClick={() => markAll.mutate()}
              >
                {markAll.isPending ? (
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CircleCheck className="h-3.5 w-3.5" />
                )}
                Mark all as read
              </Button>
            )}
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                void window.runova.shell.openExternal(GH_NOTIFICATIONS_URL);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open on GitHub
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
