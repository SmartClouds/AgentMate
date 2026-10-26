import { parseScopeId } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, FolderTree, GitBranch, Plus, TriangleAlert } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useWorktrees } from '@/hooks/useWorktrees';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { worktreeLabel } from '@/lib/workspace/scope';
import { statusSummary } from '@/lib/workspace/worktreeText';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeCommands } from './useWorktreeCommands';

/**
 * The header's "which checkout am I in" control: the main checkout or the branch of the worktree
 * on screen, with every other one a click away. Makes it hard to lose track of where an agent is
 * about to work, which is the whole risk of having several checkouts open.
 */
export function WorkspaceScopeSwitcher({ scopeId }: { scopeId: string }): React.JSX.Element | null {
  const { projectId, worktreeId } = parseScopeId(scopeId);
  const commands = useWorktreeCommands();
  const revealPanelSection = useWorkspaceStore((s) => s.revealPanelSection);
  const newShortcut = useShortcutLabel('workspace.newWorktree');
  const project = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  }).data?.find((p) => p.id === projectId);
  const worktrees = useWorktrees(projectId).data ?? [];
  const current = worktrees.find((w) => w.id === worktreeId) ?? null;
  if (!project) return null;

  const label = current ? worktreeLabel(current) : 'main checkout';
  return (
    <DropdownMenu modal={false}>
      <SimpleTooltip
        label={
          current
            ? `Worktree of ${project.name}: ${current.path}`
            : `${project.name}: ${project.folderPath}`
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Switch workspace: ${label}`}
            className={cn(
              // A pill like the rest of the header; its edge is a ring so the global border
              // colour can't repaint the primary tint.
              'flex h-8 max-w-[15rem] cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              current
                ? 'bg-primary/12 text-foreground ring-primary/30 hover:bg-primary/20 data-[state=open]:bg-primary/20'
                : 'bg-foreground/[0.05] text-muted-foreground ring-foreground/[0.07] hover:bg-foreground/[0.08] hover:text-foreground data-[state=open]:bg-foreground/[0.08]',
            )}
          >
            {current ? (
              <GitBranch className="h-3 w-3 shrink-0 text-primary" />
            ) : (
              <FolderTree className="h-3 w-3 shrink-0" />
            )}
            <span className={cn('truncate', current && 'font-mono')}>{label}</span>
            {worktrees.length > 0 && !current ? (
              <span className="rounded-full bg-foreground/[0.08] px-1.5 text-[10px] font-semibold tabular-nums">
                {worktrees.length}
              </span>
            ) : null}
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Workspaces of {project.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => commands.openMain(projectId)}>
          <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block">Main checkout</span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {project.folderPath}
            </span>
          </span>
          {!current ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
        </DropdownMenuItem>
        {worktrees.map((worktree) => {
          const badges = worktree.status ? statusSummary(worktree.status) : [];
          return (
            <DropdownMenuItem
              key={worktree.id}
              disabled={worktree.missing}
              onSelect={() => commands.open(project, worktree)}
            >
              {worktree.missing ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
              ) : (
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12px]">
                  {worktreeLabel(worktree)}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {worktree.missing
                    ? 'Folder missing'
                    : badges.length > 0
                      ? badges.map((badge) => badge.text).join(' · ')
                      : 'Clean'}
                </span>
              </span>
              {worktree.id === worktreeId ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => commands.create({ projectId })}>
          <Plus className="h-3.5 w-3.5" />
          <span className="flex-1">New worktree…</span>
          {newShortcut ? <DropdownMenuShortcut>{newShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => revealPanelSection('worktrees')}>
          <GitBranch className="h-3.5 w-3.5" />
          Manage worktrees
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
