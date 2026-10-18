import type { AgentType, Project } from '@agentmat/core';
import {
  AGENT_TYPE_CLI_ID,
  AGENT_TYPE_LABELS,
  configuredRunCommands,
  DIFFRAY_TOOL_ID,
  isClonableGithubUrl,
  projectRunCommandHint,
} from '@agentmat/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import {
  Archive,
  ArchiveRestore,
  Folder,
  FolderKanban,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Globe,
  GripVertical,
  ListUnordered,
  Pin,
  Plus,
  Run,
  Search,
  Sparkles,
  X,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { DiffrayReviewWizardDialog } from '@/components/projects/DiffrayReviewWizard';
import { ProjectFormDialog, type ProjectFormValues } from '@/components/projects/ProjectFormDialog';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { ProjectPromptBuildDialog } from '@/components/projects/ProjectPromptBuildDialog';
import { useProjectRun } from '@/components/projects/useProjectRun';
import { NewProjectButton } from '@/components/projects/wordpress/NewProjectButton';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ReorderableGroup, type ReorderMotion } from '@/components/ui/ReorderableGroup';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { openCliInTerminal } from '@/lib/openCli';
import { queryKeys } from '@/lib/queryKeys';
import { persianTextProps } from '@/lib/rtl';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';

const VIEW_STORAGE_KEY = 'agentmate.projects.view';
const MAX_VISIBLE_TAGS = 3;
const AGENT_TYPE_ORDER = Object.keys(AGENT_TYPE_LABELS) as AgentType[];

type ProjectsView = 'grid' | 'list';
type AgentFilter = 'all' | AgentType;

function agentFilterLabel(filter: AgentFilter): string {
  return filter === 'all' ? 'all agents' : AGENT_TYPE_LABELS[filter];
}

function readStoredView(): ProjectsView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function folderBasename(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || folderPath;
}

function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export default function ProjectsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [promptBuildOpen, setPromptBuildOpen] = useState(false);
  const [promptBuildProject, setPromptBuildProject] = useState<Project | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewProject, setReviewProject] = useState<Project | null>(null);
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');
  const [view, setView] = useState<ProjectsView>(readStoredView);
  const [showArchived, setShowArchived] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { requestRun, runPicker } = useProjectRun();
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  const toolsStatusQuery = useQuery({
    queryKey: queryKeys.toolsStatus,
    queryFn: () => window.agentmat.tools.detectAll(),
  });
  const diffrayInstalled =
    toolsStatusQuery.data?.find((tool) => tool.id === DIFFRAY_TOOL_ID)?.installed === true;

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setDialogOpen(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Private mode and quota errors shouldn't block the page.
    }
  }, [view]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (dialogOpen || promptBuildOpen || reviewOpen) return;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, promptBuildOpen, reviewOpen]);

  const createMutation = useMutation({
    mutationFn: async (
      values: ProjectFormValues,
    ): Promise<{ project: Project; cloned: boolean; cloneError: string | null }> => {
      let cloned = false;
      let cloneError: string | null = null;
      const repo = values.repoUrl?.trim();
      // Auto-clone ("Clone into Folder"): a GitHub address is cloned into the chosen
      // folder before the record is created. A failed clone never blocks creation: the
      // address is kept, and the Git tab offers Clone from GitHub to retry.
      if (repo && isClonableGithubUrl(repo)) {
        try {
          const result = await window.agentmat.git.cloneInto({
            folderPath: values.folderPath,
            repoUrl: repo,
          });
          if (result.ok) cloned = !result.skipped;
          else cloneError = result.message;
        } catch (error) {
          cloneError = error instanceof Error ? error.message : 'Clone failed.';
        }
      }
      const project = await window.agentmat.projects.create(values);
      return { project, cloned, cloneError };
    },
    onSuccess: ({ project, cloned, cloneError }) => {
      if (cloneError) {
        toast.error(`Project created, but the clone failed: ${cloneError}`, {
          description: 'Use Clone from GitHub on the Git tab to try again.',
        });
      } else {
        toast.success(cloned ? 'Project created and repository cloned.' : 'Project created.');
      }
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // Land on the Git tab after a clone so Fetch and Pull are one click away, and after a
      // failed one so the retry is right there instead of in a toast that has gone.
      if (cloned || cloneError) navigate(`/projects/${project.id}?tab=git`);
    },
  });

  const pinMutation = useMutation({
    mutationFn: ({ projectId, pinned }: { projectId: string; pinned: boolean }) =>
      window.agentmat.projects.setPinned(projectId, pinned),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) =>
        prev?.map((p) => (p.id === updated.id ? updated : p)),
      );
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ projectId, archived }: { projectId: string; archived: boolean }) =>
      window.agentmat.projects.setArchived(projectId, archived),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) =>
        prev?.map((p) => (p.id === updated.id ? updated : p)),
      );
      toast.success(
        updated.archived ? `Archived “${updated.name}”.` : `Restored “${updated.name}”.`,
      );
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => window.agentmat.projects.reorder(orderedIds),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.projects, updated);
    },
  });

  usePageHeader('Projects', 'Open a workspace, pin favorites, or archive what you are done with.');

  function handleRun(project: Project): void {
    requestRun(project, {
      // Nothing to run yet, so go where one gets made: the project page opens its AI helper.
      onEmpty: () => navigate(`/projects/${project.id}?createRun=ai`),
    });
  }

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const query = search.trim().toLowerCase();

  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const archivedProjects = useMemo(() => projects.filter((p) => p.archived), [projects]);
  // The Archived toggle picks which pile the page is looking at. Search and the
  // agent filter then run over whichever pile is on screen, never across both.
  const visible = showArchived ? archivedProjects : activeProjects;

  const agentTypesPresent = useMemo(
    () => AGENT_TYPE_ORDER.filter((type) => visible.some((project) => project.agentType === type)),
    [visible],
  );

  const filtered = useMemo(() => {
    return visible.filter((project) => {
      if (agentFilter !== 'all' && project.agentType !== agentFilter) return false;
      if (!query) return true;
      return [project.name, project.description, project.folderPath, ...project.tags]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [visible, query, agentFilter]);

  // Reordering is disabled while the visible list is a subset, so a drag
  // couldn't express where a card should land among hidden siblings.
  const dragEnabled = !showArchived && query.length === 0 && agentFilter === 'all';
  const pinnedProjects = useMemo(() => filtered.filter((p) => p.pinned), [filtered]);
  const unpinnedProjects = useMemo(() => filtered.filter((p) => !p.pinned), [filtered]);
  const filtersActive = query.length > 0 || agentFilter !== 'all';

  function saveGroupOrder(group: 'pinned' | 'unpinned', reordered: Project[]): void {
    // Dragging is only ever enabled on the active pile, but the saved order is
    // the whole list, so the archived projects ride along at the end.
    const fullOrder =
      group === 'pinned'
        ? [...reordered, ...unpinnedProjects, ...archivedProjects]
        : [...pinnedProjects, ...reordered, ...archivedProjects];
    queryClient.setQueryData(queryKeys.projects, fullOrder);
    reorderMutation.mutate(fullOrder.map((p) => p.id));
  }

  /** A drag landed one project at another index within its pin group. */
  function moveWithinGroup(group: 'pinned' | 'unpinned', fromIndex: number, toIndex: number): void {
    const reordered = [...(group === 'pinned' ? pinnedProjects : unpinnedProjects)];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    saveGroupOrder(group, reordered);
  }

  // Restoring the last archived project would otherwise strand the page on an
  // empty view whose own toggle has just disappeared.
  useEffect(() => {
    if (showArchived && archivedProjects.length === 0) setShowArchived(false);
  }, [showArchived, archivedProjects.length]);

  function toggleArchivedView(): void {
    setShowArchived((current) => !current);
    setAgentFilter('all');
  }

  function clearFilters(): void {
    setSearch('');
    setAgentFilter('all');
    searchRef.current?.focus();
  }

  function renderProject(project: Project, motion: ReorderMotion): React.JSX.Element {
    const cardProps: ProjectItemProps = {
      project,
      view,
      draggable: dragEnabled,
      motion,
      onNavigate: () => navigate(`/projects/${project.id}`),
      onOpenGit: () => navigate(`/projects/${project.id}?tab=git`),
      onRun: () => handleRun(project),
      onBuildPrompt: () => {
        setPromptBuildProject(project);
        setPromptBuildOpen(true);
      },
      onReview: () => {
        setReviewProject(project);
        setReviewOpen(true);
      },
      onTogglePin: () => pinMutation.mutate({ projectId: project.id, pinned: !project.pinned }),
      onToggleArchive: () =>
        archiveMutation.mutate({ projectId: project.id, archived: !project.archived }),
    };
    return <ProjectItem key={project.id} {...cardProps} />;
  }

  function renderGroup(group: 'pinned' | 'unpinned', projects: Project[]): React.JSX.Element {
    return (
      <ReorderableGroup
        items={projects}
        getId={(project) => project.id}
        enabled={dragEnabled}
        className={view === 'list' ? LIST_CARD : GRID_GROUP}
        onMove={(fromIndex, toIndex) => moveWithinGroup(group, fromIndex, toIndex)}
        renderItem={(project, motion) => renderProject(project, motion)}
      />
    );
  }

  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="search-pill flex h-9 w-full min-w-[12rem] items-center gap-2 rounded-full pl-3.5 pr-1.5 transition-colors sm:w-72">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.preventDefault();
                setSearch('');
              }
            }}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setSearch('')}
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none hidden shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:inline-block">
              /
            </kbd>
          )}
        </div>

        {visible.length > 0 && (
          <span className="rounded-full bg-foreground/[0.06] px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
            {filtered.length === visible.length
              ? `${visible.length} ${visible.length === 1 ? 'project' : 'projects'}`
              : `${filtered.length} of ${visible.length}`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {archivedProjects.length > 0 && (
            <SimpleTooltip
              label={showArchived ? 'Back to active projects' : 'Show archived projects'}
            >
              <Button
                // The pressed state is the primary tint, with a hairline ring so it reads as on.
                // The weight stays medium in both states so the label doesn't shift.
                variant={showArchived ? 'tint' : 'soft'}
                aria-pressed={showArchived}
                className={cn(
                  'h-9 shrink-0 font-medium',
                  showArchived && 'ring-1 ring-inset ring-primary/25',
                )}
                onClick={toggleArchivedView}
              >
                <Archive className="h-4 w-4" /> Archived
                <span className="rounded-full bg-current/10 px-1.5 text-[10px] leading-4 tabular-nums">
                  {archivedProjects.length}
                </span>
              </Button>
            </SimpleTooltip>
          )}
          {projects.length > 0 && (
            <LayoutGroup id="projects-view">
              <div className="search-pill flex h-9 items-center gap-0.5 rounded-full p-0.5">
                <ViewToggle
                  label="Grid view"
                  active={view === 'grid'}
                  onClick={() => setView('grid')}
                  transition={pillTransition}
                >
                  <FolderKanban className="h-4 w-4" />
                </ViewToggle>
                <ViewToggle
                  label="List view"
                  active={view === 'list'}
                  onClick={() => setView('list')}
                  transition={pillTransition}
                >
                  <ListUnordered className="h-4 w-4" />
                </ViewToggle>
              </div>
            </LayoutGroup>
          )}
          <NewProjectButton onNewEmpty={() => setDialogOpen(true)} />
        </div>
      </div>

      {visible.length > 0 && agentTypesPresent.length > 1 && (
        <LayoutGroup id="projects-agent-filter">
          <div
            className="search-pill inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-[1.1rem] p-0.5"
            role="group"
            aria-label="Filter by agent"
          >
            <FilterChip
              active={agentFilter === 'all'}
              onClick={() => setAgentFilter('all')}
              transition={pillTransition}
            >
              All agents
            </FilterChip>
            {agentTypesPresent.map((type) => {
              const cliId = AGENT_TYPE_CLI_ID[type];
              return (
                <FilterChip
                  key={type}
                  active={agentFilter === type}
                  onClick={() => setAgentFilter(agentFilter === type ? 'all' : type)}
                  transition={pillTransition}
                >
                  {cliId ? <CliLogo cliId={cliId} className="h-3 w-3" /> : null}
                  {AGENT_TYPE_LABELS[type]}
                </FilterChip>
              );
            })}
          </div>
        </LayoutGroup>
      )}

      {projectsQuery.isLoading ? (
        view === 'list' ? (
          <div role="status" aria-label="Loading projects" className={LIST_CARD}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="hidden h-6 w-24 rounded-full md:block" />
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-8 w-[5.5rem] rounded-full" />
              </div>
            ))}
          </div>
        ) : (
          <div
            role="status"
            aria-label="Loading projects"
            className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <Card key={i} className={cn(CARD, 'flex flex-col')}>
                <div className="space-y-3 p-4 pb-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                  <Skeleton className="h-3 w-full" />
                  <div className="flex gap-1.5">
                    <Skeleton className="h-6 w-24 rounded-full" />
                    <Skeleton className="h-6 w-12 rounded-full" />
                  </div>
                </div>
                <div className={cn(CARD_FOOTER, 'mt-auto')}>
                  <Skeleton className="h-8 w-16 rounded-full" />
                  <Skeleton className="ml-auto h-8 w-[5.5rem] rounded-full" />
                </div>
              </Card>
            ))}
          </div>
        )
      ) : projects.length === 0 ? (
        <div className={cn(CARD, 'px-6 py-16')}>
          <EmptyState
            icon={<FolderPlus className="h-6 w-6" />}
            title="No projects yet"
            description="Add a folder AgentMate can bootstrap and work in. You can pin it, run it, and build prompts from here."
            action={
              <Button onClick={() => setDialogOpen(true)}>
                <Plus /> New Project
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className={cn(CARD, 'px-6 py-14')}>
          <EmptyState
            icon={<Search className="h-5 w-5" />}
            title="No matching projects"
            description={
              query
                ? `Nothing matches “${search.trim()}”${agentFilter === 'all' ? '' : ` in ${agentFilterLabel(agentFilter)}`}.`
                : `No ${agentFilterLabel(agentFilter)} projects yet.`
            }
            action={
              <Button variant="soft" onClick={clearFilters}>
                <X /> Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <LayoutGroup id="projects-cards">
          <div className="space-y-5">
            {pinnedProjects.length > 0 && (
              <section className="space-y-2">
                <GroupHeading
                  icon={<Pin className="h-3 w-3 text-primary" />}
                  count={pinnedProjects.length}
                >
                  Pinned
                </GroupHeading>
                {renderGroup('pinned', pinnedProjects)}
              </section>
            )}

            {unpinnedProjects.length > 0 && (
              <section className="space-y-2">
                {pinnedProjects.length > 0 || showArchived ? (
                  <GroupHeading
                    icon={showArchived ? <Archive className="h-3 w-3" /> : null}
                    count={unpinnedProjects.length}
                  >
                    {showArchived ? 'Archived' : filtersActive ? 'Matches' : 'All projects'}
                  </GroupHeading>
                ) : null}
                {renderGroup('unpinned', unpinnedProjects)}
              </section>
            )}
          </div>
        </LayoutGroup>
      )}

      <ProjectFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={(values) => createMutation.mutate(values)}
        isSubmitting={createMutation.isPending}
      />

      {promptBuildProject && (
        <ProjectPromptBuildDialog
          open={promptBuildOpen}
          onOpenChange={setPromptBuildOpen}
          projectId={promptBuildProject.id}
          projectName={promptBuildProject.name}
          iconDataUrl={promptBuildProject.iconDataUrl}
          iconBgColor={promptBuildProject.iconBgColor}
          iconColor={promptBuildProject.iconColor}
        />
      )}
      {reviewProject && (
        <DiffrayReviewWizardDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          project={reviewProject}
          installed={diffrayInstalled}
        />
      )}
      {runPicker}
    </div>
  );
}

/** The glass card every project sits on, rounded like the Settings and API Client cards. */
const CARD = 'glass rounded-[calc(var(--radius)+2px)]';
/** The card's shape without its glass, so a card held by the pointer can swap in an opaque surface. */
const CARD_SHAPE = 'rounded-[calc(var(--radius)+2px)]';

/** List view: one card per group, its rows split by the same hairline Settings uses. */
const LIST_CARD = cn(CARD, 'settings-rows overflow-hidden');

/** Grid view: cards side by side, one column on a phone. */
const GRID_GROUP = 'grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3';

/** A grid card's footer, set off by a hairline drawn as a shadow so the theme border rule can't recolour it. */
const CARD_FOOTER =
  'flex items-center gap-2 px-4 py-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]';

type PillTransition = React.ComponentProps<typeof motion.span>['transition'];

function GroupHeading({
  icon,
  count,
  children,
}: {
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
        {icon}
        {children}
      </h2>
      <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
        {icon}
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold tracking-tight">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** One segment of the grid/list switch; the active one carries the sliding pill. */
function ViewToggle({
  label,
  active,
  onClick,
  transition,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  transition: PillTransition;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'relative isolate flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {active && (
          <motion.span
            aria-hidden
            layoutId="projects-view-active"
            transition={transition}
            className="absolute inset-0 -z-10 rounded-full bg-primary/12"
          />
        )}
        {children}
      </button>
    </SimpleTooltip>
  );
}

function FilterChip({
  active,
  onClick,
  transition,
  children,
}: {
  active: boolean;
  onClick: () => void;
  transition: PillTransition;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative isolate inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'text-primary'
          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="projects-agent-filter-active"
          transition={transition}
          className="absolute inset-0 -z-10 rounded-full bg-primary/12"
        />
      )}
      {children}
    </button>
  );
}

interface ProjectItemProps {
  project: Project;
  view: ProjectsView;
  /** False while a search or agent filter hides part of the order, so the grip can't reorder. */
  draggable: boolean;
  motion: ReorderMotion;
  onNavigate: () => void;
  onOpenGit: () => void;
  onRun: () => void;
  onBuildPrompt: () => void;
  onReview: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
}

function ProjectItem(props: ProjectItemProps): React.JSX.Element {
  return props.view === 'list' ? <ProjectRow {...props} /> : <ProjectCard {...props} />;
}

/** The main menu's active marker, reused to say a project is pinned. */
function PinnedAccent({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute left-0 h-5 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]',
        className,
      )}
    />
  );
}

/**
 * The only draggable part of a card or row. Keeping the grip separate means a
 * click anywhere else is never mistaken for a reorder gesture.
 */
function DragGrip({
  disabled,
  onPointerDown,
  className,
}: {
  /** True while a search or agent filter hides part of the order. */
  disabled: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  className?: string;
}): React.JSX.Element {
  if (disabled) {
    return (
      <SimpleTooltip label="Clear the search and agent filter to reorder projects" wrapTrigger>
        <span
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'flex shrink-0 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground/25',
            className,
          )}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      </SimpleTooltip>
    );
  }

  return (
    <SimpleTooltip label="Drag to reorder">
      <span
        data-drag-grip
        onPointerDown={onPointerDown}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground/50 transition-[opacity,background-color] hover:bg-foreground/[0.08] hover:text-foreground active:cursor-grabbing',
          className,
        )}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
    </SimpleTooltip>
  );
}

function ProjectCard(props: ProjectItemProps): React.JSX.Element {
  const { project, motion, onNavigate } = props;
  const description = persianTextProps(project.description);
  const extraTags = Math.max(0, project.tags.length - MAX_VISIBLE_TAGS);

  return (
    <Card
      {...motion.itemProps}
      className={cn(
        CARD_SHAPE,
        'group relative flex cursor-pointer flex-col',
        // While it's held, the card turns near-opaque so the cards it passes don't show through.
        motion.dragging
          ? 'glass-opaque z-10 ring-1 ring-primary/40 transition-none'
          : 'glass transition-[transform,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none',
        // A ring rather than a border colour: the card's glass edge is unlayered CSS and would win.
        'hover:-translate-y-0.5 hover:ring-1 hover:ring-primary/30 focus-within:ring-1 focus-within:ring-primary/30 motion-reduce:hover:translate-y-0',
      )}
      onClick={onNavigate}
    >
      {project.pinned && <PinnedAccent className="top-[1.6rem]" />}
      <div className="space-y-3 p-4 pb-3">
        <div className="flex items-start gap-3">
          <ProjectIcon
            iconDataUrl={project.iconDataUrl}
            bgColor={project.iconBgColor}
            iconColor={project.iconColor}
            className="h-10 w-10 rounded-xl"
            glyphClassName="h-[18px] w-[18px]"
          />
          <div className="min-w-0 flex-1 pt-px">
            <button
              type="button"
              className="block max-w-full truncate rounded-sm text-left text-sm font-semibold leading-tight hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate();
              }}
            >
              {project.name}
            </button>
            <ProjectMetaLinks project={project} className="mt-1" />
          </div>
          <ProjectQuickActions {...props} compact />
        </div>
        {project.description ? (
          <p
            dir={description.dir}
            className={cn(
              'line-clamp-2 text-[13px] leading-relaxed text-muted-foreground',
              description.className,
            )}
          >
            {project.description}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <AgentBadge project={project} />
          {project.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
            <TagChip key={tag}>{tag}</TagChip>
          ))}
          {extraTags > 0 && (
            <SimpleTooltip label={project.tags.slice(MAX_VISIBLE_TAGS).join(', ')} wrapTrigger>
              <TagChip>+{extraTags}</TagChip>
            </SimpleTooltip>
          )}
        </div>
      </div>
      <div className={cn(CARD_FOOTER, 'mt-auto')}>
        <RunButton project={project} onRun={props.onRun} />
        <span className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
          Updated {timeAgo(project.updatedAt)}
        </span>
        <ProjectSecondaryActions {...props} className="ml-auto" />
      </div>
    </Card>
  );
}

function ProjectRow(props: ProjectItemProps): React.JSX.Element {
  const { project, onNavigate, motion } = props;
  const description = persianTextProps(project.description);

  return (
    // Rows share one card, so each is a plain row with the menu's hover wash rather than a box.
    // A dragged row lifts off the card while the rows around it slide out of its way.
    <div
      {...motion.itemProps}
      className={cn(
        'group relative flex cursor-pointer items-center gap-3 px-3 py-2.5 focus-within:bg-foreground/[0.04]',
        motion.dragging
          ? 'z-10 rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10 transition-none'
          : 'transition-[transform,background-color,opacity] duration-200 ease-out hover:bg-foreground/[0.04] motion-reduce:transition-none',
      )}
      onClick={onNavigate}
    >
      {project.pinned && <PinnedAccent className="top-1/2 -translate-y-1/2" />}
      <ProjectIcon
        iconDataUrl={project.iconDataUrl}
        bgColor={project.iconBgColor}
        iconColor={project.iconColor}
        className="rounded-[10px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-0.5">
          <button
            type="button"
            className="min-w-0 truncate rounded-sm text-left text-sm font-semibold leading-tight hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate();
            }}
          >
            {project.name}
          </button>
          <ProjectQuickActions {...props} compact />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">Updated {timeAgo(project.updatedAt)}</span>
          {project.description ? (
            <span
              dir={description.dir}
              className={cn('hidden truncate sm:inline', description.className)}
            >
              {project.description}
            </span>
          ) : null}
        </div>
      </div>
      <div className="hidden shrink-0 md:block">
        <AgentBadge project={project} />
      </div>
      <RunButton project={project} onRun={props.onRun} iconOnly />
      <ProjectSecondaryActions {...props} />
    </div>
  );
}

interface SecondaryAction {
  key: string;
  label: string;
  icon: typeof GitBranch;
  onSelect: () => void;
}

/**
 * Git, Review and Prompt share one pill: it keeps Run as the only button with
 * real weight, and stops four side-by-side buttons from wrapping onto a second
 * row in narrow cards.
 */
function ProjectSecondaryActions({
  onOpenGit,
  onReview,
  onBuildPrompt,
  className,
}: ProjectItemProps & { className?: string }): React.JSX.Element {
  const actions: SecondaryAction[] = [
    { key: 'git', label: 'Open the Git section', icon: GitBranch, onSelect: onOpenGit },
    { key: 'review', label: 'Review with diffray', icon: GitPullRequest, onSelect: onReview },
    {
      key: 'prompt',
      label: 'Build a prompt for this project',
      icon: Sparkles,
      onSelect: onBuildPrompt,
    },
  ];

  return (
    <div
      className={cn(
        'search-pill flex h-8 shrink-0 items-center gap-px rounded-full p-0.5',
        className,
      )}
    >
      {actions.map(({ key, label, icon: Icon, onSelect }) => (
        <SimpleTooltip key={key} label={label}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      ))}
    </div>
  );
}

function ProjectQuickActions({
  project,
  draggable,
  onTogglePin,
  onToggleArchive,
  motion,
  compact,
}: ProjectItemProps & { compact: boolean }): React.JSX.Element {
  // Hidden until the card is hovered or focused, so a grid of cards stays quiet.
  const reveal = compact
    ? 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
    : undefined;

  const grip = (
    <DragGrip
      disabled={!draggable}
      onPointerDown={motion.onGripPointerDown}
      className={cn('h-7 w-7', reveal)}
    />
  );

  const pin = (
    <SimpleTooltip label={project.pinned ? 'Unpin project' : 'Pin to top'}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={project.pinned ? 'Unpin project' : 'Pin to top'}
        aria-pressed={project.pinned}
        className={cn(reveal, project.pinned && 'text-primary opacity-100 hover:text-primary')}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        <Pin className="h-3.5 w-3.5" />
      </Button>
    </SimpleTooltip>
  );

  const archiveLabel = project.archived ? 'Restore project' : 'Archive project';
  const ArchiveIcon = project.archived ? ArchiveRestore : Archive;
  const archive = (
    <SimpleTooltip label={archiveLabel}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={archiveLabel}
        className={cn(reveal, project.archived && 'opacity-100')}
        onClick={(e) => {
          e.stopPropagation();
          onToggleArchive();
        }}
      >
        <ArchiveIcon className="h-3.5 w-3.5" />
      </Button>
    </SimpleTooltip>
  );

  // An archived project has no order to drag and no pin to toggle, so it only
  // carries the way back out.
  return (
    <div className="-mr-1 -mt-0.5 flex shrink-0 items-center">
      {project.archived ? null : grip}
      {project.archived ? null : pin}
      {archive}
    </div>
  );
}

function RunButton({
  project,
  onRun,
  iconOnly = false,
}: {
  project: Project;
  onRun: () => void;
  iconOnly?: boolean;
}): React.JSX.Element {
  const commands = configuredRunCommands(project);
  const label =
    commands.length === 0
      ? 'No run command yet. Click to create one with AI.'
      : commands.length === 1
        ? projectRunCommandHint(commands[0])
        : 'Choose which command to run';
  return (
    <SimpleTooltip label={label}>
      <Button
        size={iconOnly ? 'icon' : undefined}
        variant={iconOnly ? 'soft' : 'default'}
        aria-label={iconOnly ? 'Run' : undefined}
        className={cn('shrink-0', iconOnly && 'hover:text-primary')}
        onClick={(e) => {
          e.stopPropagation();
          onRun();
        }}
      >
        <Run className={iconOnly ? 'h-3.5 w-3.5' : undefined} />
        {iconOnly ? null : 'Run'}
      </Button>
    </SimpleTooltip>
  );
}

/** A tag on a card: a small neutral chip, so the agent chip next to it stays the one with weight. */
function TagChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 max-w-[10rem] items-center truncate rounded-full bg-foreground/[0.05] px-2.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function AgentBadge({ project }: { project: Project }): React.JSX.Element {
  const cliId = AGENT_TYPE_CLI_ID[project.agentType];
  const label = AGENT_TYPE_LABELS[project.agentType];
  const chip =
    'inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/[0.07] px-2.5 text-[11px] font-medium text-foreground/85';

  if (!cliId) {
    return <span className={chip}>{label}</span>;
  }

  return (
    <SimpleTooltip label={`Open ${label} in the terminal`}>
      <button
        type="button"
        className={cn(
          chip,
          'cursor-pointer transition-colors hover:bg-primary/12 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        onClick={(e) => {
          e.stopPropagation();
          openCliInTerminal({
            cliId,
            cwd: project.folderPath,
            projectId: project.id,
          });
        }}
      >
        <CliLogo cliId={cliId} className="h-3 w-3" />
        {label}
      </button>
    </SimpleTooltip>
  );
}

/** The folder (and site and repo, when set) under a card's name, muted like a path. */
function ProjectMetaLinks({
  project,
  className,
}: {
  project: Project;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 items-center gap-0.5', className)}>
      <SimpleTooltip label={`Open folder: ${project.folderPath}`}>
        <button
          type="button"
          className="-ml-1 flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation();
            void window.agentmat.shell.openPath(project.folderPath);
          }}
        >
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate">{folderBasename(project.folderPath)}</span>
        </button>
      </SimpleTooltip>
      {project.websiteUrl ? (
        <SimpleTooltip label={`Open ${stripUrl(project.websiteUrl)}`}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Open ${stripUrl(project.websiteUrl)}`}
            onClick={(e) => {
              e.stopPropagation();
              void window.agentmat.shell.openExternal(project.websiteUrl);
            }}
          >
            <Globe />
          </Button>
        </SimpleTooltip>
      ) : null}
      {project.repoUrl ? (
        <SimpleTooltip label={`Open ${stripUrl(project.repoUrl)}`}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Open ${stripUrl(project.repoUrl)}`}
            onClick={(e) => {
              e.stopPropagation();
              void window.agentmat.shell.openExternal(project.repoUrl);
            }}
          >
            <GitBranch />
          </Button>
        </SimpleTooltip>
      ) : null}
    </div>
  );
}
