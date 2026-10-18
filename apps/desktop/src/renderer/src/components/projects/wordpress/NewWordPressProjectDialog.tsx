import type { AgentType, WpItemRef } from '@agentmat/core';
import { AGENT_TYPES, wpItemKey } from '@agentmat/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cliOptionIcon } from '@/components/cliLogos';
import { ArrowRight, Check, CircleInfo, FolderOpen, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { ConnectSiteDialog } from '@/components/wordpress/ConnectSiteDialog';
import { queryKeys } from '@/lib/queryKeys';
import { findWordPressRun, useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { OutcomeBanner, RunError } from './FlowParts';
import { defaultItemKeys, ItemPicker, startingItemKeys, toItemRef } from './ItemPicker';
import { OperationTimeline } from './OperationTimeline';
import { SitePicker } from './SitePicker';
import { joinFolder, slugifyProjectName } from './wordpressCopy';

/**
 * A new project made from a connected WordPress site (E21): pick the site, pick its themes and
 * plugins, name the project and its folder, then pull them in. The pull lives in the operation
 * store, so closing this window mid-way and opening it again shows where it got to. Opened from a
 * site's Deploy page it skips the site step and ticks what was clicked there.
 */

type Step = 'site' | 'items' | 'details' | 'run';

const SILENT = { silentLoading: true } as const;

export const FOLDER_NOTE =
  "The folder keeps the site's layout, like wp-content/themes/your-theme. Only the items you pick are ever pulled or deployed. Agent settings and AgentMate's own files in this folder stay on this computer.";

const STEP_TITLE: Record<Step, string> = {
  site: 'Which site?',
  items: 'Which themes and plugins?',
  details: 'Name and folder',
  run: 'Pulling the files',
};

const STEP_DESCRIPTION: Record<Step, string> = {
  site: 'Pick a WordPress site connected through the AgentMate Connector plugin.',
  items: 'Only what you tick is pulled into the project, and only that is ever deployed back.',
  details: 'Where the project lives on this computer and which agent works on it.',
  run: 'You can close this window; the pull keeps going.',
};

export function NewWordPressProjectDialog({
  open,
  onOpenChange,
  initialSiteId,
  initialItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Start on the items step with this site picked, as when opened from the site's page. */
  initialSiteId?: string;
  /** What to tick for `initialSiteId` instead of its active theme. */
  initialItems?: WpItemRef[];
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createProject = useWordPressOperationStore((state) => state.createProject);
  const cancelRun = useWordPressOperationStore((state) => state.cancel);
  const clearRun = useWordPressOperationStore((state) => state.clear);
  const nameId = useId();
  const folderId = useId();

  const [step, setStep] = useState<Step>('site');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  /** The site whose active theme was last ticked for the user, so a refetch never re-ticks it. */
  const preselectedFor = useRef<string | null>(null);
  /** The starting site, until its name has been filled in once the sites have loaded. */
  const nameFromSite = useRef<string | null>(null);
  // Read when the items load, so a new array with the same items never starts over.
  const startingItems = useRef(initialItems);
  startingItems.current = initialItems;
  const run = useWordPressOperationStore((state) =>
    operationId ? (state.runs[operationId] ?? null) : null,
  );

  const sitesQuery = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: () => window.agentmat.deployWordPress.listSites(),
    enabled: open,
    meta: SILENT,
  });
  const site = sitesQuery.data?.find((candidate) => candidate.id === siteId) ?? null;
  const itemsQuery = useQuery({
    queryKey: queryKeys.deployWordPressItems(siteId ?? ''),
    queryFn: () => window.agentmat.deployWordPress.listItems(siteId as string),
    enabled: open && siteId !== null && step !== 'site',
    meta: SILENT,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
    enabled: open,
  });

  // Start over each time it opens, or pick up a project still being made.
  useEffect(() => {
    if (!open) return;
    const existing = findWordPressRun(useWordPressOperationStore.getState().runs, {
      kind: 'createProject',
    });
    if (existing) {
      setOperationId(existing.operationId);
      setStep('run');
      return;
    }
    setStep(initialSiteId ? 'items' : 'site');
    setSiteId(initialSiteId ?? null);
    setSelected(new Set());
    setName('');
    setNameTouched(false);
    setFolder('');
    setFolderTouched(false);
    setAgentType('claude-code');
    setOperationId(null);
    preselectedFor.current = null;
    nameFromSite.current = initialSiteId ?? null;
  }, [open, initialSiteId]);

  // `open` is here so opening again for the same site, with its items cached, ticks afresh.
  useEffect(() => {
    if (!open || !siteId || !itemsQuery.data || preselectedFor.current === siteId) return;
    preselectedFor.current = siteId;
    const wanted = siteId === initialSiteId ? startingItems.current : undefined;
    setSelected(
      wanted ? startingItemKeys(itemsQuery.data, wanted) : defaultItemKeys(itemsQuery.data),
    );
  }, [open, siteId, itemsQuery.data, initialSiteId]);

  // A site picked on the way in has no click to name the project from, so do it once it loads.
  useEffect(() => {
    if (!site || nameFromSite.current !== site.id) return;
    nameFromSite.current = null;
    if (!nameTouched) setName((current) => current || site.label || site.siteName);
  }, [site, nameTouched]);

  const runStatus = run?.status;
  useEffect(() => {
    if (runStatus === 'done') void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }, [runStatus, queryClient]);

  function pickSite(next: DeployWordPressSite): void {
    nameFromSite.current = null;
    if (next.id !== siteId) {
      setSiteId(next.id);
      setSelected(new Set());
      preselectedFor.current = null;
    }
    if (!nameTouched) setName(next.label || next.siteName);
  }

  const root = settingsQuery.data?.projectsRootPath?.trim() || '';
  const folderPath = folderTouched
    ? folder
    : root && name.trim()
      ? joinFolder(root, slugifyProjectName(name))
      : '';

  async function pickFolder(): Promise<void> {
    const picked = await window.agentmat.projects.pickFolder();
    if (!picked) return;
    setFolder(picked);
    setFolderTouched(true);
  }

  function create(): void {
    if (!siteId) return;
    const items = (itemsQuery.data ?? [])
      .filter((item) => selected.has(wpItemKey(item)))
      .map(toItemRef);
    const id = crypto.randomUUID();
    setOperationId(id);
    setStep('run');
    void createProject({
      operationId: id,
      siteId,
      items,
      folderPath: folderPath.trim(),
      name: name.trim(),
      agentType,
    });
  }

  function handleOpenChange(next: boolean): void {
    if (!next && run && run.status !== 'running') clearRun(run.operationId);
    onOpenChange(next);
  }

  function openProject(): void {
    if (run?.result?.kind !== 'project') return;
    const projectId = run.result.value.id;
    clearRun(run.operationId);
    onOpenChange(false);
    navigate(`/projects/${projectId}`);
  }

  function backToDetails(): void {
    if (run) clearRun(run.operationId);
    setOperationId(null);
    setStep(siteId ? 'details' : 'site');
  }

  const selectedCount = (itemsQuery.data ?? []).filter((item) =>
    selected.has(wpItemKey(item)),
  ).length;
  const detailsReady = name.trim().length > 0 && folderPath.trim().length > 0;
  const created = run?.result?.kind === 'project' ? run.result.value : null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>New project from a WordPress site</DialogTitle>
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
              />
            ) : null}

            {step === 'items' ? (
              <ItemPicker
                items={itemsQuery.data}
                loading={itemsQuery.isPending}
                error={itemsQuery.error}
                selected={selected}
                onChange={setSelected}
              />
            ) : null}

            {step === 'details' ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor={nameId}>Name</Label>
                  <Input
                    id={nameId}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameTouched(true);
                    }}
                    placeholder="My WordPress site"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={folderId}>Folder</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={folderId}
                      value={folderPath}
                      onChange={(event) => {
                        setFolder(event.target.value);
                        setFolderTouched(true);
                      }}
                      placeholder={
                        root ? undefined : 'Pick a folder, or set a projects folder in Settings'
                      }
                      spellCheck={false}
                    />
                    <Button
                      variant="soft"
                      className="h-9 shrink-0"
                      onClick={() => void pickFolder()}
                    >
                      <FolderOpen className="h-4 w-4" /> Browse
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Agent type</Label>
                  <Combobox
                    value={agentType}
                    onChange={(value) => setAgentType(value as AgentType)}
                    options={AGENT_TYPES.map((agent) => ({
                      value: agent.value,
                      label: agent.label,
                      icon: cliOptionIcon(agent.cliId),
                    }))}
                  />
                </div>
                <p className="flex items-start gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
                  <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {FOLDER_NOTE}
                </p>
              </div>
            ) : null}

            {step === 'run' && run ? (
              <div className="space-y-4">
                {created ? (
                  <OutcomeBanner
                    outcome={{
                      tone: 'success',
                      title: `${created.name} is ready`,
                      detail:
                        'The files are in the project folder. Open the project to start work.',
                    }}
                  />
                ) : null}
                {run.status === 'failed' ? (
                  <RunError
                    message={run.error ?? "The project couldn't be made."}
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
                <Button disabled={selectedCount === 0} onClick={() => setStep('details')}>
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </>
            ) : null}
            {step === 'details' ? (
              <>
                <Button variant="ghost" onClick={() => setStep('items')}>
                  Back
                </Button>
                <Button disabled={!detailsReady} onClick={create}>
                  <Check className="h-4 w-4" /> Create project
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
                  <Button onClick={backToDetails}>Back</Button>
                </>
              ) : (
                <Button onClick={openProject}>
                  Open the project <ArrowRight className="h-4 w-4" />
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
