import { parseScopeId } from '@agentmat/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Blocks,
  Cpu,
  Folder,
  GitBranch,
  History,
  Plus,
  Search,
  Workspace,
} from '@/components/icons';
import { NAV_ITEMS } from '@/components/layout/Sidebar';
import { SshFilesPaletteGroup } from '@/components/sftp/SshFilesPaletteGroup';
import { VaultPaletteGroup } from '@/components/vault/VaultPaletteGroup';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { useSearchStore } from '@/stores/searchStore';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';

/** The panel's padding plus its 1px border, so its search field lands exactly on the title bar's. */
const ANCHOR_INSET = 7;
/** Narrower than this and project paths and skill descriptions would truncate too hard. */
const MIN_ANCHORED_WIDTH = 480;

/**
 * Where the title bar's search box is while the panel is open. The panel opens on top of it, so
 * typing reads as typing into that same box with the results dropping down from it.
 */
function useSearchAnchor(open: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const box = document.querySelector('[data-search-anchor]')?.getBoundingClientRect();
      setRect(box && box.width > 0 ? box : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);
  return rect;
}

export function CommandPalette(): React.JSX.Element {
  const open = useSearchStore((s) => s.open);
  const setOpen = useSearchStore((s) => s.setOpen);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const anchor = useSearchAnchor(open);
  const anchoredWidth = anchor ? Math.max(anchor.width + ANCHOR_INSET * 2, MIN_ANCHORED_WIDTH) : 0;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
    enabled: open,
  });
  const historyQuery = useQuery({
    queryKey: queryKeys.promptHistory,
    queryFn: () => window.agentmat.promptHistory.list(),
    enabled: open,
  });
  const reposQuery = useQuery({
    queryKey: queryKeys.repositories,
    queryFn: () => window.agentmat.skills.listRepositories(),
    enabled: open,
  });
  const repoIndexQueries = useQueries({
    queries: (reposQuery.data ?? []).map((repo) => ({
      queryKey: queryKeys.repositoryIndex(repo.id),
      queryFn: () => window.agentmat.skills.getRepositoryIndex(repo.id),
      enabled: open,
    })),
  });

  const skillResults = useMemo(() => {
    const repos = reposQuery.data ?? [];
    return repoIndexQueries.flatMap((q, i) => {
      const repo = repos[i];
      if (!repo || !q.data) return [];
      return q.data.skills.map((skill) => ({ skill, repo }));
    });
  }, [repoIndexQueries, reposQuery.data]);

  // Worktrees of the projects open in the rail, the ones someone is likely to jump between.
  const railProjectIds = useWorkspaceStore((s) => s.railProjectIds);
  const activeScope = useWorkspaceStore((s) => s.activeProjectId);
  const worktreeQueries = useQueries({
    queries: railProjectIds.map((id) => ({
      queryKey: queryKeys.worktrees(id),
      queryFn: () => window.agentmat.worktrees.list(id),
      enabled: open,
      staleTime: 15_000,
    })),
  });
  const worktreeResults = railProjectIds.flatMap((id, index) => {
    const project = projectsQuery.data?.find((p) => p.id === id);
    const list = worktreeQueries[index]?.data ?? [];
    return project ? list.map((worktree) => ({ project, worktree })) : [];
  });
  const activeParent = activeScope
    ? (projectsQuery.data?.find((p) => p.id === parseScopeId(activeScope).projectId) ?? null)
    : null;

  function selectPage(to: string): void {
    setOpen(false);
    navigate(to);
  }

  function selectToastHistory(): void {
    setOpen(false);
    useToastHistoryStore.getState().setOpen(true);
  }

  function selectRunningClis(): void {
    setOpen(false);
    useRunningClisStore.getState().setOpen(true);
  }

  function selectProject(id: string): void {
    setOpen(false);
    navigate(`/projects/${id}`);
  }

  function selectHistoryEntry(id: string): void {
    setOpen(false);
    navigate('/prompt-history', { state: { openEntryId: id } });
  }

  function selectSkill(repositoryId: string, skillName: string): void {
    setOpen(false);
    navigate('/skills', { state: { repositoryId, query: skillName } });
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        {/* Both layers sit over the title bar, whose drag region would otherwise take their clicks. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/15 [-webkit-app-region:no-drag] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        {/* Opens over the title bar's search box with its own field in exactly that spot, so the
            box looks like it grows the results downward. Centred near the top when there is no
            box to anchor to. */}
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          style={
            anchor
              ? {
                  top: anchor.top - ANCHOR_INSET,
                  left: anchor.left + anchor.width / 2 - anchoredWidth / 2,
                  width: anchoredWidth,
                }
              : undefined
          }
          className={cn(
            'search-panel fixed z-50 text-popover-foreground [-webkit-app-region:no-drag]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            !anchor &&
              'left-1/2 top-12 w-full max-w-xl -translate-x-1/2 data-[state=open]:zoom-in-95',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search AgentMate</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search projects, prompt history, and skills.
          </DialogPrimitive.Description>
          <CommandPrimitive className="flex flex-col" loop>
            <div className="p-1.5 pb-0">
              <div className="search-pill flex h-8 items-center gap-2 rounded-full pl-3.5 pr-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <CommandPrimitive.Input
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search projects, history, skills…"
                  className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                />
                <kbd className="hidden shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:inline-block">
                  Esc
                </kbd>
              </div>
            </div>
            <CommandPrimitive.List className="rail-scroll max-h-[60vh] overflow-y-auto p-2">
              <CommandPrimitive.Empty className="py-10 text-center text-sm text-muted-foreground">
                No results found.
              </CommandPrimitive.Empty>

              <CommandPrimitive.Group
                heading="Go to"
                className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
              >
                {NAV_ITEMS.map((item) => (
                  <CommandPrimitive.Item
                    key={item.to}
                    value={`page ${item.label}`}
                    onSelect={() => selectPage(item.to)}
                    className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                  >
                    <item.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {item.label}
                  </CommandPrimitive.Item>
                ))}
                <CommandPrimitive.Item
                  value="page recent messages toast history alerts"
                  onSelect={selectToastHistory}
                  className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                >
                  <Bell className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  Recent messages
                </CommandPrimitive.Item>
                <CommandPrimitive.Item
                  value="running clis terminals processes cpu memory ram usage"
                  onSelect={selectRunningClis}
                  className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                >
                  <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  Running CLIs
                </CommandPrimitive.Item>
              </CommandPrimitive.Group>

              <VaultPaletteGroup enabled={open} onDone={() => setOpen(false)} />

              <SshFilesPaletteGroup enabled={open} query={query} onDone={() => setOpen(false)} />

              {(projectsQuery.data?.length ?? 0) > 0 && (
                <CommandPrimitive.Group
                  heading="Projects"
                  className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
                >
                  {projectsQuery.data!.map((project) => (
                    <CommandPrimitive.Item
                      key={project.id}
                      value={`project ${project.name} ${project.description} ${project.folderPath} ${project.tags.join(' ')}`}
                      onSelect={() => selectProject(project.id)}
                      className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate">{project.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {project.folderPath}
                        </div>
                      </div>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              )}

              {/* Only once the user types, so an empty palette doesn't list every project twice. */}
              {query.trim() && (projectsQuery.data?.length ?? 0) > 0 && (
                <CommandPrimitive.Group
                  heading="Open workspace"
                  className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
                >
                  {projectsQuery
                    .data!.filter((project) => !project.archived)
                    .map((project) => (
                      <CommandPrimitive.Item
                        key={`workspace-${project.id}`}
                        value={`workspace terminal agent ${project.name} ${project.folderPath}`}
                        onSelect={() => selectPage(`/workspace/${project.id}`)}
                        className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                      >
                        <Workspace className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          <span className="text-muted-foreground">Workspace: </span>
                          {project.name}
                        </span>
                      </CommandPrimitive.Item>
                    ))}
                </CommandPrimitive.Group>
              )}

              {query.trim() && (activeParent || worktreeResults.length > 0) ? (
                <CommandPrimitive.Group
                  heading="Worktrees"
                  className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
                >
                  {activeParent ? (
                    <CommandPrimitive.Item
                      value={`new worktree branch ${activeParent.name}`}
                      onSelect={() => {
                        setOpen(false);
                        useWorktreeDialogStore
                          .getState()
                          .openCreate({ projectId: activeParent.id });
                      }}
                      className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">New worktree of {activeParent.name}</span>
                    </CommandPrimitive.Item>
                  ) : null}
                  {worktreeResults.map(({ project, worktree }) => (
                    <CommandPrimitive.Item
                      key={`worktree-${project.id}-${worktree.id}`}
                      value={`worktree ${project.name} ${worktree.branch ?? ''} ${worktree.path}`}
                      onSelect={() => selectPage(`/workspace/${project.id}~${worktree.id}`)}
                      className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                    >
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 text-muted-foreground">{project.name}</span>
                        <span className="truncate font-mono text-[13px]">
                          {worktree.branch ?? worktree.path}
                        </span>
                      </span>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              ) : null}

              {(historyQuery.data?.length ?? 0) > 0 && (
                <CommandPrimitive.Group
                  heading="Prompt History"
                  className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
                >
                  {historyQuery.data!.map((entry) => (
                    <CommandPrimitive.Item
                      key={entry.id}
                      value={
                        entry.source === 'translate'
                          ? `history translation ${entry.content} ${entry.tags.join(' ')}`
                          : `history ${entry.promptType} ${entry.targetAI} ${entry.content} ${entry.tags.join(' ')}`
                      }
                      onSelect={() => selectHistoryEntry(entry.id)}
                      className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                    >
                      <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate">
                          {entry.source === 'translate'
                            ? 'Translation'
                            : `${entry.promptType} · ${entry.targetAI}`}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {entry.content}
                        </div>
                      </div>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              )}

              {skillResults.length > 0 && (
                <CommandPrimitive.Group
                  heading="Skills"
                  className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60"
                >
                  {skillResults.map(({ skill, repo }) => (
                    <CommandPrimitive.Item
                      key={`${repo.id}-${skill.id}`}
                      value={`skill ${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(' ')}`}
                      onSelect={() => selectSkill(repo.id, skill.name)}
                      className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground"
                    >
                      <Blocks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate">{skill.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {skill.description}
                        </div>
                      </div>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              )}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
