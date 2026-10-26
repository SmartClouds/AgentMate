import type { Project, WpItem, WpItemRef } from '@runova/core';
import { wpItemKey, wpItemRoot } from '@runova/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { wordPressErrorCode, wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { NewItemDialog } from '@/components/deploy/wordpress/NewItemDialog';
import { useItemProjectActions } from '@/components/deploy/wordpress/useItemProjectActions';
import {
  CloudDownload,
  CloudUpload,
  ExternalLink,
  FilePlus,
  Link as LinkIcon,
  LinkOff,
  Plus,
  RefreshCw,
  Spinner,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ConnectSiteDialog } from '@/components/wordpress/ConnectSiteDialog';
import { DeployFlowDialog } from '@/components/wordpress/DeployFlowDialog';
import { IgnoredFilesPanel } from '@/components/wordpress/IgnoredFilesPanel';
import { PullFlowDialog } from '@/components/wordpress/PullFlowDialog';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { RunError } from './FlowParts';
import { ItemPicker, toItemRef } from './ItemPicker';
import { OperationTimeline } from './OperationTimeline';
import { SitePicker, siteHost } from './SitePicker';
import { replaceProject, useUnlinkWordPressProject } from './useUnlinkWordPressProject';
import { ITEM_KIND_LABEL } from './wordpressCopy';

/**
 * The WordPress section of a project linked to a site (E21): which site and which of its themes
 * and plugins, how far the folder has moved since the last sync, and the ways to pull, deploy or
 * let go of the link. Unlinking keeps every file; only the link goes.
 */

const SILENT = { silentLoading: true } as const;

const CARD = 'glass rounded-[calc(var(--radius)+2px)]';

export const READ_ONLY_HINT =
  "This site's key is read-only, so Runova can pull from it but not deploy. Make a read-write key in wp-admin and connect the site again.";

export function WordPressProjectSection({ project }: { project: Project }): React.JSX.Element {
  const link = project.wordpress;
  const queryClient = useQueryClient();
  const [pullOpen, setPullOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  /** Only these items go into the review; all of them when undefined. */
  const [deployItems, setDeployItems] = useState<WpItemRef[] | undefined>(undefined);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const { unlinking, unlink: unlinkProject } = useUnlinkWordPressProject();
  const itemActions = useItemProjectActions(link?.siteId ?? '');
  const [, setSearchParams] = useSearchParams();

  const sitesQuery = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: () => window.runova.deployWordPress.listSites(),
    meta: SILENT,
  });
  const site = sitesQuery.data?.find((candidate) => candidate.id === link?.siteId) ?? null;
  const siteGone = sitesQuery.isSuccess && link !== undefined && site === null;

  const itemsQuery = useQuery({
    queryKey: queryKeys.deployWordPressItems(link?.siteId ?? ''),
    queryFn: () => window.runova.deployWordPress.listItems(link?.siteId as string),
    enabled: site !== null,
    meta: SILENT,
  });

  const changesKey = queryKeys.projectWordPressChanges(project.id);
  const changesQuery = useQuery({
    queryKey: changesKey,
    queryFn: () => window.runova.deployWordPress.localChanges(project.id),
    enabled: link !== undefined,
    refetchOnWindowFocus: true,
    meta: SILENT,
  });

  // Electron does not fire the visibility change TanStack listens for when the window is
  // switched to, so coming back to the app is caught here.
  useEffect(() => {
    if (!link) return undefined;
    const refresh = (): void => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWordPressChanges(project.id),
      });
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [link, project.id, queryClient]);

  if (!link) {
    return (
      <p className={cn(CARD, 'px-6 py-12 text-center text-sm text-muted-foreground')}>
        This project isn't linked to a WordPress site.
      </p>
    );
  }

  const readOnly = site?.scope === 'read';
  const itemsByKey = new Map<string, WpItem>(
    (itemsQuery.data ?? []).map((item) => [wpItemKey(item), item]),
  );

  function unlink(): void {
    // The section goes with the link, so leave it for the Overview first.
    void unlinkProject(project, () =>
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete('tab');
          return params;
        },
        { replace: true },
      ),
    );
  }

  async function removeItem(item: WpItemRef): Promise<void> {
    if (!link) return;
    const ok = await confirmDialog({
      title: `Stop syncing ${item.slug}?`,
      description: `Its files stay in ${wpItemRoot(item)}, but they won't be pulled or deployed any more.`,
      confirmLabel: 'Stop syncing',
    });
    if (!ok) return;
    const outcome = await itemActions.remove(project, item);
    if (!outcome.ok) {
      // Nothing here shows the run, so it goes once its reason is in the toast.
      itemActions.reset();
      toast.error(outcome.error ?? `Couldn't stop syncing ${item.slug}.`);
    }
  }

  const changes = changesQuery.data;
  const changeTotal = changes ? changes.added + changes.modified + changes.deleted : 0;

  return (
    <div className="space-y-4">
      <section aria-label="Linked site" className={cn(CARD, 'space-y-3 p-4')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05]">
              <WordPressMark className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-0.5">
              {sitesQuery.isPending ? (
                <>
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </>
              ) : site ? (
                <>
                  <p className="truncate text-sm font-semibold">{site.label}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <SimpleTooltip label={`Open ${siteHost(site.siteUrl)}`}>
                      <button
                        type="button"
                        className="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void window.runova.shell.openExternal(site.siteUrl)}
                      >
                        {siteHost(site.siteUrl)} <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    </SimpleTooltip>
                    <span
                      className={cn(
                        'rounded-full px-2 py-px text-[10px] font-medium',
                        readOnly
                          ? 'bg-foreground/[0.07] text-muted-foreground'
                          : 'bg-success/12 text-success',
                      )}
                    >
                      {readOnly ? 'Read only' : 'Read and write'}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm font-semibold">Site not connected</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!site} onClick={() => setPullOpen(true)}>
              <CloudDownload className="h-3.5 w-3.5" /> Pull latest
            </Button>
            <SimpleTooltip label={readOnly ? READ_ONLY_HINT : null} wrapTrigger>
              <Button
                size="sm"
                disabled={!site || readOnly}
                onClick={() => {
                  setDeployItems(undefined);
                  setDeployOpen(true);
                }}
              >
                <CloudUpload className="h-3.5 w-3.5" /> Review and deploy
              </Button>
            </SimpleTooltip>
            <Button variant="ghost" size="sm" disabled={unlinking} onClick={unlink}>
              {unlinking ? (
                <Spinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LinkOff className="h-3.5 w-3.5" />
              )}
              Unlink
            </Button>
          </div>
        </div>

        {siteGone ? (
          <div
            role="alert"
            className="flex flex-wrap items-start gap-2 rounded-lg bg-warning/[0.07] px-3 py-2.5 ring-1 ring-inset ring-warning/25"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                The site this project was linked to isn't connected any more
              </p>
              <p className="text-xs text-muted-foreground">
                Connect it again in Deploy, then link this project to it. Or unlink the project and
                keep the files as they are.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setRelinkOpen(true)}>
              <LinkIcon className="h-3.5 w-3.5" /> Link to a connected site
            </Button>
          </div>
        ) : null}
        {sitesQuery.isError ? (
          <RunError
            message={wordPressErrorMessage(sitesQuery.error)}
            code={wordPressErrorCode(sitesQuery.error)}
          />
        ) : null}
      </section>

      <section aria-label="Local changes" className={cn(CARD, 'space-y-2 p-4')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Changes since the last sync</h3>
          <SimpleTooltip label="Check again">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Check the changes again"
              disabled={changesQuery.isFetching}
              onClick={() => void changesQuery.refetch()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', changesQuery.isFetching && 'animate-spin')} />
            </Button>
          </SimpleTooltip>
        </div>
        {changesQuery.isPending ? (
          <div role="status" aria-label="Counting changes" className="flex gap-2">
            <Skeleton className="h-14 w-24 rounded-lg" />
            <Skeleton className="h-14 w-24 rounded-lg" />
            <Skeleton className="h-14 w-24 rounded-lg" />
          </div>
        ) : changesQuery.isError ? (
          <RunError
            message={wordPressErrorMessage(changesQuery.error)}
            code={wordPressErrorCode(changesQuery.error)}
          />
        ) : changes ? (
          <>
            <div className="flex flex-wrap gap-2">
              <ChangeCount label="Added" value={changes.added} tone="text-success" />
              <ChangeCount label="Modified" value={changes.modified} tone="text-primary" />
              <ChangeCount label="Deleted" value={changes.deleted} tone="text-destructive" />
            </div>
            <p className="text-xs text-muted-foreground">
              {changeTotal === 0
                ? 'The project folder matches what was last synced with the site.'
                : 'Files changed in this folder that the site does not have yet.'}
            </p>
          </>
        ) : null}
      </section>

      <section aria-label="Linked themes and plugins" className={cn(CARD, 'space-y-3 p-4')}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Themes and plugins</h3>
            <p className="text-xs text-muted-foreground">
              Only these are pulled and deployed. Everything else in the folder stays here.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SimpleTooltip label={readOnly ? READ_ONLY_HINT : null} wrapTrigger>
              <Button
                variant="outline"
                size="sm"
                disabled={!site || readOnly}
                onClick={() => setNewOpen(true)}
              >
                <FilePlus className="h-3.5 w-3.5" /> New theme or plugin
              </Button>
            </SimpleTooltip>
            <Button variant="outline" size="sm" disabled={!site} onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
        <ul className="overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]">
          {link.items.map((item) => {
            const key = wpItemKey(item);
            const details = itemsByKey.get(key);
            const missing = itemsQuery.isSuccess && !details;
            return (
              <li key={key} className="flex items-center gap-3 px-3 py-2">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">
                  {ITEM_KIND_LABEL[item.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  {itemsQuery.isPending && site ? (
                    <Skeleton className="h-4 w-32" />
                  ) : (
                    <span className="block truncate text-sm font-medium">
                      {details?.name ?? item.slug}
                    </span>
                  )}
                  <span className="block truncate text-xs text-muted-foreground">
                    <span className="font-mono">{wpItemRoot(item)}</span>
                    {details?.version ? ` · version ${details.version}` : ''}
                    {missing ? ' · not on the site any more' : ''}
                  </span>
                </span>
                {details?.networkActive || details?.active ? (
                  <span className="shrink-0 rounded-full bg-success/12 px-2 py-0.5 text-[10px] font-medium text-success">
                    {details.networkActive ? 'Network active' : 'Active'}
                  </span>
                ) : null}
                <SimpleTooltip
                  label={
                    link.items.length === 1
                      ? 'A project needs at least one theme or plugin. Unlink it instead.'
                      : `Stop syncing ${item.slug}`
                  }
                  wrapTrigger={link.items.length === 1}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Stop syncing ${item.slug}`}
                    disabled={link.items.length === 1}
                    onClick={() => void removeItem(item)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Ignored files" className={cn(CARD, 'space-y-3 p-4')}>
        <div>
          <h3 className="text-sm font-semibold">Ignored files and folders</h3>
          <p className="text-xs text-muted-foreground">
            Never deployed, and the site's copy of them is left alone. Kept for every deploy and
            pull of this project.
          </p>
        </div>
        <IgnoredFilesPanel project={project} />
      </section>

      {site ? (
        <>
          <PullFlowDialog
            open={pullOpen}
            onOpenChange={(open) => {
              setPullOpen(open);
              if (!open) void queryClient.invalidateQueries({ queryKey: changesKey });
            }}
            projectId={project.id}
            siteId={site.id}
          />
          <DeployFlowDialog
            open={deployOpen}
            onOpenChange={(open) => {
              setDeployOpen(open);
              if (!open) void queryClient.invalidateQueries({ queryKey: changesKey });
            }}
            projectId={project.id}
            siteId={site.id}
            items={deployItems}
          />
          <NewItemDialog
            open={newOpen}
            onOpenChange={setNewOpen}
            site={site}
            project={project}
            onAdded={(_updated, items) => {
              setDeployItems(items);
              setDeployOpen(true);
            }}
          />
          <AddItemsDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            project={project}
            siteId={site.id}
            items={itemsQuery.data}
            itemsLoading={itemsQuery.isPending}
            itemsError={itemsQuery.error}
          />
        </>
      ) : null}
      <RelinkDialog
        open={relinkOpen}
        onOpenChange={setRelinkOpen}
        project={project}
        sites={sitesQuery.data}
        sitesLoading={sitesQuery.isPending}
      />
    </div>
  );
}

function ChangeCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): React.JSX.Element {
  return (
    <div className="min-w-[6rem] rounded-lg bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.07]">
      <p className={cn('text-lg font-semibold tabular-nums', value > 0 ? tone : 'text-foreground')}>
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

/** Adds more of the site's themes and plugins to the project, pulling each one in. */
function AddItemsDialog({
  open,
  onOpenChange,
  project,
  siteId,
  items,
  itemsLoading,
  itemsError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  siteId: string;
  items: WpItem[] | undefined;
  itemsLoading: boolean;
  itemsError: unknown;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const setProjectItems = useWordPressOperationStore((state) => state.setProjectItems);
  const clearRun = useWordPressOperationStore((state) => state.clear);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [operationId, setOperationId] = useState<string | null>(null);
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );
  const linked = new Set((project.wordpress?.items ?? []).map((item) => wpItemKey(item)));

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setOperationId(null);
  }, [open]);

  async function add(): Promise<void> {
    const current = project.wordpress?.items ?? [];
    const added = (items ?? []).filter((item) => selected.has(wpItemKey(item))).map(toItemRef);
    const id = crypto.randomUUID();
    setOperationId(id);
    const updated = await setProjectItems(
      { operationId: id, projectId: project.id, items: [...current, ...added] },
      siteId,
    );
    if (updated) {
      replaceProject(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWordPressChanges(project.id),
      });
      clearRun(id);
      setOperationId(null);
      onOpenChange(false);
      toast.success(
        added.length === 1 ? `Added ${added[0].slug}.` : `Added ${added.length} items.`,
      );
    }
  }

  const running = run?.status === 'running';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && run && run.status !== 'running') clearRun(run.operationId);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add themes and plugins</DialogTitle>
          <DialogDescription>
            What you add is pulled into the project folder now, and deployed with the rest later.
          </DialogDescription>
        </DialogHeader>
        <OverflowScroll fill>
          {run ? (
            <div className="space-y-3">
              {run.status === 'failed' ? (
                <RunError message={run.error ?? "Couldn't add them."} code={run.errorCode} />
              ) : null}
              <OperationTimeline run={run} />
            </div>
          ) : (
            <ItemPicker
              items={items}
              loading={itemsLoading}
              error={itemsError}
              selected={selected}
              onChange={setSelected}
              exclude={linked}
            />
          )}
        </OverflowScroll>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {running ? 'Hide' : 'Cancel'}
          </Button>
          {run?.status === 'failed' ? (
            <Button
              onClick={() => {
                clearRun(run.operationId);
                setOperationId(null);
              }}
            >
              Back
            </Button>
          ) : (
            <Button disabled={selected.size === 0 || running} onClick={() => void add()}>
              {running ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add and pull
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Moves the link to a connected site, for a project whose site was disconnected and connected
 * again (which gives it a new id). The items must exist on the chosen site.
 */
function RelinkDialog({
  open,
  onOpenChange,
  project,
  sites,
  sitesLoading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  sites: DeployWordPressSite[] | undefined;
  sitesLoading: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const setProjectItems = useWordPressOperationStore((state) => state.setProjectItems);
  const clearRun = useWordPressOperationStore((state) => state.clear);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );

  useEffect(() => {
    if (!open) return;
    setSiteId(null);
    setOperationId(null);
  }, [open]);

  async function relink(): Promise<void> {
    if (!siteId || !project.wordpress) return;
    if (operationId) clearRun(operationId);
    const id = crypto.randomUUID();
    setOperationId(id);
    const updated = await setProjectItems(
      { operationId: id, projectId: project.id, siteId, items: project.wordpress.items },
      siteId,
    );
    if (updated) {
      replaceProject(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWordPressChanges(project.id),
      });
      clearRun(id);
      setOperationId(null);
      onOpenChange(false);
      toast.success('Linked to the site again.');
    }
  }

  const running = run?.status === 'running';
  const candidates = (sites ?? []).filter((site) => site.id !== project.wordpress?.siteId);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Link to a connected site</DialogTitle>
            <DialogDescription>
              Pick the site this project belongs to. It needs the same themes and plugins this
              project syncs.
            </DialogDescription>
          </DialogHeader>
          <OverflowScroll fill>
            <div className="space-y-3">
              <SitePicker
                sites={candidates}
                loading={sitesLoading}
                error={null}
                selectedId={siteId}
                onSelect={(site) => setSiteId(site.id)}
                onConnect={() => setConnectOpen(true)}
                highlightUrl={project.websiteUrl || undefined}
              />
              {run?.status === 'failed' ? (
                <RunError message={run.error ?? "Couldn't link the site."} code={run.errorCode} />
              ) : null}
              {running ? <OperationTimeline run={run} /> : null}
            </div>
          </OverflowScroll>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!siteId || running} onClick={() => void relink()}>
              {running ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <LinkIcon className="h-4 w-4" />
              )}
              Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConnectSiteDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(connected) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSites });
          setSiteId(connected.id);
        }}
      />
    </>
  );
}
