import type { Project, ProjectWordPressItemKind, WpItem, WpItemRef } from '@runova/core';
import { wpItemKey } from '@runova/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Blocks,
  Bolt,
  CloudDownload,
  EllipsisVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  Link,
  LinkOff,
  RefreshCw,
  Search,
  Sparkles,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip, EmptyState } from '@/components/pageKit';
import { LinkWordPressDialog } from '@/components/projects/wordpress/LinkWordPressDialog';
import { NewWordPressProjectDialog } from '@/components/projects/wordpress/NewWordPressProjectDialog';
import { siteHost } from '@/components/projects/wordpress/SitePicker';
import { useUnlinkWordPressProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { PullFlowDialog } from '@/components/wordpress/PullFlowDialog';
import { cn } from '@/lib/utils';
import { DeployCard, Notice } from '../deployKit';
import { ProjectChoiceList } from './AddToProjectDialog';
import { siteProjects, useProjects, useSiteItems, useWordPressSites } from './hooks';
import { type ProjectChoices, projectChoicesForSite } from './itemProjects';

/** More projects than this to pick from and the picker offers a search. */
const SEARCH_AFTER = 6;

const KIND_ICON: Record<ProjectWordPressItemKind, typeof Blocks> = {
  theme: Sparkles,
  plugin: Blocks,
  'mu-plugin': Bolt,
};

const KIND_LABEL: Record<ProjectWordPressItemKind, string> = {
  theme: 'Theme',
  plugin: 'Plugin',
  'mu-plugin': 'Must-use plugin',
};

const NOT_ON_SITE =
  "The site doesn't have this any more. It may have been deleted or renamed in wp-admin.";

const PROJECTS_FAILED = 'Your projects did not load, so the ones on this site are missing.';

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** What a project syncs, named the way the site names it once the site's items are in. */
function ItemChips({
  project,
  siteItems,
}: {
  project: Project;
  /** The site's items by key, or null while they load or when they could not be read. */
  siteItems: Map<string, WpItem> | null;
}): React.JSX.Element | null {
  const items = project.wordpress?.items ?? [];
  if (items.length === 0) return null;
  return (
    <ul aria-label={`Themes and plugins in ${project.name}`} className="flex flex-wrap gap-1.5">
      {items.map((item: WpItemRef) => {
        const Icon = KIND_ICON[item.kind];
        const onSite = siteItems?.get(wpItemKey(item));
        const missing = siteItems !== null && onSite === undefined;
        return (
          <li key={wpItemKey(item)} className="min-w-0 max-w-full">
            {missing ? (
              <SimpleTooltip label={NOT_ON_SITE}>
                <Chip
                  tone="warning"
                  tabIndex={0}
                  className="max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TriangleAlert aria-hidden />
                  <span className="truncate font-mono">{item.slug}</span>
                  <span className="font-normal">not on the site</span>
                </Chip>
              </SimpleTooltip>
            ) : (
              <Chip className="max-w-full">
                <Icon aria-hidden />
                <span className="sr-only">{KIND_LABEL[item.kind]}: </span>
                <span className={onSite ? 'truncate' : 'truncate font-mono'}>
                  {onSite?.name ?? item.slug}
                </span>
              </Chip>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectRow({
  project,
  siteItems,
  unlinking,
  onOpen,
  onPull,
  onUnlink,
}: {
  project: Project;
  siteItems: Map<string, WpItem> | null;
  unlinking: boolean;
  onOpen: () => void;
  onPull: () => void;
  onUnlink: () => void;
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-64 space-y-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
          <SimpleTooltip label={project.folderPath}>
            <p className="truncate font-mono text-xs text-muted-foreground">{project.folderPath}</p>
          </SimpleTooltip>
        </div>
        <ItemChips project={project} siteItems={siteItems} />
        {unlinking && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-primary">
            <Spinner className="h-3 w-3 motion-safe:animate-spin" />
            Unlinking
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="soft" aria-label={`Open ${project.name}`} onClick={onOpen}>
          <FolderOpen /> Open
        </Button>
        <Button
          size="sm"
          variant="soft"
          disabled={unlinking}
          aria-label={`Pull into ${project.name}`}
          onClick={onPull}
        >
          <CloudDownload /> Pull
        </Button>
        <DropdownMenu>
          <SimpleTooltip label="More actions">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={unlinking}
                aria-label={`More actions for ${project.name}`}
              >
                {unlinking ? (
                  <Spinner className="motion-safe:animate-spin" />
                ) : (
                  <EllipsisVertical />
                )}
              </Button>
            </DropdownMenuTrigger>
          </SimpleTooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem tone="danger" onSelect={onUnlink}>
              <LinkOff /> Unlink from this site
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

type PickerFilter = 'wordpress' | 'all';

const FILTER_OPTIONS: { value: PickerFilter; label: string }[] = [
  { value: 'wordpress', label: 'WordPress projects' },
  { value: 'all', label: 'All projects' },
];

function FilterToggle({
  value,
  onChange,
}: {
  value: PickerFilter;
  onChange: (value: PickerFilter) => void;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Show"
      className="inline-flex shrink-0 rounded-lg border border-border bg-background/60 p-0.5"
    >
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === option.value
              ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Picks a project to link to this site. WordPress projects come first: the ones linked to another
 * site (or to one that was disconnected), which move here, and plain projects at this site's
 * address. "All projects" adds every other plain project. The ones already on this site are in
 * the panel, so they aren't offered again.
 */
function LinkProjectPicker({
  open,
  onOpenChange,
  site,
  onNext,
  onNewProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: DeployWordPressSite;
  onNext: (project: Project) => void;
  onNewProject: () => void;
}): React.JSX.Element {
  const projectsQuery = useProjects();
  const sitesQuery = useWordPressSites();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PickerFilter>('wordpress');

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setQuery('');
    setFilter('wordpress');
  }, [open]);

  const all = useMemo(
    () => projectChoicesForSite(projectsQuery.data ?? [], site.id),
    [projectsQuery.data, site.id],
  );
  const sameAddress = useMemo(() => {
    const host = siteHost(site.siteUrl).toLowerCase();
    return all.unlinked.filter(
      (project) => project.websiteUrl && siteHost(project.websiteUrl).toLowerCase() === host,
    );
  }, [all, site.siteUrl]);
  const wordpressCount = all.otherSite.length + sameAddress.length;
  // The toggle only shows when each side has something the other doesn't.
  const showFilter = wordpressCount > 0 && all.unlinked.length > sameAddress.length;
  const shown: PickerFilter = wordpressCount === 0 ? 'all' : filter;
  const choices: ProjectChoices = {
    siteProjects: [],
    unlinked: shown === 'all' ? all.unlinked : sameAddress,
    otherSite: all.otherSite,
    holding: [],
  };
  const visible = [...choices.otherSite.map((choice) => choice.project), ...choices.unlinked];
  const picked = visible.find((project) => project.id === selectedId) ?? null;
  const none = projectsQuery.isSuccess && all.otherSite.length + all.unlinked.length === 0;

  const pickedFrom = picked?.wordpress
    ? (sitesQuery.data?.find((candidate) => candidate.id === picked.wordpress?.siteId)?.label ??
      (sitesQuery.data ? 'a disconnected site' : 'another site'))
    : null;

  let body: React.ReactNode;
  if (projectsQuery.isError) {
    body = (
      <Notice tone="warning" icon={TriangleAlert}>
        {PROJECTS_FAILED}
      </Notice>
    );
  } else if (none) {
    body = (
      <p className="rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
        Every project already works on this site. Make a new one instead.
      </p>
    );
  } else {
    body = (
      <>
        {showFilter || visible.length > SEARCH_AFTER ? (
          <div className="flex flex-wrap items-center gap-2">
            {showFilter ? <FilterToggle value={shown} onChange={setFilter} /> : null}
            {visible.length > SEARCH_AFTER ? (
              <div className="relative min-w-40 flex-1">
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
          </div>
        ) : null}
        <ProjectChoiceList
          choices={choices}
          sites={sitesQuery.data}
          selectedId={selectedId}
          onSelect={(project) => setSelectedId(project.id)}
          loading={projectsQuery.isPending}
          show={['otherSite', 'unlinked']}
          query={query}
          label="Projects to link"
          relink
        />
        {picked && pickedFrom ? (
          <p role="note" className="px-1 text-xs text-muted-foreground">
            {picked.name} stops syncing with {pickedFrom} and syncs with {site.label} instead. Its
            files stay where they are.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Link an existing project</DialogTitle>
          <DialogDescription>
            Pick a project to work on {site.label}. Next you choose which of the site's themes and
            plugins it syncs. Its files stay where they are.
          </DialogDescription>
        </DialogHeader>
        <OverflowScroll fill>
          <div className="space-y-3">{body}</div>
        </OverflowScroll>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {none ? (
            <Button onClick={onNewProject}>
              <FolderPlus className="h-4 w-4" /> New project
            </Button>
          ) : (
            <Button disabled={!picked} onClick={() => picked && onNext(picked)}>
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every project on this computer that works on this site, with what each one syncs and the ways
 * to open it, pull into it or unlink it. New projects start here too, already pointed at the site,
 * and a project that isn't linked anywhere can be linked from here.
 */
export function SiteProjectsPanel({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const navigate = useNavigate();
  const projectsQuery = useProjects();
  const itemsQuery = useSiteItems(site.id);
  const { unlink, unlinking } = useUnlinkWordPressProject();

  const [newOpen, setNewOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Project | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pullProjectId, setPullProjectId] = useState<string | null>(null);
  const [pullOpen, setPullOpen] = useState(false);
  const [unlinkId, setUnlinkId] = useState<string | null>(null);

  const linked = useMemo(
    () => siteProjects(projectsQuery.data, site.id).sort(byName),
    [projectsQuery.data, site.id],
  );
  const siteItems = useMemo(
    () =>
      itemsQuery.isSuccess ? new Map(itemsQuery.data.map((item) => [wpItemKey(item), item])) : null,
    [itemsQuery.isSuccess, itemsQuery.data],
  );
  const empty = projectsQuery.isSuccess && linked.length === 0;

  const openProject = (projectId: string) => navigate(`/projects/${projectId}?tab=wordpress`);

  function startNew(): void {
    setPickerOpen(false);
    setNewOpen(true);
  }

  function next(project: Project): void {
    setLinkTarget(project);
    setLinkOpen(true);
    setPickerOpen(false);
  }

  function pull(projectId: string): void {
    setPullProjectId(projectId);
    setPullOpen(true);
  }

  async function unlinkProject(project: Project): Promise<void> {
    setUnlinkId(project.id);
    try {
      await unlink(project);
    } finally {
      setUnlinkId(null);
    }
  }

  const buttons = (
    <>
      <Button size="sm" onClick={startNew}>
        <FolderPlus /> New project
      </Button>
      <Button size="sm" variant="soft" onClick={() => setPickerOpen(true)}>
        <Link /> Link an existing project
      </Button>
    </>
  );

  let body: React.ReactNode;
  if (projectsQuery.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  } else if (projectsQuery.isError) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <div className="w-full">
          <Notice tone="warning" icon={TriangleAlert}>
            {PROJECTS_FAILED}
          </Notice>
        </div>
        <Button
          size="sm"
          variant="soft"
          disabled={projectsQuery.isFetching}
          onClick={() => void projectsQuery.refetch()}
        >
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  } else if (empty) {
    body = (
      <EmptyState
        size="sm"
        icon={Folder}
        title="No projects on this site yet"
        description="No project on this computer works on this site yet. Start a new one from its themes and plugins, or link a project you already have."
        action={<div className="flex flex-wrap justify-center gap-2">{buttons}</div>}
      />
    );
  } else {
    body = (
      <ul aria-label="Projects on this site" className="settings-rows">
        {linked.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            siteItems={siteItems}
            unlinking={unlinking && unlinkId === project.id}
            onOpen={() => openProject(project.id)}
            onPull={() => pull(project.id)}
            onUnlink={() => void unlinkProject(project)}
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      <DeployCard
        icon={<Folder />}
        title="Projects"
        extra={
          projectsQuery.isSuccess ? (
            <Chip className="tabular-nums">{linked.length}</Chip>
          ) : undefined
        }
        description="Projects on this computer that pull from and deploy to this site."
        actions={empty ? undefined : buttons}
      >
        {body}
      </DeployCard>
      <NewWordPressProjectDialog open={newOpen} onOpenChange={setNewOpen} initialSiteId={site.id} />
      <LinkProjectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        site={site}
        onNext={next}
        onNewProject={startNew}
      />
      {linkTarget && (
        <LinkWordPressDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          project={linkTarget}
          initialSiteId={site.id}
          onLinked={() => openProject(linkTarget.id)}
        />
      )}
      {pullProjectId && (
        <PullFlowDialog
          open={pullOpen}
          onOpenChange={setPullOpen}
          projectId={pullProjectId}
          siteId={site.id}
        />
      )}
    </>
  );
}
