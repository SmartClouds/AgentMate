import type { Project, ProjectWordPressItemKind, WpItem, WpItemRef } from '@agentmat/core';
import { wpItemRoot } from '@agentmat/core';
import type { DeployWordPressSite, DeployWordPressSiteInfo } from '@shared/deployWordPressTypes';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight,
  Blocks,
  Bolt,
  CloudDownload,
  CloudUpload,
  EllipsisVertical,
  ExternalLink,
  FolderPlus,
  LinkOff,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  Spinner,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { NewWordPressProjectDialog } from '@/components/projects/wordpress/NewWordPressProjectDialog';
import { useUnlinkWordPressProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
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
import { DeployFlowDialog } from '@/components/wordpress/DeployFlowDialog';
import { PullFlowDialog } from '@/components/wordpress/PullFlowDialog';
import { confirmDialog } from '@/stores/confirmStore';
import { DeployCard, Notice } from '../deployKit';
import { SetupFailure } from '../SetupFailure';
import { AddToProjectDialog } from './AddToProjectDialog';
import { siteProjects, useProjects, useSiteInfo, useSiteItems } from './hooks';
import { fileChangesStatus, SCOPE_SUMMARY, wpProblem } from './messages';
import { useItemProjectActions } from './useItemProjectActions';

const GROUPS: ReadonlyArray<{ kind: ProjectWordPressItemKind; title: string; empty: string }> = [
  { kind: 'theme', title: 'Themes', empty: 'No themes on this site.' },
  { kind: 'plugin', title: 'Plugins', empty: 'No plugins on this site.' },
  {
    kind: 'mu-plugin',
    title: 'Must-use plugins',
    empty: 'No must-use plugins on this site.',
  },
];

const PROTECTED = "That's the AgentMate Connector itself, which is never pulled or deployed.";

/** Why deploying this item is off right now, or null when it can go ahead. */
export function deployBlockedReason(
  site: Pick<DeployWordPressSite, 'scope'>,
  info: DeployWordPressSiteInfo | undefined,
  item: Pick<WpItem, 'protected' | 'writable'>,
): string | null {
  if (site.scope === 'read') return SCOPE_SUMMARY.read;
  if (info) {
    const status = fileChangesStatus(info, site);
    if (!status.allowed) return status.text;
  }
  if (item.protected) return PROTECTED;
  if (!item.writable) {
    return "PHP can't write to this folder on the site, so it can't be deployed. Check the folder's permissions on the host.";
  }
  return null;
}

function linksItem(project: Project, item: WpItemRef): boolean {
  return (
    project.wordpress?.items.some((one) => one.kind === item.kind && one.slug === item.slug) ??
    false
  );
}

type FlowTarget = { kind: 'deploy' | 'pull'; projectId: string; item: WpItemRef };

/** The project dialog open for an item: add it to one, move it, or make a new one with it. */
type ItemDialog = { kind: 'add' | 'move' | 'new'; item: WpItem; from?: Project };

const KIND_NOUN: Record<ProjectWordPressItemKind, string> = {
  theme: 'theme',
  plugin: 'plugin',
  'mu-plugin': 'must-use plugin',
};

/** What the rows can do to the projects that hold an item. */
interface ItemProjectHandlers {
  onOpenFlow: (target: FlowTarget) => void;
  onDialog: (dialog: ItemDialog) => void;
  onOpenProject: (project: Project) => void;
  onRemove: (project: Project, item: WpItem) => void;
  onUnlink: (project: Project) => void;
  /** True while a change to this project's items is running, so its menu waits. */
  isChanging: (project: Project) => boolean;
  /** True while any change is running, so a second one can't start alongside it. */
  changing: boolean;
}

function ProjectMenu({
  item,
  project,
  handlers,
}: {
  item: WpItem;
  project: Project;
  handlers: ItemProjectHandlers;
}): React.JSX.Element {
  const busy = handlers.isChanging(project);
  const lastItem = (project.wordpress?.items.length ?? 0) <= 1;
  return (
    <DropdownMenu>
      <SimpleTooltip label="More">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More for ${item.name} in ${project.name}`}
            disabled={busy}
          >
            {busy ? <Spinner className="motion-safe:animate-spin" /> : <EllipsisVertical />}
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => handlers.onOpenProject(project)}>
          <ExternalLink /> Open project
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={handlers.changing}
          onSelect={() => handlers.onDialog({ kind: 'move', item, from: project })}
        >
          <ArrowRight /> Move to another project…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {lastItem ? (
          <DropdownMenuItem
            tone="danger"
            disabled={handlers.changing}
            onSelect={() => handlers.onUnlink(project)}
          >
            <LinkOff /> Unlink {project.name} from this site
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            tone="danger"
            disabled={handlers.changing}
            onSelect={() => handlers.onRemove(project, item)}
          >
            <X /> Remove from this project
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  projects,
  deployBlocked,
  handlers,
}: {
  item: WpItem;
  projects: Project[];
  deployBlocked: string | null;
  handlers: ItemProjectHandlers;
}): React.JSX.Element {
  const ref: WpItemRef = { kind: item.kind, slug: item.slug };
  return (
    <li className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium text-foreground">{item.name}</span>
          {item.active && (
            <Chip tone="success" dot>
              Active
            </Chip>
          )}
          {item.networkActive && (
            <Chip tone="success" dot>
              Network active
            </Chip>
          )}
          {item.protected && <Chip>Connector</Chip>}
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {item.slug}
          {item.version ? <span className="font-sans"> · version {item.version}</span> : null}
        </p>
        {item.parentTheme && (
          <p className="text-xs text-muted-foreground">
            A child theme of <span className="font-mono">{item.parentTheme}</span>
          </p>
        )}
      </div>
      <div className="min-w-0">
        {item.protected ? (
          <p className="text-xs text-muted-foreground">{PROTECTED}</p>
        ) : projects.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Not in a project yet.</span>
            <Button
              size="sm"
              variant="soft"
              onClick={() => handlers.onDialog({ kind: 'add', item })}
            >
              <Plus /> Add to a project
            </Button>
            <SimpleTooltip label={`New project with this ${KIND_NOUN[item.kind]}`}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`New project with ${item.name}`}
                onClick={() => handlers.onDialog({ kind: 'new', item })}
              >
                <FolderPlus />
              </Button>
            </SimpleTooltip>
          </div>
        ) : (
          <div className="space-y-1.5">
            <ul aria-label={`Projects with ${item.name}`} className="space-y-2">
              {projects.map((project) => (
                <li key={project.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {project.name}
                  </span>
                  <Button
                    size="sm"
                    variant="soft"
                    aria-label={`Pull ${item.name} into ${project.name}`}
                    onClick={() =>
                      handlers.onOpenFlow({ kind: 'pull', projectId: project.id, item: ref })
                    }
                  >
                    <CloudDownload /> Pull
                  </Button>
                  <SimpleTooltip label={deployBlocked} wrapTrigger>
                    <Button
                      size="sm"
                      disabled={deployBlocked !== null}
                      aria-label={`Review and deploy ${item.name} from ${project.name}`}
                      onClick={() =>
                        handlers.onOpenFlow({ kind: 'deploy', projectId: project.id, item: ref })
                      }
                    >
                      <CloudUpload /> Review and deploy
                    </Button>
                  </SimpleTooltip>
                  <ProjectMenu item={item} project={project} handlers={handlers} />
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 text-muted-foreground"
              onClick={() => handlers.onDialog({ kind: 'add', item })}
            >
              <Plus /> Add to another project
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The site's themes, plugins and mu-plugins: which are active, which projects on this computer
 * hold a copy, and from there a pull or a reviewed deploy. Each item can also go into a project
 * (an existing one or a new one), move to another, or leave one. Names come from the site, so
 * they are shown as text only.
 */
export function SiteItemsPanel({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const navigate = useNavigate();
  const itemsQuery = useSiteItems(site.id);
  const infoQuery = useSiteInfo(site.id);
  const projectsQuery = useProjects();
  const [target, setTarget] = useState<FlowTarget | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  // Kept after closing so the dialog can animate out; the key mounts a fresh one per open.
  const [dialog, setDialog] = useState<(ItemDialog & { key: number }) | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const itemActions = useItemProjectActions(site.id);
  const unlinker = useUnlinkWordPressProject();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const info = infoQuery.data;
  const linked = siteProjects(projectsQuery.data, site.id);
  const siteBlock =
    site.scope === 'read'
      ? SCOPE_SUMMARY.read
      : info && !fileChangesStatus(info, site).allowed
        ? fileChangesStatus(info, site).text
        : null;

  function open(next: FlowTarget): void {
    setTarget(next);
    setFlowOpen(true);
  }

  function openDialog(next: ItemDialog): void {
    setDialog((current) => ({ ...next, key: (current?.key ?? 0) + 1 }));
    setDialogOpen(true);
  }

  async function removeFrom(project: Project, item: WpItem): Promise<void> {
    const ok = await confirmDialog({
      title: `Stop syncing ${item.slug} in ${project.name}?`,
      description: `Its files stay in ${wpItemRoot(item)}, but they won't be pulled or deployed any more.`,
      confirmLabel: 'Stop syncing',
    });
    if (!ok) return;
    setRemovingId(project.id);
    try {
      const outcome = await itemActions.remove(project, { kind: item.kind, slug: item.slug });
      if (outcome.ok) toast.success(`${item.name} is no longer synced in ${project.name}.`);
      else toast.error(outcome.error ?? `Couldn't take ${item.slug} out of ${project.name}.`);
    } finally {
      // No timeline here, so a failed run is not kept for one.
      itemActions.reset();
      setRemovingId(null);
    }
  }

  async function unlink(project: Project): Promise<void> {
    setUnlinkingId(project.id);
    try {
      await unlinker.unlink(project);
    } finally {
      setUnlinkingId(null);
    }
  }

  const handlers: ItemProjectHandlers = {
    onOpenFlow: open,
    onDialog: openDialog,
    onOpenProject: (project) => navigate(`/projects/${project.id}?tab=wordpress`),
    onRemove: (project, item) => void removeFrom(project, item),
    onUnlink: (project) => void unlink(project),
    isChanging: (project) =>
      project.id === removingId || (unlinker.unlinking && project.id === unlinkingId),
    changing: removingId !== null || unlinker.unlinking,
  };

  return (
    <div className="flex flex-col gap-2">
      {siteBlock && (
        <Notice role="note" icon={Lock}>
          {siteBlock}
        </Notice>
      )}
      {itemsQuery.isError && (
        <div className="flex flex-col items-start gap-2">
          <div className="w-full">
            <SetupFailure message={wpProblem(itemsQuery.error)} />
          </div>
          <Button
            size="sm"
            variant="soft"
            disabled={itemsQuery.isFetching}
            onClick={() => void itemsQuery.refetch()}
          >
            <RefreshCw /> Try again
          </Button>
        </div>
      )}
      {projectsQuery.isError && (
        <Notice tone="warning" icon={TriangleAlert}>
          Your projects did not load, so the links to them are missing.
        </Notice>
      )}
      {!itemsQuery.isError &&
        GROUPS.map((group) => {
          const items = (itemsQuery.data ?? []).filter((item) => item.kind === group.kind);
          return (
            <DeployCard
              key={group.kind}
              icon={
                group.kind === 'theme' ? (
                  <Sparkles />
                ) : group.kind === 'mu-plugin' ? (
                  <Bolt />
                ) : (
                  <Blocks />
                )
              }
              title={group.title}
              extra={
                itemsQuery.isPending ? undefined : (
                  <Chip className="tabular-nums">{items.length}</Chip>
                )
              }
              description={
                group.kind === 'mu-plugin'
                  ? "Loaded on every request and can't be switched off in wp-admin."
                  : undefined
              }
            >
              {itemsQuery.isPending ? (
                <div className="space-y-2" aria-busy="true">
                  {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-10 w-full rounded-lg" />
                  ))}
                </div>
              ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{group.empty}</p>
              ) : (
                <ul aria-label={group.title} className="settings-rows">
                  {items.map((item) => (
                    <ItemRow
                      key={`${item.kind}/${item.slug}`}
                      item={item}
                      projects={linked.filter((project) => linksItem(project, item))}
                      deployBlocked={deployBlockedReason(site, info, item)}
                      handlers={handlers}
                    />
                  ))}
                </ul>
              )}
            </DeployCard>
          );
        })}
      {target?.kind === 'deploy' && (
        <DeployFlowDialog
          open={flowOpen}
          onOpenChange={setFlowOpen}
          projectId={target.projectId}
          siteId={site.id}
          items={[target.item]}
        />
      )}
      {target?.kind === 'pull' && (
        <PullFlowDialog
          open={flowOpen}
          onOpenChange={setFlowOpen}
          projectId={target.projectId}
          siteId={site.id}
          items={[target.item]}
        />
      )}
      {(dialog?.kind === 'add' || dialog?.kind === 'move') && (
        <AddToProjectDialog
          key={dialog.key}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          site={site}
          item={dialog.item}
          mode={dialog.kind}
          from={dialog.from}
          onNewProject={() => openDialog({ kind: 'new', item: dialog.item })}
        />
      )}
      {dialog?.kind === 'new' && (
        <NewWordPressProjectDialog
          key={dialog.key}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          initialSiteId={site.id}
          initialItems={[{ kind: dialog.item.kind, slug: dialog.item.slug }]}
        />
      )}
    </div>
  );
}
