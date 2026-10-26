import type { Project, WpItemRef } from '@runova/core';
import { wpItemKey, wpItemRoot } from '@runova/core';
import type { DeployWordPressLocalItem, DeployWordPressSite } from '@shared/deployWordPressTypes';
import { wordPressErrorCode, wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, CloudUpload, RefreshCw, Spinner } from '@/components/icons';
import { RunError } from '@/components/projects/wordpress/FlowParts';
import { OperationTimeline } from '@/components/projects/wordpress/OperationTimeline';
import { replaceProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
import {
  ITEM_KIND_GROUP_LABEL,
  ITEM_KIND_ORDER,
} from '@/components/projects/wordpress/wordpressCopy';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { queryKeys } from '@/lib/queryKeys';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { ProjectChoiceList } from './AddToProjectDialog';
import { useProjects, useSiteItems } from './hooks';
import { projectChoicesForSite } from './itemProjects';

/**
 * Deploys a theme or plugin the site does not have yet (E21). The folders in a project's
 * wp-content that the site lacks are listed, the ticked ones are linked to the project as new
 * (nothing is pulled), and the caller opens the deploy review for them: the first deploy creates
 * them on the site. The project is picked first, unless the caller already knows it.
 */

export interface NewItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: DeployWordPressSite;
  /** The project the folders are in, when the caller knows it; otherwise the user picks one. */
  project?: Project;
  /** The items are linked. The caller opens the review of their first deploy. */
  onAdded: (project: Project, items: WpItemRef[]) => void;
}

type Step = 'project' | 'folders';

const SILENT = { silentLoading: true } as const;

function toRef(item: DeployWordPressLocalItem): WpItemRef {
  return { kind: item.kind, slug: item.slug };
}

function names(items: readonly WpItemRef[]): string {
  const slugs = items.map((item) => item.slug);
  if (slugs.length <= 2) return slugs.join(' and ');
  return `${slugs.slice(0, 2).join(', ')} and ${slugs.length - 2} more`;
}

export function NewItemDialog({
  open,
  onOpenChange,
  site,
  project: fixed,
  onAdded,
}: NewItemDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  const siteItemsQuery = useSiteItems(site.id);
  const setProjectItems = useWordPressOperationStore((state) => state.setProjectItems);
  const linkProject = useWordPressOperationStore((state) => state.linkProject);
  const clearRun = useWordPressOperationStore((state) => state.clear);

  const [step, setStep] = useState<Step>(fixed ? 'folders' : 'project');
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [operationId, setOperationId] = useState<string | null>(null);
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );

  const project = fixed ?? projectsQuery.data?.find((entry) => entry.id === chosenId) ?? null;
  const projectId = project?.id ?? null;

  // Start over each time it opens. Keyed on the project's id: a refetched project is a new
  // object, and must not wipe the ticks.
  const fixedId = fixed?.id;
  useEffect(() => {
    if (!open) return;
    setStep(fixedId ? 'folders' : 'project');
    setChosenId(null);
    setPicked(new Set());
    setOperationId(null);
  }, [open, fixedId]);

  const localQuery = useQuery({
    queryKey: queryKeys.projectWordPressLocalItems(projectId ?? ''),
    queryFn: async () =>
      (await window.runova.deployWordPress.localItems(projectId as string)) ?? [],
    enabled: open && step === 'folders' && projectId !== null,
    // A folder made a moment ago must show, so every opening looks again.
    staleTime: 0,
    gcTime: 0,
    meta: SILENT,
  });

  const onSite = new Set((siteItemsQuery.data ?? []).map((item) => wpItemKey(item)));
  const candidates = (localQuery.data ?? []).filter(
    (item) => !item.linked && !onSite.has(wpItemKey(item)),
  );
  const loading = localQuery.isPending || (siteItemsQuery.isPending && !siteItemsQuery.isError);
  const choices = projectChoicesForSite(projectsQuery.data ?? [], site.id);
  const chosen = picked.size;
  const running = run?.status === 'running';

  async function add(): Promise<void> {
    if (!project) return;
    const items = ITEM_KIND_ORDER.flatMap((kind) =>
      candidates.filter((item) => item.kind === kind && picked.has(wpItemKey(item))).map(toRef),
    );
    if (items.length === 0) return;
    const id = crypto.randomUUID();
    setOperationId(id);
    const link = project.wordpress;
    let updated: Project | null;
    if (link) {
      updated = await setProjectItems(
        {
          operationId: id,
          projectId: project.id,
          items: [...link.items, ...items],
          newItems: items,
        },
        site.id,
      );
    } else {
      const linked = await linkProject({
        operationId: id,
        projectId: project.id,
        siteId: site.id,
        items,
        newItems: items,
      });
      updated = linked?.project ?? null;
    }
    if (!updated) return;
    replaceProject(queryClient, updated);
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectWordPressChanges(project.id) });
    clearRun(id);
    setOperationId(null);
    onOpenChange(false);
    toast.success(`Added ${names(items)}. Review the deploy next.`);
    onAdded(updated, items);
  }

  function toggle(key: string, checked: boolean): void {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function backToTicks(): void {
    if (operationId) clearRun(operationId);
    setOperationId(null);
  }

  const showProgress = run !== null;
  const failed = run?.status === 'failed';
  const siteName = site.label || site.siteName;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && run && run.status !== 'running') clearRun(run.operationId);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>New theme or plugin</DialogTitle>
          <DialogDescription>
            {step === 'project'
              ? 'Pick the project the new theme or plugin is in.'
              : `Add a theme or plugin ${siteName} doesn't have yet. The first deploy creates it on the site.`}
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll fill>
          {showProgress ? (
            <div className="space-y-3">
              {failed ? (
                <RunError
                  message={run?.error ?? "Couldn't add them."}
                  code={run?.errorCode ?? null}
                />
              ) : null}
              {run ? <OperationTimeline run={run} /> : null}
            </div>
          ) : step === 'project' ? (
            <ProjectChoiceList
              choices={choices}
              sites={[site]}
              selectedId={chosenId}
              onSelect={(entry) => setChosenId(entry.id)}
              loading={projectsQuery.isPending}
              show={['siteProjects', 'unlinked']}
            />
          ) : (
            <div className="space-y-3">
              {project ? (
                <p className="truncate px-1 text-xs text-muted-foreground">
                  Looking in <span className="font-medium text-foreground">{project.name}</span>
                </p>
              ) : null}
              {loading ? (
                <div
                  role="status"
                  aria-label="Looking for theme and plugin folders"
                  className="space-y-1.5"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
              ) : localQuery.isError ? (
                <RunError
                  message={wordPressErrorMessage(localQuery.error)}
                  code={wordPressErrorCode(localQuery.error)}
                />
              ) : candidates.length === 0 ? (
                <div className="space-y-3 rounded-lg bg-foreground/[0.03] px-4 py-5 text-center ring-1 ring-inset ring-foreground/[0.07]">
                  <p className="text-sm font-medium">No new themes or plugins in this project</p>
                  <p className="text-xs text-muted-foreground">
                    Put the files of a new theme in{' '}
                    <span className="font-mono">wp-content/themes/&lt;name&gt;/</span> or a plugin
                    in <span className="font-mono">wp-content/plugins/&lt;name&gt;/</span> inside
                    the project folder, or ask your agent to create it there. Then check again.
                  </p>
                  {project ? (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      {project.folderPath}
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={localQuery.isFetching}
                    onClick={() => void localQuery.refetch()}
                  >
                    <RefreshCw
                      className={localQuery.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                    />{' '}
                    Check again
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {ITEM_KIND_ORDER.map((kind) => {
                    const group = candidates.filter((item) => item.kind === kind);
                    if (group.length === 0) return null;
                    return (
                      <section key={kind} className="space-y-1.5">
                        <h3 className="select-none px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                          {ITEM_KIND_GROUP_LABEL[kind]}
                        </h3>
                        <ul className="overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]">
                          {group.map((item) => {
                            const key = wpItemKey(item);
                            const id = `wp-new-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
                            return (
                              <li key={key} className="flex items-center gap-3 px-3 py-2">
                                <Checkbox
                                  id={id}
                                  checked={picked.has(key)}
                                  onCheckedChange={(checked) => toggle(key, checked === true)}
                                />
                                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                                  <span className="block truncate font-mono text-sm font-medium">
                                    {item.slug}
                                  </span>
                                  <span className="block truncate font-mono text-xs text-muted-foreground">
                                    {wpItemRoot(item)}
                                  </span>
                                </label>
                                {item.isFile ? (
                                  <span className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    Single file
                                  </span>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    );
                  })}
                  <p className="px-1 text-xs text-muted-foreground">
                    Folders {siteName} already has are added from its own list instead.
                  </p>
                </div>
              )}
              {step === 'folders' && project && project.wordpress === undefined ? (
                <p role="note" className="px-1 text-xs text-muted-foreground">
                  {project.name} becomes a WordPress project linked to {siteName}.
                </p>
              ) : null}
            </div>
          )}
        </OverflowScroll>

        <DialogFooter>
          {showProgress ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {running ? 'Hide' : 'Cancel'}
              </Button>
              {failed ? <Button onClick={backToTicks}>Back</Button> : null}
            </>
          ) : step === 'project' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={chosenId === null || project === null}
                onClick={() => {
                  setPicked(new Set());
                  setStep('folders');
                }}
              >
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              {fixed ? null : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPicked(new Set());
                    setStep('project');
                  }}
                >
                  Back
                </Button>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={chosen === 0 || running} onClick={() => void add()}>
                {running ? (
                  <Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <CloudUpload className="h-4 w-4" />
                )}
                Add and review deploy
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
