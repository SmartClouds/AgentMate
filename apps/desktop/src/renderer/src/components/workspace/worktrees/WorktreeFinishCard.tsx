import { type Project, parseScopeId, type WorktreeInfo } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, GitBranch, GitMerge, GitPullRequest, Trash2 } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { useWorktrees } from '@/hooks/useWorktrees';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { worktreeLabel } from '@/lib/workspace/scope';
import { useWorktreeCommands } from './useWorktreeCommands';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Where a worktree's branch stands against its base, in one line. */
function standing(worktree: WorktreeInfo, base: string): { text: string; done: boolean } {
  const status = worktree.status;
  if (!status) return { text: 'Status unknown', done: false };
  const done = status.merged && status.ahead === 0 && status.changes === 0;
  if (done) return { text: `Everything here is in ${base}`, done };
  const commits =
    status.ahead > 0 && status.behind > 0
      ? `${plural(status.ahead, 'commit')} ahead, ${status.behind} behind ${base}`
      : status.ahead > 0
        ? `${plural(status.ahead, 'commit')} ahead of ${base}`
        : status.behind > 0
          ? `${status.behind} behind ${base}`
          : `Nothing new since ${base}`;
  const text =
    status.changes > 0 ? `${plural(status.changes, 'uncommitted change')} · ${commits}` : commits;
  return { text, done };
}

/**
 * The top of a worktree's Source control tab: where its branch stands and the ways to finish it.
 * Once everything is merged, removing the worktree becomes the suggested next step.
 */
export function WorktreeFinishCard({
  project,
  worktree,
}: {
  /** The project itself (its main checkout), not the worktree's workspace. */
  project: Project;
  worktree: WorktreeInfo;
}): React.JSX.Element {
  const commands = useWorktreeCommands();
  const base = worktree.baseBranch ?? 'its base';
  const { text, done } = standing(worktree, base);
  const canMerge =
    Boolean(worktree.branch) && !worktree.missing && (worktree.status?.ahead ?? 0) > 0;

  return (
    // A glass card with a tinted ring: rings render on .glass, and the global border colour
    // would repaint a tinted border.
    <div
      className={cn(
        GLASS_CARD,
        'mx-2 mt-2 px-3 py-2.5 ring-1 ring-inset',
        done ? 'ring-success/30' : 'ring-primary/25',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
            done ? 'bg-success/12 text-success' : 'bg-primary/12 text-primary',
          )}
        >
          <GitBranch className="h-3 w-3" />
        </span>
        <span className="truncate font-mono font-semibold">{worktreeLabel(worktree)}</span>
        <span className="shrink-0 text-muted-foreground">→ {base}</span>
      </div>
      <p
        className={cn(
          'mt-1 flex items-center gap-1.5 text-[11px]',
          done ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {done ? <CircleCheck className="h-3 w-3" /> : null}
        {text}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="xs"
          variant={done ? 'soft' : 'default'}
          disabled={!canMerge}
          onClick={() => commands.merge(project, worktree)}
        >
          <GitMerge />
          Merge into {base}
        </Button>
        <Button
          size="xs"
          variant="soft"
          disabled={!worktree.branch}
          onClick={() => commands.pullRequest(project, worktree)}
        >
          <GitPullRequest />
          Create pull request
        </Button>
        <Button
          size="xs"
          variant={done ? 'default' : 'ghost'}
          onClick={() => commands.remove(project, worktree)}
        >
          <Trash2 />
          Remove worktree
        </Button>
      </div>
    </div>
  );
}

/** The finish card when the panel belongs to a worktree's workspace, and nothing otherwise. */
export function WorktreeFinishSlot({ project }: { project: Project }): React.JSX.Element | null {
  const { projectId, worktreeId } = parseScopeId(project.id);
  const worktrees = useWorktrees(worktreeId ? projectId : null).data;
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  }).data;
  const parent = projects?.find((p) => p.id === projectId);
  const worktree = worktrees?.find((w) => w.id === worktreeId);
  if (!worktreeId || !parent || !worktree) return null;
  return <WorktreeFinishCard project={parent} worktree={worktree} />;
}
