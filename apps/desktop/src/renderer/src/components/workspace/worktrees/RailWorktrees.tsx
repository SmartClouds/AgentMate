import type { Project, WorktreeInfo } from '@runova/core';
import { motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { Plus, TriangleAlert } from '@/components/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { asWorkspaceProject, worktreeInitials, worktreeLabel } from '@/lib/workspace/scope';
import { statusSummary } from '@/lib/workspace/worktreeText';
import { attentionStatus, useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { AgentStatusDot } from '../AgentStatusDot';
import { worktreeTileStyle } from '../railStyle';
import { useWorktreeCommands } from './useWorktreeCommands';
import { WorktreeMenuItems } from './WorktreeMenuItems';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function TileTooltip({
  worktree,
  terminals,
  working,
}: {
  worktree: WorktreeInfo;
  terminals: number;
  working: number;
}): React.JSX.Element {
  const badges = worktree.status ? statusSummary(worktree.status) : [];
  return (
    <span className="flex max-w-[22rem] flex-col gap-0.5">
      <span className="font-semibold">{worktreeLabel(worktree)}</span>
      <span className="text-[10px] text-muted-foreground">
        {worktree.baseBranch ? `from ${worktree.baseBranch}` : 'git worktree'}
        {worktree.createdByApp ? '' : ' · added outside Runova'}
      </span>
      <span className="break-all font-mono text-[10px] text-muted-foreground">{worktree.path}</span>
      <span className="mt-0.5 text-[10px]">
        {worktree.missing
          ? 'The folder is missing. Right-click to remove it.'
          : badges.length > 0
            ? badges.map((badge) => badge.text).join(' · ')
            : worktree.status?.merged
              ? 'Clean, nothing to merge'
              : 'Clean'}
      </span>
      {terminals > 0 ? (
        <span className="text-[10px] text-muted-foreground">
          {plural(terminals, 'terminal')} open{working > 0 ? `, ${working} working` : ''}
        </span>
      ) : null}
    </span>
  );
}

function RailWorktreeTile({
  project,
  worktree,
  active,
}: {
  project: Project;
  worktree: WorktreeInfo;
  active: boolean;
}): React.JSX.Element {
  const navigate = useNavigate();
  const commands = useWorktreeCommands();
  const reduceMotion = useReducedMotion();
  const scopeId = asWorkspaceProject(project, worktree).id;
  const label = worktreeLabel(worktree);
  const tabIds = useWorkspaceStore(
    useShallow((s) =>
      Object.values(s.workspaces[scopeId]?.tabs ?? {})
        .filter((t) => t.kind === 'terminal')
        .map((t) => t.id),
    ),
  );
  const attention = useAgentStatusStore((s) =>
    attentionStatus(tabIds.map((id) => s.statuses[id] ?? 'idle')),
  );
  const working = useAgentStatusStore(
    (s) => tabIds.filter((id) => s.statuses[id] === 'working').length,
  );

  return (
    <div className="relative flex w-full justify-center">
      {active ? (
        <motion.span
          layoutId="workspace-rail-active"
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
          transition={
            reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 34 }
          }
        />
      ) : null}
      {/* The branch off the project's connector line. */}
      <span className="pointer-events-none absolute left-[14px] top-1/2 h-px w-[9px] bg-border" />
      <ContextMenu modal={false}>
        <SimpleTooltip
          side="right"
          label={<TileTooltip worktree={worktree} terminals={tabIds.length} working={working} />}
        >
          <ContextMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Open worktree ${label}${worktree.missing ? ' (folder missing)' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(`/workspace/${scopeId}`)}
              style={worktreeTileStyle(project)}
              className={cn(
                'relative ml-3 flex h-7 w-7 items-center justify-center rounded-lg text-[10px] font-semibold tracking-tight transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'ring-2 ring-primary/55 ring-offset-1 ring-offset-background'
                  : 'opacity-75 hover:opacity-100',
                worktree.missing && 'opacity-45 grayscale',
              )}
            >
              {worktreeInitials(label)}
              {worktree.missing ? (
                <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
                  <TriangleAlert className="h-2.5 w-2.5 text-warning" />
                </span>
              ) : attention ? (
                <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
                  <AgentStatusDot status={attention} />
                </span>
              ) : (worktree.status?.changes ?? 0) > 0 ? (
                // A quiet dot for uncommitted work, so unfinished worktrees stand out.
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-background" />
              ) : null}
            </button>
          </ContextMenuTrigger>
        </SimpleTooltip>
        <ContextMenuContent className="min-w-[13rem]">
          <WorktreeMenuItems
            project={project}
            worktree={worktree}
            commands={commands}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
          />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/**
 * A project's worktrees under its tile in the rail, joined by a thin line so they read as its
 * branches. A folded project still shows the worktree that is on screen, so the active marker
 * never points at nothing.
 */
export function RailWorktreeGroup({
  project,
  worktrees,
  expanded,
  activeProjectId,
}: {
  project: Project;
  worktrees: WorktreeInfo[];
  expanded: boolean;
  activeProjectId: string | null;
}): React.JSX.Element | null {
  const commands = useWorktreeCommands();
  const visible = expanded
    ? worktrees
    : worktrees.filter((w) => asWorkspaceProject(project, w).id === activeProjectId);
  if (visible.length === 0 && !expanded) return null;
  if (worktrees.length === 0) return null;

  return (
    <div className="relative flex w-full flex-col items-center gap-1.5">
      <span className="pointer-events-none absolute bottom-3.5 left-[14px] top-[-6px] w-px bg-border" />
      {visible.map((worktree) => (
        <RailWorktreeTile
          key={worktree.id}
          project={project}
          worktree={worktree}
          active={asWorkspaceProject(project, worktree).id === activeProjectId}
        />
      ))}
      {expanded ? (
        <div className="relative flex w-full justify-center">
          <span className="pointer-events-none absolute left-[14px] top-1/2 h-px w-[9px] bg-border" />
          <SimpleTooltip side="right" label={`New worktree of ${project.name}`}>
            <button
              type="button"
              aria-label={`New ${project.name} worktree`}
              onClick={() => commands.create({ projectId: project.id })}
              className="ml-3 flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground opacity-60 transition-all hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
          </SimpleTooltip>
        </div>
      ) : null}
    </div>
  );
}
