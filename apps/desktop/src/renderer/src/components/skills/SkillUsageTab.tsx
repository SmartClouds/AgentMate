import type { SkillUsageReport, SkillUsageStat } from '@shared/apiTypes';
import { useMemo, useState } from 'react';
import {
  ChartSimple,
  Clock,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Search,
  Sparkles,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  GLASS_CARD,
  PillTabs,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { AddUsedSkillDialog } from '@/components/skills/AddUsedSkillDialog';
import { SkillFavoriteButton } from '@/components/skills/SkillFavoriteButton';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatTile } from '@/components/ui/stat-tile';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { type SkillFavorites, usageFavoriteInput } from '@/hooks/useSkillFavorites';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

type UsageSort = 'most-used' | 'recent' | 'name';
type UsageView = 'skill' | 'project';

const SORT_OPTIONS: { value: UsageSort; label: string }[] = [
  { value: 'most-used', label: 'Most used' },
  { value: 'recent', label: 'Recently used' },
  { value: 'name', label: 'Name' },
];

/** How many rows to show before the "Show more" button. */
const PAGE_SIZE = 25;

/**
 * Tints for the top three, so the busiest skills read at a glance. They come from the theme, so
 * they follow every theme the app has rather than one fixed medal palette.
 */
const RANK_STYLES = [
  'bg-warning/15 text-warning ring-1 ring-inset ring-warning/30',
  'bg-primary/12 text-primary ring-1 ring-inset ring-primary/25',
  'bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15',
];

function sortStats(stats: SkillUsageStat[], sort: UsageSort): SkillUsageStat[] {
  const sorted = [...stats];
  if (sort === 'name') {
    sorted.sort((a, b) => a.skill.localeCompare(b.skill));
  } else if (sort === 'recent') {
    sorted.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  } else {
    sorted.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
  }
  return sorted;
}

/** `2026-09-07` as the short date the chart's tooltips and axis show. */
function formatDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? day
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The 30-day activity chart. Days with nothing keep a hairline, so the axis stays readable. */
function ActivityChart({ days, counts }: { days: string[]; counts: number[] }): React.JSX.Element {
  const max = Math.max(1, ...counts);
  return (
    <div className="space-y-1.5">
      <div className="flex h-24 items-end gap-[3px]">
        {days.map((day, index) => {
          const count = counts[index] ?? 0;
          return (
            <SimpleTooltip
              key={day}
              label={`${formatDay(day)}: ${count} invocation${count === 1 ? '' : 's'}`}
            >
              <div className="flex h-full flex-1 cursor-default items-end">
                <div
                  className={cn(
                    'w-full rounded-sm transition-colors',
                    count > 0
                      ? 'bg-primary/70 hover:bg-primary'
                      : 'bg-foreground/[0.08] hover:bg-foreground/20',
                  )}
                  style={{ height: count > 0 ? `${Math.max((count / max) * 100, 8)}%` : '2px' }}
                />
              </div>
            </SimpleTooltip>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{days.length > 0 ? formatDay(days[0]) : ''}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** One skill's own 30 days, small enough to sit inside a row. */
function MiniTrend({ daily }: { daily: number[] }): React.JSX.Element {
  const max = Math.max(1, ...daily);
  return (
    <div className="hidden h-7 items-end gap-px sm:flex" aria-hidden="true">
      {daily.map((count, index) => (
        <div
          // Fixed-length window: the index is the day, and days never reorder.
          key={index}
          className={cn('w-[3px] rounded-sm', count > 0 ? 'bg-primary/60' : 'bg-foreground/[0.08]')}
          style={{ height: count > 0 ? `${Math.max((count / max) * 100, 20)}%` : '2px' }}
        />
      ))}
    </div>
  );
}

/** The icon button that opens the "add to another project" picker for one used skill. */
function AddToProjectButton({
  skill,
  onClick,
  className,
}: {
  skill: string;
  onClick: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <SimpleTooltip label="Add to another project">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn('text-muted-foreground/60', className)}
        aria-label={`Add ${skill} to another project`}
        onClick={onClick}
      >
        <FolderPlus className="h-3.5 w-3.5" />
      </Button>
    </SimpleTooltip>
  );
}

/** Totals per project folder, derived from the per-skill breakdowns. */
interface ProjectRollup {
  path: string;
  label: string;
  total: number;
  skills: { skill: string; count: number }[];
}

function rollupByProject(stats: SkillUsageStat[]): ProjectRollup[] {
  const byPath = new Map<string, ProjectRollup>();
  for (const stat of stats) {
    for (const project of stat.projects) {
      const rollup = byPath.get(project.path) ?? {
        path: project.path,
        label: project.label,
        total: 0,
        skills: [],
      };
      rollup.total += project.count;
      rollup.skills.push({ skill: stat.skill, count: project.count });
      byPath.set(project.path, rollup);
    }
  }
  return [...byPath.values()]
    .map((rollup) => ({
      ...rollup,
      skills: rollup.skills.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)),
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/**
 * The Usage tab: which skills the agents on this machine actually invoke, and how often. The
 * counts come from the local session transcripts, so they cover every run of the CLI, not only
 * the ones started from Runova.
 */
export function SkillUsageTab({
  report,
  isPending,
  isRescanning,
  onRescan,
  favorites,
}: {
  report: SkillUsageReport | undefined;
  isPending: boolean;
  isRescanning: boolean;
  onRescan: () => void;
  favorites: SkillFavorites;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<UsageSort>('most-used');
  const [view, setView] = useState<UsageView>('skill');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [addTarget, setAddTarget] = useState<SkillUsageStat | null>(null);

  const stats = useMemo(() => report?.stats ?? [], [report]);
  const statBySkill = useMemo(() => new Map(stats.map((stat) => [stat.skill, stat])), [stats]);
  const query = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const matching = query
      ? stats.filter(
          (stat) =>
            stat.skill.toLowerCase().includes(query) ||
            stat.projects.some((project) => project.label.toLowerCase().includes(query)),
        )
      : stats;
    return sortStats(matching, sort);
  }, [stats, query, sort]);

  const projects = useMemo(() => {
    const rollups = rollupByProject(stats);
    if (!query) return rollups;
    return rollups
      .map((rollup) => ({
        ...rollup,
        skills: rollup.skills.filter((entry) => entry.skill.toLowerCase().includes(query)),
      }))
      .filter((rollup) => rollup.label.toLowerCase().includes(query) || rollup.skills.length > 0);
  }, [stats, query]);

  const visible = filtered.slice(0, visibleCount);
  // Bar lengths are relative to the busiest skill, so the top row always fills its track.
  const maxCount = stats.reduce((max, stat) => Math.max(max, stat.count), 0);
  const weekTotal = stats.reduce((sum, stat) => sum + stat.count7d, 0);
  const lastUsed = stats.reduce<string | null>(
    (latest, stat) => (!latest || stat.lastUsedAt > latest ? stat.lastUsedAt : latest),
    null,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3')}>
        <p className="min-w-64 max-w-2xl flex-1 text-sm text-muted-foreground">
          Counted from the Claude Code session transcripts on this machine, so every skill an agent
          invoked is here, whether the session was started from Runova or a terminal. Nothing leaves
          your computer.
        </p>
        <div className="flex items-center gap-2">
          {report && (
            <span className="text-xs text-muted-foreground">
              {report.filesScanned} session{report.filesScanned === 1 ? '' : 's'} read ·{' '}
              {timeAgo(report.scannedAt)}
            </span>
          )}
          <Button variant="soft" disabled={isRescanning} onClick={onRescan}>
            <RefreshCw className={cn('h-3.5 w-3.5', isRescanning && 'animate-spin')} />
            Rescan
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="Skills used"
          value={isPending ? <Skeleton className="h-7 w-16" /> : stats.length}
        />
        <StatTile
          icon={<ChartSimple className="h-3.5 w-3.5" />}
          label="Total invocations"
          value={isPending ? <Skeleton className="h-7 w-16" /> : (report?.totalInvocations ?? 0)}
        />
        <StatTile
          icon={<ChartSimple className="h-3.5 w-3.5" />}
          label="Last 7 days"
          value={isPending ? <Skeleton className="h-7 w-16" /> : weekTotal}
        />
        <StatTile
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Last used"
          value={
            isPending ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <span className="text-lg">{lastUsed ? timeAgo(lastUsed) : 'Never'}</span>
            )
          }
        />
      </div>

      {isPending && (
        <div className="flex flex-col gap-2" role="status" aria-label="Reading sessions">
          <Skeleton className="h-36 w-full rounded-[calc(var(--radius)+2px)]" />
          <div className={cn(GLASS_CARD, 'settings-rows')}>
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-3.5 py-3">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-1.5 w-full rounded-full" />
                </div>
                <Skeleton className="h-6 w-10" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!isPending && stats.length === 0 && (
        <div className={GLASS_CARD}>
          <EmptyState
            size="lg"
            icon={ChartSimple}
            title="No skill invocations found."
            description={
              (report?.sourceRoots.length ?? 0) === 0
                ? 'No Claude Code session transcripts on this machine yet.'
                : 'The sessions read so far never invoked a skill. Counts appear here as soon as one does.'
            }
          />
        </div>
      )}

      {!isPending && stats.length > 0 && (
        <>
          <section aria-label="Last 30 days" className={cn(GLASS_CARD, 'space-y-3 p-4')}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={SECTION_HEADING}>Last 30 days</h2>
              <span className="text-xs text-muted-foreground">
                {(report?.dailyTotals ?? []).reduce((sum, count) => sum + count, 0)} invocations
              </span>
            </div>
            <ActivityChart days={report?.days ?? []} counts={report?.dailyTotals ?? []} />
          </section>

          <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-3 py-2')}>
            <PillTabs
              id="skill-usage-view"
              kind="toggle"
              label="Group usage"
              items={[
                { value: 'skill' as const, label: 'By skill', icon: <Sparkles /> },
                { value: 'project' as const, label: 'By project', icon: <FolderOpen /> },
              ]}
              value={view}
              onChange={setView}
            />
            <SearchPill
              label="Search used skills"
              placeholder="Search used skills or projects…"
              value={search}
              onValueChange={(value) => {
                setSearch(value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="min-w-56 flex-1"
            />
            {view === 'skill' && (
              <PillTabs
                id="skill-usage-sort"
                kind="toggle"
                label="Sort"
                items={SORT_OPTIONS}
                value={sort}
                onChange={setSort}
              />
            )}
          </div>

          {view === 'skill' && (
            <>
              {visible.length > 0 && (
                <div className={cn(GLASS_CARD, 'settings-rows overflow-hidden')}>
                  {visible.map((stat, index) => {
                    const share = maxCount > 0 ? Math.round((stat.count / maxCount) * 100) : 0;
                    const ranked = sort === 'most-used' && !query;
                    return (
                      <div
                        key={stat.skill}
                        className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-foreground/[0.03]"
                      >
                        <span
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                            ranked && index < 3
                              ? RANK_STYLES[index]
                              : 'bg-foreground/[0.06] text-muted-foreground',
                          )}
                        >
                          {ranked ? index + 1 : '·'}
                        </span>

                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="mr-0.5 truncate text-sm font-medium text-foreground">
                              {stat.skill}
                            </span>
                            {stat.count7d > 0 && (
                              <Chip tone="primary">{stat.count7d} this week</Chip>
                            )}
                            {stat.projects.slice(0, 2).map((project) => (
                              <SimpleTooltip key={project.path} label={project.path}>
                                <Chip>
                                  {project.label} · {project.count}
                                </Chip>
                              </SimpleTooltip>
                            ))}
                            {stat.projects.length > 2 && (
                              <Chip>+{stat.projects.length - 2} more</Chip>
                            )}
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
                            <div
                              className="h-full rounded-full bg-primary/70 transition-all group-hover:bg-primary"
                              style={{ width: `${Math.max(share, 2)}%` }}
                            />
                          </div>
                        </div>

                        <MiniTrend daily={stat.daily} />

                        <div className="w-16 shrink-0 text-right">
                          <div className="text-base font-semibold tabular-nums text-foreground">
                            {stat.count}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {timeAgo(stat.lastUsedAt)}
                          </div>
                        </div>

                        <AddToProjectButton
                          skill={stat.skill}
                          onClick={() => setAddTarget(stat)}
                          className="shrink-0"
                        />

                        <SkillFavoriteButton
                          starred={favorites.isFavorite(stat.skill)}
                          onToggle={() => favorites.toggleFavorite(usageFavoriteInput(stat.skill))}
                          className="shrink-0"
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {filtered.length > visible.length && (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="soft"
                    onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  >
                    Show more ({filtered.length - visible.length} remaining)
                  </Button>
                </div>
              )}

              {filtered.length === 0 && (
                <div className={GLASS_CARD}>
                  <EmptyState
                    size="sm"
                    icon={Search}
                    title="Nothing found"
                    description="No used skills match your search."
                  />
                </div>
              )}
            </>
          )}

          {view === 'project' && (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {projects.map((project) => {
                const topCount = project.skills[0]?.count ?? 1;
                return (
                  <section
                    key={project.path}
                    aria-label={project.label}
                    className={cn(GLASS_CARD, 'space-y-3 p-4')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                          <FolderOpen className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {project.label}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{project.path}</p>
                        </div>
                      </div>
                      <Chip tone="primary">
                        {project.total} use{project.total === 1 ? '' : 's'}
                      </Chip>
                    </div>
                    <div className="space-y-1.5">
                      {project.skills.map((entry) => (
                        <div key={entry.skill} className="group/skill flex items-center gap-2">
                          <span className="w-40 shrink-0 truncate text-xs text-foreground">
                            {entry.skill}
                          </span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                            <div
                              className="h-full rounded-full bg-primary/70"
                              style={{
                                width: `${Math.max((entry.count / topCount) * 100, 4)}%`,
                              }}
                            />
                          </div>
                          <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {entry.count}
                          </span>
                          <AddToProjectButton
                            skill={entry.skill}
                            onClick={() => {
                              const stat = statBySkill.get(entry.skill);
                              if (stat) setAddTarget(stat);
                            }}
                            className="h-6 w-6 shrink-0 opacity-0 focus-visible:opacity-100 group-hover/skill:opacity-100"
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}

              {projects.length === 0 && (
                <div className={cn(GLASS_CARD, 'lg:col-span-2')}>
                  <EmptyState
                    size="sm"
                    icon={FolderOpen}
                    title="Nothing to group"
                    description={
                      query
                        ? 'No projects match your search.'
                        : 'The sessions read carry no project folder, so there is nothing to group.'
                    }
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      <AddUsedSkillDialog stat={addTarget} onClose={() => setAddTarget(null)} />
    </div>
  );
}
