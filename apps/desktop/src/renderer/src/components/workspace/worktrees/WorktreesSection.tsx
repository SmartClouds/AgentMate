import { type Project, parseScopeId, type WorktreeInfo } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { EllipsisVertical, FolderTree, GitBranch, Plus } from '@/components/icons';
import { Chip, type ChipTone, EmptyState, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useWorktrees } from '@/hooks/useWorktrees';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { worktreeLabel } from '@/lib/workspace/scope';
import { statusSummary } from '@/lib/workspace/worktreeText';
import { useWorktreeCommands, type WorktreeCommands } from './useWorktreeCommands';
import { WorktreeMenuItems } from './WorktreeMenuItems';

const BADGE_TONE = {
  changes: 'warning',
  ahead: 'primary',
  behind: 'neutral',
} as const satisfies Record<string, ChipTone>;

/** A chip sized for the two-line worktree row. */
const ROW_CHIP = 'h-4 px-1.5 text-[10px]';

function PathText({ path }: { path: string }): React.JSX.Element {
  // rtl keeps the end of a long path, the part that tells worktrees apart, in view.
  return (
    <span className="block truncate font-mono text-[10px] text-muted-foreground" dir="rtl">
      <bdi>{path}</bdi>
    </span>
  );
}

function WorktreeRow({
  project,
  worktree,
  current,
  commands,
}: {
  project: Project;
  worktree: WorktreeInfo;
  current: boolean;
  commands: WorktreeCommands;
}): React.JSX.Element {
  const label = worktreeLabel(worktree);
  const badges = worktree.status ? statusSummary(worktree.status) : [];
  return (
    <li
      className={cn(
        'group relative flex items-center gap-1 rounded-lg pr-1 transition-colors',
        current ? 'bg-primary/12' : 'hover:bg-foreground/[0.06]',
      )}
    >
      {current ? (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
        />
      ) : null}
      <button
        type="button"
        aria-label={`Open ${label}`}
        disabled={current || worktree.missing}
        onClick={() => commands.open(project, worktree)}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default"
      >
        <GitBranch
          className={cn(
            'mt-0.5 h-3 w-3 shrink-0',
            current ? 'text-primary' : 'text-muted-foreground',
            worktree.missing && 'text-warning',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'truncate text-xs',
                current ? 'font-medium text-primary' : 'text-foreground/85',
                worktree.missing && 'text-muted-foreground line-through',
              )}
            >
              {label}
            </span>
            {current ? (
              <Chip tone="primary" className={ROW_CHIP}>
                This workspace
              </Chip>
            ) : null}
            {worktree.missing ? (
              <Chip tone="warning" className={ROW_CHIP}>
                Folder missing
              </Chip>
            ) : null}
            {worktree.locked ? (
              <SimpleTooltip label={worktree.lockReason ?? 'Locked with git worktree lock'}>
                <Chip className={ROW_CHIP}>Locked</Chip>
              </SimpleTooltip>
            ) : null}
          </span>
          {/* Badges share the second line with the path, so the branch name keeps its room. */}
          <span className="mt-0.5 flex min-w-0 items-center gap-1">
            {badges.map((badge) => (
              <Chip
                key={badge.kind}
                tone={BADGE_TONE[badge.kind]}
                className={cn(ROW_CHIP, 'tabular-nums')}
              >
                {badge.text}
              </Chip>
            ))}
            <span className="min-w-0 flex-1">
              <PathText path={worktree.path} />
            </span>
          </span>
          {!worktree.createdByApp ? (
            <span className="block text-[10px] text-muted-foreground/80">Added outside Runova</span>
          ) : null}
        </span>
      </button>
      <DropdownMenu modal={false}>
        <SimpleTooltip label="More actions">
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`More actions for ${label}`}
              className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          <WorktreeMenuItems
            project={project}
            worktree={worktree}
            commands={commands}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            showOpen={!current}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * The Worktrees section of Source control: every worktree of the project with where it stands,
 * one click to open its workspace, and the rest behind each row's menu.
 */
export function WorktreesSection({ project }: { project: Project }): React.JSX.Element {
  const { projectId, worktreeId } = parseScopeId(project.id);
  const commands = useWorktreeCommands();
  const query = useWorktrees(projectId);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  // Commands need the project itself; inside a worktree `project` is the worktree's view of it.
  const parent =
    projectsQuery.data?.find((p) => p.id === projectId) ?? (worktreeId ? null : project);

  if (query.isPending || !parent) {
    return (
      <div className="space-y-1 px-1.5 py-1.5" aria-label="Loading worktrees">
        <Skeleton className="h-10 rounded-lg" />
        <Skeleton className="h-10 w-4/5 rounded-lg" />
      </div>
    );
  }

  const worktrees = query.data ?? [];
  const missing = worktrees.filter((w) => w.missing).length;

  return (
    <div className="px-1.5 pb-2">
      {worktreeId ? (
        <button
          type="button"
          aria-label="Open the main checkout"
          onClick={() => commands.openMain(projectId)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <FolderTree className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block">Main checkout</span>
            <PathText path={parent.folderPath} />
          </span>
        </button>
      ) : null}
      {worktrees.length === 0 ? (
        <EmptyState
          size="sm"
          icon={FolderTree}
          title="No worktrees yet"
          description={
            <span className="block text-xs">
              Work on several branches at once. Each worktree gets its own folder, terminals and
              agents, so parallel tasks never touch each other's files.
            </span>
          }
          action={
            <Button size="xs" variant="soft" onClick={() => commands.create({ projectId })}>
              <Plus />
              New worktree
            </Button>
          }
          className="gap-2.5 px-3 py-4"
        />
      ) : (
        <ul className="space-y-px">
          {worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.id}
              project={parent}
              worktree={worktree}
              current={worktree.id === worktreeId}
              commands={commands}
            />
          ))}
        </ul>
      )}
      {missing > 0 ? (
        <Notice
          tone="warning"
          size="sm"
          className="mx-1 mt-2 items-center text-[11px]"
          action={
            <Button
              type="button"
              variant="soft"
              size="xs"
              onClick={() => commands.prune(projectId)}
            >
              Clean up
            </Button>
          }
        >
          {missing === 1
            ? 'One worktree’s folder is gone.'
            : `${missing} worktree folders are gone.`}
        </Notice>
      ) : null}
    </div>
  );
}
