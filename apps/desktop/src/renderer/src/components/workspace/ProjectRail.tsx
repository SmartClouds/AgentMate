import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { Project } from '@runova/core';
import { Command as CommandPrimitive } from 'cmdk';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, ChevronUp, GitBranch, Plus, Search, X } from '@/components/icons';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { LIST_OPTION, LIST_SEARCH, OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { ReorderableGroup, type ReorderMotion } from '@/components/ui/ReorderableGroup';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useWorktrees } from '@/hooks/useWorktrees';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { attentionStatus, useAgentStatusStore } from '@/stores/agentStatusStore';
import { confirmDialog } from '@/stores/confirmStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { AgentStatusChip, AgentStatusDot } from './AgentStatusDot';
import { monogramStyle } from './railStyle';
import { RailWorktreeGroup } from './worktrees/RailWorktrees';
import { useWorktreeCommands } from './worktrees/useWorktreeCommands';

export function ProjectSearchList({
  projects,
  onPick,
  exclude,
}: {
  projects: Project[];
  onPick: (project: Project) => void;
  exclude?: ReadonlySet<string>;
}): React.JSX.Element {
  const available = projects.filter((p) => !p.archived && !exclude?.has(p.id));
  return (
    <CommandPrimitive
      className="flex flex-col"
      filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
    >
      <div className="p-1 pb-0">
        <div className={LIST_SEARCH}>
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <CommandPrimitive.Input
            autoFocus
            placeholder="Open a project…"
            className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <CommandPrimitive.List className="rail-scroll max-h-72 overflow-y-auto p-1">
        <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
          {available.length === 0 ? 'Every project is already open.' : 'No matching project.'}
        </CommandPrimitive.Empty>
        {available.map((project) => (
          <CommandPrimitive.Item
            key={project.id}
            value={`${project.name} ${project.folderPath} ${project.id}`}
            onSelect={() => onPick(project)}
            className={LIST_OPTION}
          >
            <ProjectIcon
              iconDataUrl={project.iconDataUrl}
              bgColor={project.iconBgColor}
              iconColor={project.iconColor}
              className="h-6 w-6 rounded-md"
              glyphClassName="h-3 w-3"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{project.name}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {project.folderPath}
              </span>
            </span>
          </CommandPrimitive.Item>
        ))}
      </CommandPrimitive.List>
    </CommandPrimitive>
  );
}

function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  const word = words[0] ?? '?';
  // CamelCase names ("Runova") read better as their two capitals.
  const capitals = word.match(/[A-Z]/g);
  if (capitals && capitals.length >= 2) return `${capitals[0]}${capitals[1]}`;
  return word.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/**
 * The small round marks pinned to a rail tile's corners. They float over the tile, so they keep
 * an opaque popover fill on hover too, and their edge is a ring the global border colour can't
 * repaint.
 */
const RAIL_BADGE =
  'absolute h-4 w-4 min-w-4 bg-popover shadow-sm ring-1 ring-foreground/10 hover:bg-popover [&_svg]:size-2';

function RailItem({
  project,
  active,
  activeProjectId,
  onOpen,
  onClose,
  reorder,
}: {
  project: Project;
  active: boolean;
  /** The workspace on screen, which may be one of this project's worktrees. */
  activeProjectId: string | null;
  onOpen: () => void;
  onClose: () => void;
  reorder: ReorderMotion;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const commands = useWorktreeCommands();
  const tabIds = useWorkspaceStore(
    useShallow((s) =>
      Object.values(s.workspaces[project.id]?.tabs ?? {})
        .filter((t) => t.kind === 'terminal')
        .map((t) => t.id),
    ),
  );
  const tabCount = tabIds.length;
  const attention = useAgentStatusStore((s) =>
    attentionStatus(tabIds.map((id) => s.statuses[id] ?? 'idle')),
  );
  const busyCount = useAgentStatusStore(
    (s) => tabIds.filter((id) => s.statuses[id] === 'working').length,
  );
  const worktrees = useWorktrees(project.id).data ?? [];
  const expanded = useWorkspaceStore((s) => s.railExpanded[project.id] !== false);
  const setRailExpanded = useWorkspaceStore((s) => s.setRailExpanded);
  // One of this project's worktrees is on screen, so the project tile keeps a lighter ring.
  const holdsActive = !active && Boolean(activeProjectId?.startsWith(`${project.id}~`));
  const count = worktrees.length;
  const countLabel = `${count} worktree${count === 1 ? '' : 's'}`;
  const tileRef = useRef<HTMLDivElement>(null);

  // A project opened from elsewhere may sit below the fold of a long rail, so bring it into view.
  useEffect(() => {
    if (active) tileRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <div
      {...reorder.itemProps}
      className={cn(
        'flex w-full flex-col items-center gap-1.5',
        reorder.dragging
          ? 'z-10 scale-105 transition-none'
          : 'transition-transform duration-200 ease-out motion-reduce:transition-none',
      )}
    >
      <div
        ref={tileRef}
        onPointerDown={reorder.onGripPointerDown}
        className="group relative flex w-full cursor-grab touch-none justify-center active:cursor-grabbing"
      >
        {active ? (
          <motion.span
            layoutId="workspace-rail-active"
            className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
            transition={
              reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 34 }
            }
          />
        ) : null}
        <ContextMenu modal={false}>
          <SimpleTooltip
            side="right"
            label={
              <span className="flex flex-col">
                <span className="font-semibold">{project.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {project.folderPath}
                </span>
                {tabCount > 0 ? (
                  <span className="mt-0.5 text-[10px] text-muted-foreground">
                    {tabCount} terminal{tabCount === 1 ? '' : 's'} open
                    {busyCount > 0 ? `, ${busyCount} working` : ''}
                  </span>
                ) : null}
                <AgentStatusChip status={attention} className="mt-1 self-start" />
                {count > 0 ? (
                  <span className="text-[10px] text-muted-foreground">{countLabel}</span>
                ) : null}
              </span>
            }
          >
            <ContextMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Open ${project.name}`}
                aria-current={active ? 'page' : undefined}
                onClick={onOpen}
                className={cn(
                  'relative rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  // On glass the rail has no fill of its own, so an offset there would paint a
                  // solid band of page colour around the tile; the ring sits flush instead.
                  active
                    ? 'shadow-[0_0_16px_-2px_hsl(var(--primary)/0.55)] ring-2 ring-primary/70 ring-offset-2 ring-offset-background glass:ring-offset-0'
                    : holdsActive
                      ? 'ring-1 ring-primary/35 ring-offset-2 ring-offset-background glass:ring-offset-0'
                      : 'opacity-70 hover:-translate-y-px hover:opacity-100 motion-reduce:hover:translate-y-0',
                )}
              >
                {project.iconDataUrl ? (
                  <ProjectIcon
                    iconDataUrl={project.iconDataUrl}
                    bgColor={project.iconBgColor}
                    iconColor={project.iconColor}
                    className="h-9 w-9 rounded-xl"
                  />
                ) : (
                  // Folder glyphs all look alike in a column; initials tell projects apart at a glance.
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-[13px] font-semibold tracking-tight"
                    style={monogramStyle(project)}
                  >
                    {initials(project.name)}
                  </span>
                )}
                {attention ? (
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-foreground/[0.08]">
                    <AgentStatusDot status={attention} />
                  </span>
                ) : null}
              </button>
            </ContextMenuTrigger>
          </SimpleTooltip>
          <ContextMenuContent className="min-w-[12rem]">
            <ContextMenuItem onSelect={() => commands.create({ projectId: project.id })}>
              <GitBranch className="h-3.5 w-3.5" />
              New worktree…
            </ContextMenuItem>
            {count > 0 ? (
              <ContextMenuItem onSelect={() => setRailExpanded(project.id, !expanded)}>
                {expanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {expanded ? 'Hide worktrees' : 'Show worktrees'}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem tone="danger" onSelect={onClose}>
              <X className="h-3.5 w-3.5" />
              Close workspace
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <SimpleTooltip label="Close workspace" side="right">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Close ${project.name} workspace`}
            onClick={onClose}
            className={cn(
              RAIL_BADGE,
              '-top-1 right-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
            )}
          >
            <X />
          </Button>
        </SimpleTooltip>
        {count > 0 && expanded ? (
          <SimpleTooltip label="Hide worktrees" side="right">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Hide ${project.name} worktrees`}
              onClick={() => setRailExpanded(project.id, false)}
              className={cn(
                RAIL_BADGE,
                '-bottom-1 left-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              )}
            >
              <ChevronUp />
            </Button>
          </SimpleTooltip>
        ) : null}
        {count > 0 && !expanded ? (
          <SimpleTooltip label={`${countLabel}, click to show`} side="right">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Show ${count} ${project.name} worktree${count === 1 ? '' : 's'}`}
              onClick={() => setRailExpanded(project.id, true)}
              className={cn(
                RAIL_BADGE,
                '-bottom-1.5 left-0.5 w-auto gap-0.5 px-1 text-[9px] font-semibold text-muted-foreground hover:text-primary hover:ring-primary/50',
              )}
            >
              <GitBranch />
              {count}
            </Button>
          </SimpleTooltip>
        ) : null}
      </div>
      <RailWorktreeGroup
        project={project}
        worktrees={worktrees}
        expanded={expanded}
        activeProjectId={activeProjectId}
      />
    </div>
  );
}

/** The narrow strip on the left: projects with an open workspace, and a way to open another. */
export function ProjectRail({
  projects,
  activeProjectId,
}: {
  projects: Project[];
  activeProjectId: string | null;
}): React.JSX.Element {
  const navigate = useNavigate();
  const railProjectIds = useWorkspaceStore((s) => s.railProjectIds);
  const closeProject = useWorkspaceStore((s) => s.closeProject);
  const moveRailProject = useWorkspaceStore((s) => s.moveRailProject);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Memoized so a drag keeps its order while the store reports agent status changes.
  const railProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return railProjectIds.flatMap((id) => byId.get(id) ?? []);
  }, [projects, railProjectIds]);

  /** A tile landed at `to` among the visible tiles. The store counts slots with the tile still in place. */
  function moveTile(from: number, to: number): void {
    const dragged = railProjects[from];
    const target = railProjects[to];
    if (!dragged || !target) return;
    const slot =
      to > from ? railProjectIds.indexOf(target.id) + 1 : railProjectIds.indexOf(target.id);
    moveRailProject(dragged.id, slot);
  }

  async function requestClose(project: Project): Promise<void> {
    const state = useWorkspaceStore.getState();
    const ended = useTerminalSessionStore.getState().ended;
    const open = Object.values(state.workspaces[project.id]?.tabs ?? {}).filter(
      (tab) => tab.kind === 'terminal' && !(tab.id in ended),
    ).length;
    if (open > 0) {
      const ok = await confirmDialog({
        title: `Close the ${project.name} workspace?`,
        description: `${open} terminal${open === 1 ? '' : 's'} will be stopped.`,
        confirmLabel: 'Close workspace',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    closeProject(project.id);
    const next = useWorkspaceStore.getState().activeProjectId;
    navigate(next ? `/workspace/${next}` : '/workspace', { replace: true });
  }

  return (
    <nav
      aria-label="Open workspaces"
      className="flex w-14 shrink-0 flex-col items-center border-r border-border/70 bg-card/30 pb-3 glass:border-r-0 glass:bg-transparent"
    >
      {/* Only the projects scroll; the open button stays pinned right under them. Never sideways:
          a lifted tile is a pixel or two wider than the rail, which would grow a scrollbar. */}
      <OverflowScroll
        surface="chrome"
        rootClassName="flex w-full flex-col"
        className="rail-scroll flex w-full flex-col items-center gap-2.5 overflow-x-hidden pb-2.5 pt-3"
      >
        <ReorderableGroup
          items={railProjects}
          getId={(project) => project.id}
          enabled
          className="flex w-full flex-col items-center gap-2.5"
          onMove={moveTile}
          renderItem={(project, motion) => (
            <RailItem
              project={project}
              active={project.id === activeProjectId}
              activeProjectId={activeProjectId}
              onOpen={() => navigate(`/workspace/${project.id}`)}
              onClose={() => void requestClose(project)}
              reorder={motion}
            />
          )}
        />
      </OverflowScroll>
      <PopoverPrimitive.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <SimpleTooltip label="Open another project" side="right">
          <PopoverPrimitive.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              shape="square"
              size="icon"
              aria-label="Open another project"
              // Squared like the project tiles above it. The edge is an inset ring, since a
              // tinted border would lose to the global border colour.
              className="h-9 w-9 rounded-xl bg-foreground/[0.04] text-muted-foreground ring-1 ring-inset ring-foreground/[0.08] hover:bg-primary/10 hover:text-primary hover:ring-primary/40 data-[state=open]:bg-primary/12 data-[state=open]:text-primary data-[state=open]:ring-primary/45 [&_svg]:size-3.5"
            >
              <Plus />
            </Button>
          </PopoverPrimitive.Trigger>
        </SimpleTooltip>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="right"
            align="start"
            sideOffset={10}
            className={cn(
              OVERLAY_SURFACE,
              OVERLAY_MOTION,
              'z-50 w-72 overflow-hidden origin-[var(--radix-popover-content-transform-origin)]',
            )}
          >
            <ProjectSearchList
              projects={projects}
              exclude={new Set(railProjectIds)}
              onPick={(project) => {
                setPickerOpen(false);
                navigate(`/workspace/${project.id}`);
              }}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </nav>
  );
}
