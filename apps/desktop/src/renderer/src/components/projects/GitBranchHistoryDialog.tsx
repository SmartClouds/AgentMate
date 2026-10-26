import type { GitCommitInfo, GitDayCount } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { GitCommit, History, Spinner, Tag } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';

const ROW_H = 40;
const LANE_W = 14;
const GRAPH_PAD = 8;

interface GraphRow {
  commit: GitCommitInfo;
  lane: number;
  lines: number[];
  links: { from: number; to: number }[];
}

function laneColor(lane: number): string {
  const hues = [198, 158, 32, 272, 338, 48];
  return `hsl(${hues[lane % hues.length]} 58% 58%)`;
}

function buildCommitGraph(commits: GitCommitInfo[]): GraphRow[] {
  const known = new Set(commits.map((commit) => commit.hash));
  const reserved: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    let lane = reserved.indexOf(commit.hash);
    if (lane === -1) {
      lane = reserved.indexOf(null);
      if (lane === -1) {
        lane = reserved.length;
        reserved.push(commit.hash);
      } else {
        reserved[lane] = commit.hash;
      }
    }

    const lines = reserved.map((hash, index) => (hash ? index : -1)).filter((index) => index >= 0);

    const links: { from: number; to: number }[] = [];
    const parents = commit.parents.filter((parent) => known.has(parent));
    reserved[lane] = parents[0] ?? null;
    if (parents[0]) links.push({ from: lane, to: lane });

    for (const parent of parents.slice(1)) {
      let parentLane = reserved.indexOf(parent);
      if (parentLane === -1) {
        parentLane = reserved.indexOf(null);
        if (parentLane === -1) {
          parentLane = reserved.length;
          reserved.push(parent);
        } else {
          reserved[parentLane] = parent;
        }
      }
      links.push({ from: lane, to: parentLane });
    }

    rows.push({ commit, lane, lines, links });
  }

  return rows;
}

function ActivityChart({ activity }: { activity: GitDayCount[] }): React.JSX.Element {
  const max = Math.max(1, ...activity.map((day) => day.count));
  const total = activity.reduce((sum, day) => sum + day.count, 0);
  const first = activity[0]?.date;
  const last = activity[activity.length - 1]?.date;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Activity</p>
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? 'No commits in the last 12 weeks'
            : `${total} commit${total === 1 ? '' : 's'} in 12 weeks`}
        </p>
      </div>
      <div className="flex h-16 items-end gap-px rounded-lg border border-border/80 bg-foreground/[0.03] px-1.5 py-1.5">
        {activity.map((day) => {
          const height = day.count === 0 ? 2 : Math.max(8, Math.round((day.count / max) * 100));
          return (
            <SimpleTooltip key={day.date} label={`${day.date}: ${day.count}`}>
              <div
                className="min-w-0 flex-1 rounded-t-[2px]"
                style={{
                  height: `${height}%`,
                  background:
                    day.count === 0
                      ? 'hsl(var(--foreground) / 0.08)'
                      : 'hsl(var(--primary) / 0.85)',
                }}
              />
            </SimpleTooltip>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

function CommitGraphCell({
  row,
  laneCount,
}: {
  row: GraphRow;
  laneCount: number;
}): React.JSX.Element {
  const width = GRAPH_PAD * 2 + Math.max(laneCount, 1) * LANE_W;
  const mid = ROW_H / 2;
  const xFor = (lane: number): number => GRAPH_PAD + lane * LANE_W + LANE_W / 2;
  const color = laneColor(row.lane);

  return (
    <svg
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      className="shrink-0"
      aria-hidden="true"
    >
      {row.lines.map((lane) => (
        <line
          key={`line-${lane}`}
          x1={xFor(lane)}
          y1={0}
          x2={xFor(lane)}
          y2={ROW_H}
          stroke={laneColor(lane)}
          strokeWidth="1.5"
          opacity="0.55"
        />
      ))}
      {row.links.map((link) => {
        const x1 = xFor(link.from);
        const x2 = xFor(link.to);
        if (x1 === x2) return null;
        const c = laneColor(link.to);
        return (
          <path
            key={`link-${link.from}-${link.to}`}
            d={`M ${x1} ${mid} C ${x1} ${ROW_H - 4}, ${x2} ${4}, ${x2} ${ROW_H}`}
            fill="none"
            stroke={c}
            strokeWidth="1.5"
            opacity="0.7"
          />
        );
      })}
      <circle cx={xFor(row.lane)} cy={mid} r="4.25" fill={color} />
      <circle
        cx={xFor(row.lane)}
        cy={mid}
        r="4.25"
        fill="none"
        stroke={color}
        strokeWidth="2"
        opacity="0.35"
      />
    </svg>
  );
}

export function GitBranchHistoryDialog({
  projectId,
  branch,
  open,
  onOpenChange,
}: {
  projectId: string;
  branch: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const historyQuery = useQuery({
    queryKey: queryKeys.gitBranchHistory(projectId, branch ?? ''),
    queryFn: () => window.runova.git.branchHistory(projectId, branch ?? ''),
    enabled: open && Boolean(branch),
  });

  const rows = useMemo(
    () => buildCommitGraph(historyQuery.data?.commits ?? []),
    [historyQuery.data?.commits],
  );
  const laneCount = Math.max(1, ...rows.map((row) => row.lane + 1), 1);

  async function copyHash(hash: string): Promise<void> {
    await navigator.clipboard.writeText(hash);
    toast.success('Copied commit hash.');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Branch history
          </DialogTitle>
          <DialogDescription>
            Chart and commits for{' '}
            <span className="font-mono text-foreground">{branch ?? 'this branch'}</span>
            {historyQuery.data ? ` · ${historyQuery.data.commits.length} shown` : null}.
          </DialogDescription>
        </DialogHeader>

        {historyQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : historyQuery.isError ? (
          <p className="text-sm text-destructive">
            {(historyQuery.error as Error).message || 'Could not load this branch.'}
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-4">
            <ActivityChart activity={historyQuery.data?.activity ?? []} />

            <div className="min-h-0 space-y-1.5">
              <p className="text-sm font-medium">Commits</p>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No commits on this branch yet.</p>
              ) : (
                <OverflowScroll className="max-h-[min(24rem,46vh)]" surface="popover">
                  {rows.map((row) => (
                    <div
                      key={row.commit.hash}
                      className="flex items-stretch gap-1 border-b border-border/40 last:border-b-0"
                    >
                      <CommitGraphCell row={row} laneCount={laneCount} />
                      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1">
                        <GitCommit className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <p className="min-w-0 truncate text-sm">
                              {row.commit.subject || '(no subject)'}
                            </p>
                            {row.commit.tags.length > 0 ? (
                              <div className="flex max-w-[45%] shrink-0 items-center gap-1 overflow-hidden">
                                {row.commit.tags.map((tag) => (
                                  <Badge
                                    key={tag}
                                    variant="secondary"
                                    className="max-w-full gap-1 truncate px-1.5 py-0 font-mono text-[10px]"
                                    title={tag}
                                  >
                                    <Tag className="h-2.5 w-2.5 shrink-0" />
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {row.commit.author}
                            {row.commit.date ? ` · ${timeAgo(row.commit.date)}` : ''}
                          </p>
                        </div>
                        <SimpleTooltip label="Copy full hash">
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                            onClick={() => void copyHash(row.commit.hash)}
                          >
                            {row.commit.shortHash}
                          </button>
                        </SimpleTooltip>
                      </div>
                    </div>
                  ))}
                </OverflowScroll>
              )}
            </div>
          </div>
        )}

        {historyQuery.isFetching && !historyQuery.isLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3 animate-spin" /> Refreshing…
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
