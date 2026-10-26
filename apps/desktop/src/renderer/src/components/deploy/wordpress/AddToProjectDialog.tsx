import type { Project, WpItem } from '@runova/core';
import { wpItemRoot } from '@runova/core';
import type {
  DeployWordPressOperationKind,
  DeployWordPressSite,
} from '@shared/deployWordPressTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, CircleCheck, FolderPlus, Plus, Search, Spinner } from '@/components/icons';
import { RunError } from '@/components/projects/wordpress/FlowParts';
import { toItemRef } from '@/components/projects/wordpress/ItemPicker';
import { OperationTimeline } from '@/components/projects/wordpress/OperationTimeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  useWordPressOperationStore,
  type WordPressOperationRun,
} from '@/stores/wordpressOperationStore';
import { Notice } from '../deployKit';
import { useProjects, useWordPressSites } from './hooks';
import { type ProjectChoices, projectChoicesFor } from './itemProjects';
import { type ItemProjectOutcome, useItemProjectActions } from './useItemProjectActions';

/**
 * Puts one of a site's themes or plugins into a project from Deploy, or moves it from the project
 * that syncs it to another one. A project linked to a different site can't take it, so it is
 * listed but can't be picked, with the reason in the row.
 */

export type ProjectChoiceGroup = 'siteProjects' | 'unlinked' | 'otherSite';

const ALL_GROUPS: readonly ProjectChoiceGroup[] = ['siteProjects', 'unlinked', 'otherSite'];

/** More projects than this to pick from and the dialog offers a search. */
const SEARCH_AFTER = 6;

const SILENT = { silentLoading: true } as const;

/** Runs that hold the site, so nothing else should change its projects meanwhile. */
const BUSY_REASON: Partial<Record<DeployWordPressOperationKind, string>> = {
  pull: 'A pull from this site is still running. Try again when it ends.',
  deploy: 'A deploy to this site is still running. Try again when it ends.',
  rollback: 'A rollback on this site is still running. Try again when it ends.',
  items: "Another change to this site's projects is still running. Try again when it ends.",
  createProject: 'A new project is still being made from this site. Try again when it ends.',
};

const NOT_PULLED_NOTE =
  ' Its folder already had files, so they were kept as they are. Pull to compare them with the site.';

function itemCount(project: Project): string {
  const count = project.wordpress?.items.length ?? 0;
  return count === 1 ? '1 theme or plugin' : `${count} themes and plugins`;
}

function matches(project: Project, query: string): boolean {
  if (!query) return true;
  return (
    project.name.toLowerCase().includes(query) || project.folderPath.toLowerCase().includes(query)
  );
}

function GroupHeading({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <h3 className="select-none text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        {title}
      </h3>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function ChoiceRow({
  project,
  detail,
  selected,
  disabled,
  focusable,
  onSelect,
}: {
  project: Project;
  detail?: string;
  selected: boolean;
  disabled?: boolean;
  focusable: boolean;
  onSelect: (project: Project) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled ? true : undefined}
        tabIndex={focusable ? 0 : -1}
        data-project-id={project.id}
        onClick={() => {
          if (!disabled) onSelect(project);
        }}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled
            ? 'cursor-not-allowed bg-foreground/[0.02] opacity-60 ring-foreground/[0.05]'
            : selected
              ? 'cursor-pointer bg-primary/10 ring-primary/40'
              : 'cursor-pointer bg-foreground/[0.03] ring-foreground/[0.07] hover:bg-foreground/[0.06]',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{project.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{project.folderPath}</span>
        </span>
        {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail}</span> : null}
        {selected ? <CircleCheck className="h-4 w-4 shrink-0 text-primary" /> : null}
      </button>
    </li>
  );
}

/**
 * The projects a site's item can go into, grouped by what picking them means. Works as a radio
 * group: arrow keys move the choice, and projects linked to another site are passed over.
 */
export function ProjectChoiceList({
  choices,
  sites,
  selectedId,
  onSelect,
  loading,
  show = ALL_GROUPS,
  query = '',
  label = 'Projects',
}: {
  choices: ProjectChoices;
  /** Connected sites, to name the one a project in "Linked to another site" belongs to. */
  sites?: readonly DeployWordPressSite[];
  selectedId: string | null;
  onSelect: (project: Project) => void;
  loading: boolean;
  /** Which groups to list, in this order. All three by default. */
  show?: readonly ProjectChoiceGroup[];
  /** Keeps the projects whose name or folder has this in it, ignoring case. */
  query?: string;
  /** The radio group's accessible name. */
  label?: string;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();

  if (loading) {
    return (
      <div role="status" aria-label="Loading projects" className="space-y-1.5">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    );
  }

  const groups = {
    siteProjects: choices.siteProjects.filter((project) => matches(project, needle)),
    unlinked: choices.unlinked.filter((project) => matches(project, needle)),
    otherSite: choices.otherSite.filter((choice) => matches(choice.project, needle)),
  };
  const shown = show.filter((group) => groups[group].length > 0);
  const pickable = shown
    .filter((group) => group !== 'otherSite')
    .flatMap((group) => groups[group as 'siteProjects' | 'unlinked']);
  // Roving focus: the picked project takes Tab, or the first one when none is picked yet.
  const focusId = pickable.some((project) => project.id === selectedId)
    ? selectedId
    : (pickable[0]?.id ?? null);

  if (shown.length === 0) {
    return (
      <p className="rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
        {needle ? `No projects match "${query.trim()}".` : 'No projects to pick from yet.'}
      </p>
    );
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0 || pickable.length === 0) return;
    event.preventDefault();
    const current = pickable.findIndex(
      (project) => project.id === (document.activeElement as HTMLElement | null)?.dataset.projectId,
    );
    const next = pickable[(current + step + pickable.length) % pickable.length];
    onSelect(next);
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-project-id]') ?? [];
    for (const row of rows) {
      if (row.dataset.projectId === next.id) row.focus();
    }
  }

  function siteName(siteId: string): string {
    return sites?.find((site) => site.id === siteId)?.label ?? 'another site';
  }

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      className="space-y-4"
      onKeyDown={onKeyDown}
    >
      {shown.map((group) => (
        <section key={group} className="space-y-1.5">
          {group === 'siteProjects' ? (
            <>
              <GroupHeading title="Projects on this site" />
              <ul className="space-y-1.5">
                {groups.siteProjects.map((project) => (
                  <ChoiceRow
                    key={project.id}
                    project={project}
                    detail={itemCount(project)}
                    selected={project.id === selectedId}
                    focusable={project.id === focusId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </>
          ) : group === 'unlinked' ? (
            <>
              <GroupHeading title="Other projects" hint="Gets linked to this site" />
              <ul className="space-y-1.5">
                {groups.unlinked.map((project) => (
                  <ChoiceRow
                    key={project.id}
                    project={project}
                    selected={project.id === selectedId}
                    focusable={project.id === focusId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </>
          ) : (
            <>
              <GroupHeading title="Linked to another site" />
              <ul className="space-y-1.5">
                {groups.otherSite.map(({ project, siteId }) => (
                  <ChoiceRow
                    key={project.id}
                    project={project}
                    detail={`Linked to ${siteName(siteId)}`}
                    selected={false}
                    disabled
                    focusable={false}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

/** A run that holds this site right now, other than the dialog's own. */
function blockingRun(
  runs: Record<string, WordPressOperationRun>,
  siteId: string,
  ownId: string | null,
): WordPressOperationRun | null {
  let found: WordPressOperationRun | null = null;
  for (const run of Object.values(runs)) {
    if (run.status !== 'running' || run.siteId !== siteId || run.operationId === ownId) continue;
    if (!BUSY_REASON[run.kind]) continue;
    if (!found || run.startedAt >= found.startedAt) found = run;
  }
  return found;
}

export interface AddToProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: DeployWordPressSite;
  item: WpItem;
  mode: 'add' | 'move';
  /** The project that syncs the item now. Needed for a move. */
  from?: Project;
  /** Opens the new project flow for this site and item. The caller closes this dialog. */
  onNewProject: () => void;
}

export function AddToProjectDialog({
  open,
  onOpenChange,
  site,
  item,
  mode,
  from,
  onNewProject,
}: AddToProjectDialogProps): React.JSX.Element {
  const projectsQuery = useProjects();
  const sitesQuery = useWordPressSites();
  const actions = useItemProjectActions(site.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [failure, setFailure] = useState<ItemProjectOutcome | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const moving = mode === 'move' && from !== undefined;
  const run = useWordPressOperationStore((state) =>
    actions.operationId ? (state.runs[actions.operationId] ?? null) : null,
  );
  const blocking = useWordPressOperationStore((state) =>
    blockingRun(state.runs, site.id, actions.operationId),
  );

  const changesQuery = useQuery({
    queryKey: queryKeys.projectWordPressChanges(from?.id ?? ''),
    queryFn: () => window.runova.deployWordPress.localChanges(from?.id as string),
    enabled: open && moving,
    meta: SILENT,
  });

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setQuery('');
    setFailure(null);
  }, [open]);

  const ref = toItemRef(item);
  const choices = projectChoicesFor(
    (projectsQuery.data ?? []).filter((project) => project.id !== from?.id),
    site.id,
    ref,
  );
  const pickable = [...choices.siteProjects, ...choices.unlinked];
  const target = pickable.find((project) => project.id === selectedId) ?? null;
  const targetUnlinked = target !== null && target.wordpress === undefined;

  const fromItems = from?.wordpress?.items.length ?? 0;
  const lastItem = moving && fromItems <= 1;
  const changes = moving ? changesQuery.data : undefined;
  const changeTotal = changes ? changes.added + changes.modified + changes.deleted : 0;

  const running = actions.busy;
  const busyReason = !running && blocking ? (BUSY_REASON[blocking.kind] ?? null) : null;
  const showProgress = running || failure !== null;

  async function submit(): Promise<void> {
    if (!target) return;
    setFailure(null);
    const outcome =
      moving && from ? await actions.move(from, target, ref) : await actions.add(target, ref);
    if (outcome.ok) {
      const done = `${moving ? 'Moved' : 'Added'} ${item.name} to ${target.name}.`;
      toast.success(outcome.notPulled?.length ? `${done}${NOT_PULLED_NOTE}` : done);
      onOpenChange(false);
      return;
    }
    if (!openRef.current) {
      // Hidden while it ran, so the reason has nowhere else to show.
      toast.error(outcome.error ?? `Couldn't add ${item.name} to ${target.name}.`);
      actions.reset();
      return;
    }
    setFailure(outcome);
  }

  function close(): void {
    if (!running) {
      actions.reset();
      setFailure(null);
    }
    onOpenChange(false);
  }

  function back(): void {
    actions.reset();
    setFailure(null);
  }

  const toName = target?.name ?? 'The other project';
  const title = moving ? `Move ${item.name} to another project` : `Add ${item.name} to a project`;
  const description = moving
    ? `${toName} gets the site's copy. ${from.name} stops syncing it, and its files stay in ${from.name}'s folder.`
    : "It's pulled from the site into the project's folder.";

  const changesWarning =
    moving && changeTotal > 0
      ? lastItem
        ? `${from.name} has ${changeTotal} changed ${changeTotal === 1 ? "file that isn't" : "files that aren't"} deployed. They stay in ${from.name}'s folder, and ${target?.name ?? 'the other project'} gets the site's copy.`
        : `${from.name} has changes that aren't deployed. Anything changed in ${wpItemRoot(ref)} stays in ${from.name}'s folder, and the other project gets the site's copy.`
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <OverflowScroll fill>
          {showProgress ? (
            <div className="space-y-3">
              {failure ? (
                <RunError
                  message={failure.error ?? `Couldn't add ${item.name}.`}
                  code={run?.errorCode ?? null}
                />
              ) : null}
              {run ? <OperationTimeline run={run} /> : null}
            </div>
          ) : (
            <div className="space-y-3">
              {changesWarning ? (
                <Notice tone="warning" size="sm">
                  {changesWarning}
                </Notice>
              ) : null}
              {lastItem && from ? (
                <Notice size="sm" role="note">
                  {from.name} has no other themes or plugins, so it gets unlinked from this site.
                  Its files stay.
                </Notice>
              ) : null}
              {pickable.length > SEARCH_AFTER ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="Search projects"
                    placeholder="Search projects"
                    className="pl-8"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={onNewProject}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-left ring-1 ring-inset ring-foreground/[0.07] transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">New project for this site</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Starts with {item.name}, pulled into a new folder.
                  </span>
                </span>
              </button>
              <ProjectChoiceList
                choices={choices}
                sites={sitesQuery.data}
                selectedId={selectedId}
                onSelect={(project) => setSelectedId(project.id)}
                loading={projectsQuery.isPending}
                query={query}
              />
              {targetUnlinked ? (
                <p role="note" className="px-1 text-xs text-muted-foreground">
                  {target.name} becomes a WordPress project linked to {site.label}.
                </p>
              ) : null}
              {busyReason ? (
                <p role="status" className="px-1 text-xs text-warning">
                  {busyReason}
                </p>
              ) : null}
            </div>
          )}
        </OverflowScroll>
        <DialogFooter>
          {failure?.partial ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                {running ? 'Hide' : 'Cancel'}
              </Button>
              {failure ? (
                <Button onClick={back}>Back</Button>
              ) : (
                <Button
                  disabled={!target || running || busyReason !== null}
                  onClick={() => void submit()}
                >
                  {running ? (
                    <Spinner className="h-4 w-4 animate-spin" />
                  ) : moving ? (
                    <ArrowRight className="h-4 w-4" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {moving ? 'Move' : 'Add and pull'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
