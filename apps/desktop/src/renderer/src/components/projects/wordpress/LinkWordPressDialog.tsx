import type { Project, WpItemRef } from '@runova/core';
import { wpItemKey, wpItemRoot } from '@runova/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleInfo, Link as LinkIcon, Spinner } from '@/components/icons';
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
import { ConnectSiteDialog } from '@/components/wordpress/ConnectSiteDialog';
import { queryKeys } from '@/lib/queryKeys';
import { findWordPressRun, useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { OutcomeBanner, RunError } from './FlowParts';
import { defaultItemKeys, ItemPicker, startingItemKeys, toItemRef } from './ItemPicker';
import { OperationTimeline } from './OperationTimeline';
import { SitePicker } from './SitePicker';

/**
 * Turns an existing project into a WordPress project: pick a connected site and which of its
 * themes and plugins the project syncs. Items with no folder in the project yet are pulled in;
 * a folder that already holds files is linked as it is, and the first pull compares it with the
 * site. Unlinking from the WordPress section turns it back into a plain project. Opened from a
 * site's Deploy page it skips the site step.
 */

type Step = 'site' | 'items' | 'run';

const SILENT = { silentLoading: true } as const;

export const LINK_FOLDER_NOTE =
  "Each item lives where it does on the site, like wp-content/themes/your-theme. A folder that's missing or empty is pulled in now. One that already holds files is left exactly as it is; Pull latest then shows every file that differs from the site and lets you choose.";

const STEP_TITLE: Record<Step, string> = {
  site: 'Which site?',
  items: 'Which themes and plugins?',
  run: 'Linking',
};

const STEP_DESCRIPTION: Record<Step, string> = {
  site: 'Pick the WordPress site this project belongs to.',
  items: 'Only what you tick is synced with the site. Everything else in the folder stays here.',
  run: 'You can close this window; it keeps going.',
};

export function LinkWordPressDialog({
  open,
  onOpenChange,
  project,
  onLinked,
  initialSiteId,
  initialItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  /** Called once the user leaves the finished dialog for the project's WordPress section. */
  onLinked: () => void;
  /** Start on the items step with this site picked, as when opened from the site's page. */
  initialSiteId?: string;
  /** What to tick for `initialSiteId` instead of its active theme. */
  initialItems?: WpItemRef[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const linkProject = useWordPressOperationStore((state) => state.linkProject);
  const cancelRun = useWordPressOperationStore((state) => state.cancel);
  const clearRun = useWordPressOperationStore((state) => state.clear);

  const [step, setStep] = useState<Step>('site');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [operationId, setOperationId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const preselectedFor = useRef<string | null>(null);
  // Read when the items load, so a new array with the same items never starts over.
  const startingItems = useRef(initialItems);
  startingItems.current = initialItems;
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );

  const sitesQuery = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: () => window.runova.deployWordPress.listSites(),
    enabled: open,
    meta: SILENT,
  });
  const site = sitesQuery.data?.find((candidate) => candidate.id === siteId) ?? null;
  const itemsQuery = useQuery({
    queryKey: queryKeys.deployWordPressItems(siteId ?? ''),
    queryFn: () => window.runova.deployWordPress.listItems(siteId as string),
    enabled: open && siteId !== null && step !== 'site',
    meta: SILENT,
  });

  // Start over each time it opens, or pick up a link still running for this project.
  useEffect(() => {
    if (!open) return;
    const existing = findWordPressRun(useWordPressOperationStore.getState().runs, {
      kind: 'items',
      projectId: project.id,
    });
    if (existing?.result === null || existing?.result?.kind === 'link') {
      setOperationId(existing.operationId);
      setStep('run');
      return;
    }
    setStep(initialSiteId ? 'items' : 'site');
    setSiteId(initialSiteId ?? null);
    setSelected(new Set());
    setOperationId(null);
    preselectedFor.current = null;
  }, [open, project.id, initialSiteId]);

  // `open` is here so opening again for the same site, with its items cached, ticks afresh.
  useEffect(() => {
    if (!open || !siteId || !itemsQuery.data || preselectedFor.current === siteId) return;
    preselectedFor.current = siteId;
    const wanted = siteId === initialSiteId ? startingItems.current : undefined;
    setSelected(
      wanted ? startingItemKeys(itemsQuery.data, wanted) : defaultItemKeys(itemsQuery.data),
    );
  }, [open, siteId, itemsQuery.data, initialSiteId]);

  const runStatus = run?.status;
  useEffect(() => {
    if (runStatus === 'done') void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }, [runStatus, queryClient]);

  function pickSite(next: DeployWordPressSite): void {
    if (next.id === siteId) return;
    setSiteId(next.id);
    setSelected(new Set());
    preselectedFor.current = null;
  }

  function link(): void {
    if (!siteId) return;
    const items = (itemsQuery.data ?? [])
      .filter((item) => selected.has(wpItemKey(item)))
      .map(toItemRef);
    const id = crypto.randomUUID();
    setOperationId(id);
    setStep('run');
    void linkProject({ operationId: id, projectId: project.id, siteId, items });
  }

  function handleOpenChange(next: boolean): void {
    if (!next && run && run.status !== 'running') clearRun(run.operationId);
    onOpenChange(next);
  }

  function openSection(): void {
    if (run?.result?.kind === 'link') {
      const updated = run.result.value.project;
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) =>
        prev?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      clearRun(run.operationId);
    }
    onOpenChange(false);
    onLinked();
  }

  function backToItems(): void {
    if (run) clearRun(run.operationId);
    setOperationId(null);
    setStep(siteId ? 'items' : 'site');
  }

  const selectedCount = (itemsQuery.data ?? []).filter((item) =>
    selected.has(wpItemKey(item)),
  ).length;
  const linked = run?.result?.kind === 'link' ? run.result.value : null;
  // A project linked to another site, or to one that was disconnected, moves to the one picked.
  const fromSiteId = project.wordpress?.siteId;
  const movingFrom =
    fromSiteId && fromSiteId !== siteId
      ? (sitesQuery.data?.find((candidate) => candidate.id === fromSiteId)?.label ??
        (sitesQuery.data ? 'a disconnected site' : 'another site'))
      : null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Make this a WordPress project</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{STEP_TITLE[step]}</span>{' '}
              {STEP_DESCRIPTION[step]}
            </DialogDescription>
          </DialogHeader>

          <OverflowScroll fill>
            {step === 'site' ? (
              <SitePicker
                sites={sitesQuery.data}
                loading={sitesQuery.isPending}
                error={sitesQuery.error}
                selectedId={siteId}
                onSelect={pickSite}
                onConnect={() => setConnectOpen(true)}
                highlightUrl={project.websiteUrl || undefined}
              />
            ) : null}

            {step === 'items' ? (
              <div className="space-y-3">
                {movingFrom ? (
                  <p
                    role="note"
                    className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/25"
                  >
                    <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    {`${project.name} is linked to ${movingFrom} now. Linking moves it to ${site?.label ?? 'this site'}, and it stops syncing with ${movingFrom}.`}
                  </p>
                ) : null}
                <ItemPicker
                  items={itemsQuery.data}
                  loading={itemsQuery.isPending}
                  error={itemsQuery.error}
                  selected={selected}
                  onChange={setSelected}
                />
                <p className="flex items-start gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
                  <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {LINK_FOLDER_NOTE}
                </p>
              </div>
            ) : null}

            {step === 'run' && run ? (
              <div className="space-y-4">
                {linked ? (
                  <OutcomeBanner
                    outcome={
                      linked.notPulled.length === 0
                        ? {
                            tone: 'success',
                            title: `${project.name} is now a WordPress project`,
                            detail: 'The themes and plugins you picked are in the project folder.',
                          }
                        : {
                            tone: 'warning',
                            title: `${project.name} is now a WordPress project`,
                            detail: `${linked.notPulled.map(wpItemRoot).join(', ')} already held files, so ${linked.notPulled.length === 1 ? 'it was' : 'they were'} left as ${linked.notPulled.length === 1 ? 'it is' : 'they are'}. Use Pull latest to compare with the site before you deploy.`,
                          }
                    }
                  />
                ) : null}
                {run.status === 'failed' ? (
                  <RunError
                    message={run.error ?? "The project couldn't be linked."}
                    code={run.errorCode}
                  />
                ) : null}
                <OperationTimeline run={run} />
              </div>
            ) : null}
          </OverflowScroll>

          <DialogFooter>
            {step === 'site' ? (
              <>
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button disabled={!site} onClick={() => setStep('items')}>
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </>
            ) : null}
            {step === 'items' ? (
              <>
                <Button variant="ghost" onClick={() => setStep('site')}>
                  Back
                </Button>
                <Button disabled={selectedCount === 0} onClick={link}>
                  <LinkIcon className="h-4 w-4" /> Link
                </Button>
              </>
            ) : null}
            {step === 'run' && run ? (
              run.status === 'running' ? (
                <>
                  <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                    Hide
                  </Button>
                  <Button
                    variant="soft"
                    disabled={run.cancelling}
                    onClick={() => void cancelRun(run.operationId)}
                  >
                    {run.cancelling ? <Spinner className="h-4 w-4 animate-spin" /> : null}
                    {run.cancelling ? 'Cancelling' : 'Cancel'}
                  </Button>
                </>
              ) : run.status === 'failed' ? (
                <>
                  <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                    Close
                  </Button>
                  <Button onClick={backToItems}>Back</Button>
                </>
              ) : (
                <Button onClick={openSection}>
                  Open the WordPress section <ArrowRight className="h-4 w-4" />
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConnectSiteDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(connected) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSites });
          pickSite(connected);
        }}
      />
    </>
  );
}
