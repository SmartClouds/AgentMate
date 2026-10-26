import type { GitChangeEntry } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { ChevronRight } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { type DiffStat, diffBarBlocks, diffStat, formatLineCount, sumDiffStats } from '@/lib/git';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/** The five-block bar GitHub puts next to a diffstat: green for added, red for removed. */
function DiffBar({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-center gap-px', className)} aria-hidden>
      {diffBarBlocks(additions, deletions).map((block, index) => (
        <span
          key={index}
          className={cn(
            'h-2 w-2 rounded-[1px]',
            block === 'add' && 'bg-success',
            block === 'del' && 'bg-destructive',
            block === 'none' && 'bg-foreground/15',
          )}
        />
      ))}
    </span>
  );
}

function Counts({ stat, className }: { stat: DiffStat; className?: string }): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums', className)}>
      <span className={stat.additions > 0 ? 'text-success' : 'text-muted-foreground/50'}>
        +{formatLineCount(stat.additions)}
      </span>
      <span className={stat.deletions > 0 ? 'text-destructive' : 'text-muted-foreground/50'}>
        &minus;{formatLineCount(stat.deletions)}
      </span>
    </span>
  );
}

function BreakdownRow({ title, stat }: { title: string; stat: DiffStat }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-[3px] pl-1 pr-0.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        {stat.files.toLocaleString()}
      </span>
      <Counts stat={stat} className="w-[5.5rem] justify-end text-[10px]" />
    </div>
  );
}

/**
 * The totals across everything the Changes tab is showing, the way a pull request sums up its
 * files: how many changed, how many lines came and went, and the split between them. Clicking
 * it opens the same numbers per group.
 */
export function ChangesSummary({ state }: { state: WorkspaceGitState }): React.JSX.Element | null {
  const expanded = useWorkspaceStore((s) => s.gitPanel.lineStatsExpanded);
  const setGitPanel = useWorkspaceStore((s) => s.setGitPanel);

  const groups: { id: string; title: string; entries: GitChangeEntry[] }[] = [
    { id: 'conflicts', title: 'Conflicts', entries: state.conflicts },
    { id: 'staged', title: 'Staged changes', entries: state.staged },
    { id: 'unstaged', title: 'Changes', entries: state.unstaged },
    { id: 'untracked', title: 'Untracked', entries: state.untracked },
  ].filter((group) => group.entries.length > 0);

  if (groups.length === 0) return null;

  const stats = groups.map((group) => ({ ...group, stat: diffStat(group.entries) }));
  const total = sumDiffStats(stats.map((group) => group.stat));
  const files = `${total.files.toLocaleString()} file${total.files === 1 ? '' : 's'}`;

  return (
    <div className="@container/summary border-b border-border/60 px-2 py-1.5">
      <SimpleTooltip
        side="bottom"
        label={
          <span className="tabular-nums">
            {total.additions.toLocaleString()} lines added, {total.deletions.toLocaleString()}{' '}
            removed, across {files}.
          </span>
        }
      >
        <button
          type="button"
          onClick={() => setGitPanel({ lineStatsExpanded: !expanded })}
          aria-expanded={expanded}
          aria-label={`${files} changed, ${total.additions.toLocaleString()} lines added, ${total.deletions.toLocaleString()} lines removed`}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">
              {total.files.toLocaleString()}
            </span>{' '}
            file{total.files === 1 ? '' : 's'}
            {/* The panel goes down to 240px, where the word does not fit beside the numbers. */}
            <span className="hidden @[15rem]/summary:inline"> changed</span>
          </span>
          <DiffBar
            additions={total.additions}
            deletions={total.deletions}
            className="hidden @[12rem]/summary:flex"
          />
          <Counts stat={total} className="text-[11px] font-medium" />
        </button>
      </SimpleTooltip>

      {expanded ? (
        <div className="mt-1 border-t border-border/50 pt-1">
          {stats.map((group) => (
            <BreakdownRow key={group.id} title={group.title} stat={group.stat} />
          ))}
          {total.uncounted > 0 ? (
            <SimpleTooltip
              label="Binary files, conflicted files and anything too large to read have no line counts, so they are left out of the totals."
              className="max-w-[16rem]"
              side="bottom"
            >
              <p className="cursor-default pl-1 pt-1 text-[10px] leading-snug text-muted-foreground/70">
                {total.uncounted.toLocaleString()} file{total.uncounted === 1 ? '' : 's'} without
                line counts
              </p>
            </SimpleTooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
