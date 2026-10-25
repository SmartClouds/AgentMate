import {
  applyJobEvent,
  buildChecklist,
  buildInstallPlan,
  buildUpdatePlan,
  type Checklist,
  collectConsents,
  DEV_STACKS,
  type DevDetection,
  type DevItemId,
  type DevItemJob,
  type DevJobState,
  type DevSetupEnvironment,
  type DevUpdateCheck,
  type DevUpdateSource,
  EMPTY_JOB_STATE,
  hasUpdate,
  type InstallPlan,
  itemsForStacks,
  missingItemIds,
  normalizeDevSetupStacks,
  type UpdatePlan,
  updatableItemIds,
  updateSourceFor,
} from '@agentmat/core';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { UpdateStatus } from './devSetupView';

/** How often a row that was handed to the terminal checks whether the tool has turned up. */
const POLL_MS = 5_000;
/** After this long the row stops waiting and goes back to offering the install. */
const GIVE_UP_MS = 10 * 60_000;
/** What main refuses with when a step carries an agreement the request did not accept. */
const CONSENT_REQUIRED = 'consent-required';
/** Main remembers update answers for half an hour, so asking again sooner costs nothing. */
const UPDATES_STALE_MS = 10 * 60_000;

export interface TerminalHandoff {
  id: DevItemId;
  name: string;
  command: string;
  /** What the command is for. Absent means install. */
  intent?: 'install' | 'update';
}

export interface UseDevSetup {
  environment: DevSetupEnvironment | undefined;
  /** The machine could not be described at all, which leaves nothing to check against. */
  environmentFailed: boolean;
  retryEnvironment: () => void;
  stacks: string[];
  toggleStack: (id: string) => void;
  /** Undefined until the machine has been described. */
  checklist: Checklist | undefined;
  /** The install run, as main has reported it. */
  job: DevJobState;
  /** What "Install all missing" would do right now. */
  plan: InstallPlan | undefined;
  /** What "Update all" would do right now. */
  updatePlan: UpdatePlan | undefined;
  /** How the search for newer versions is going. It never holds up the checklist. */
  updatesStatus: UpdateStatus;
  install: (ids: readonly DevItemId[]) => Promise<void>;
  installAll: () => Promise<void>;
  /** Brings tools that are already installed up to date. */
  update: (ids: readonly DevItemId[]) => Promise<void>;
  updateAll: () => Promise<void>;
  /** With an id, takes that waiting step out of the queue; without, stops the whole run. */
  cancel: (id?: DevItemId) => void;
  recheck: (id: DevItemId) => void;
  recheckAll: () => void;
  openInTerminal: (handoff: TerminalHandoff) => void;
  copyCommand: (handoff: Pick<TerminalHandoff, 'name' | 'command'>) => Promise<void>;
  /** Puts a tool that is installed but off PATH onto the user PATH. Says how it went; never throws. */
  addToPath: (target: { id: DevItemId; name: string }) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not check this.';
}

/** Electron wraps a handler's error as "Error invoking remote method 'x': Error: the message". */
function plainMessage(error: unknown): string {
  return messageOf(error).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/**
 * Everything the Dev Setup panel needs: the chosen stacks, one independent probe per item (so a
 * slow `dotnet` never holds up `git`), the install run as main reports it, and the hand-off to a
 * terminal for installs the app does not run itself. What each row says comes from `devSetupView`;
 * this only gathers and acts.
 */
export function useDevSetup(): UseDevSetup {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
    meta: { silentLoading: true },
  });
  const saveStacks = useMutation({
    mutationFn: (next: string[]) => window.agentmat.settings.update({ devSetupStacks: next }),
    meta: { silentLoading: true },
    // Returned, so the save counts as in flight until the fresh settings have arrived. Without
    // that the chips would flash back to the old choice for the moment between the two.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    onError: () => toast.error('Could not save your choice.'),
  });
  // While a save is in flight the chips show the choice being saved, so they do not snap back.
  const pendingStacks = saveStacks.isPending ? saveStacks.variables : undefined;
  const stacks = normalizeDevSetupStacks(pendingStacks ?? settingsQuery.data?.devSetupStacks);

  const environmentQuery = useQuery({
    queryKey: queryKeys.devSetupEnvironment,
    queryFn: () => window.agentmat.devSetup.environment({ force: true }),
    meta: { silentLoading: true },
    staleTime: 30_000,
  });
  const environment = environmentQuery.data;

  /** Items handed to a terminal: when, and whether it was an update (which is looked at differently). */
  const [waiting, setWaiting] = useState<Record<DevItemId, { at: number; update: boolean }>>({});
  const [job, setJob] = useState<DevJobState>(EMPTY_JOB_STATE);
  /** Goes up when the person presses Check again, which makes the update checks ask afresh. */
  const [updateRound, setUpdateRound] = useState(0);
  const forcedRounds = useRef(new Set<string>());
  /** The last answer for each item, kept until a newer one arrives so chips do not flicker. */
  const knownUpdates = useRef<Record<DevItemId, DevUpdateCheck>>({});

  // Follow the run. A window opened half way through one has missed the earlier events, so it asks
  // for the current state too, but never lets that answer replace events already received.
  useEffect(() => {
    let live = true;
    const unsubscribe = window.agentmat.devSetup.onEvent((event) => {
      setJob((current) => applyJobEvent(current, event));
    });
    void window.agentmat.devSetup
      .jobState()
      .then((snapshot) => {
        if (live && snapshot) setJob((current) => (current.jobId === null ? snapshot : current));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const items = environment ? itemsForStacks(stacks, environment.os) : [];
  const probes = useQueries({
    queries: items.map((item) => ({
      queryKey: queryKeys.devSetupItem(item.id),
      queryFn: () => window.agentmat.devSetup.detect(item.id, { force: true }),
      meta: { silentLoading: true },
      staleTime: 10_000,
      refetchInterval: waiting[item.id] ? POLL_MS : false,
    })),
  });

  const detections: Record<DevItemId, DevDetection | undefined> = {};
  items.forEach((item, index) => {
    const probe = probes[index];
    if (!probe) return;
    if (probe.data) detections[item.id] = probe.data;
    else if (probe.isError)
      detections[item.id] = { state: 'error', message: messageOf(probe.error) };
  });

  // Newer versions are a separate question from "is it installed", and a slower one, so it never
  // holds the rows up. Each source answers by itself: winget in a few seconds, the Android SDK
  // after a JVM has started, and neither waits for the other.
  const sources = new Map<DevUpdateSource, DevItemId[]>();
  if (environment) {
    for (const item of items) {
      const source = updateSourceFor(item, environment);
      if (source) sources.set(source, [...(sources.get(source) ?? []), item.id]);
    }
  }
  const sourceList = [...sources].sort(([a], [b]) => a.localeCompare(b));
  const updateQueries = useQueries({
    queries: sourceList.map(([source, ids]) => ({
      queryKey: queryKeys.devSetupUpdatesFor(source, ids, updateRound),
      queryFn: async (): Promise<Record<DevItemId, DevUpdateCheck>> => {
        // Only the first ask of a round is forced. Later ones (after an update finished) are
        // answered from what main remembers, which is already fresh for the item that changed.
        const mark = `${updateRound}:${source}`;
        const force = updateRound > 0 && !forcedRounds.current.has(mark);
        forcedRounds.current.add(mark);
        return (await window.agentmat.devSetup.updates(ids, { force })) ?? {};
      },
      meta: { silentLoading: true },
      staleTime: UPDATES_STALE_MS,
      retry: false,
    })),
  });
  // An update handed to a terminal is looked at on its own, every few seconds, until it lands.
  const waitingUpdateIds = Object.keys(waiting).filter((id) => waiting[id]?.update);
  const waitProbes = useQueries({
    queries: waitingUpdateIds.map((id) => ({
      queryKey: queryKeys.devSetupUpdateWait(id),
      queryFn: async (): Promise<Record<DevItemId, DevUpdateCheck>> =>
        (await window.agentmat.devSetup.updates([id], { force: true })) ?? {},
      meta: { silentLoading: true },
      staleTime: 0,
      refetchInterval: POLL_MS,
      retry: false,
    })),
  });
  for (const query of [...updateQueries, ...waitProbes]) {
    if (query.data) Object.assign(knownUpdates.current, query.data);
  }
  const updates = knownUpdates.current;

  // What the installer is doing wins over a row that was only handed to the terminal.
  const jobs: Record<DevItemId, DevItemJob | undefined> = {};
  for (const id of Object.keys(waiting)) jobs[id] = { status: 'waiting-terminal' };
  Object.assign(jobs, job.items);

  const checklist = environment
    ? buildChecklist({ stacks, environment, detections, jobs, updates })
    : undefined;
  const plan =
    checklist && environment
      ? buildInstallPlan(missingItemIds(checklist.entries), checklist.entries, environment.os)
      : undefined;
  const updatePlan = checklist
    ? buildUpdatePlan(updatableItemIds(checklist.entries), checklist.entries)
    : undefined;

  // "Could not check" is only said when nothing that is installed got an answer from anyone.
  const askable = new Set(sourceList.flatMap(([, ids]) => ids));
  const installedUpdates = items
    .filter((item) => askable.has(item.id) && detections[item.id]?.state === 'found')
    .map((item) => updates[item.id]);
  let updatesStatus: UpdateStatus = 'done';
  if (updateQueries.some((query) => query.isFetching)) updatesStatus = 'checking';
  else if (
    installedUpdates.length > 0 &&
    installedUpdates.every((check) => !check || check.state === 'unknown') &&
    sourceList.length > 0
  ) {
    updatesStatus = 'failed';
  }

  // Main has already looked again at an item that finished, so this page does too, straight away.
  // For an update that includes its update check, which main has just redone for that item.
  const looked = useRef(new Set<string>());
  useEffect(() => {
    for (const id of job.completed) {
      const key = `${job.jobId}:${id}`;
      if (looked.current.has(key)) continue;
      looked.current.add(key);
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupItem(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupUpdates });
    }
  }, [job.completed, job.jobId, queryClient]);

  // The nav badge counts what is missing, so it is told when a run ends.
  useEffect(() => {
    if (!job.running && job.jobId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupPeek });
    }
  }, [job.running, job.jobId, queryClient]);

  // A row stops waiting for the terminal the moment its tool shows up. An update is different: the
  // tool was there all along, so it has arrived when there is no newer version left to get.
  const arrived = checklist
    ? Object.keys(waiting).filter((id) => {
        const state = checklist.rows.find((row) => row.item.id === id)?.state;
        return state?.kind === 'installed' && !state.update;
      })
    : [];
  const arrivedKey = arrived.join(',');
  useEffect(() => {
    if (!arrivedKey) return;
    const done = new Set(arrivedKey.split(','));
    setWaiting((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => !done.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    // The look at an update that was waiting on a terminal is about to stop, and what it found
    // is in main's memory now. Asking again reads that, so the row does not go back to the older
    // answer the page still holds.
    void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupUpdates });
  }, [arrivedKey, queryClient]);

  // ...and gives up on one that never does, so a closed terminal does not poll forever.
  const waitingCount = Object.keys(waiting).length;
  useEffect(() => {
    if (waitingCount === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setWaiting((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([, one]) => now - one.at < GIVE_UP_MS),
        );
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waitingCount]);

  function acceptAgreements(consents: ReturnType<typeof collectConsents>): Promise<boolean> {
    // The person agrees to these by pressing the button, so they are named before it runs.
    return confirmDialog({
      title: 'Accept the agreements?',
      description:
        'Installing these means you accept their terms. You can read them at the addresses below.',
      items: consents.map((consent) => ({ name: consent.title, detail: consent.url })),
      confirmLabel: 'Accept and install',
    });
  }

  /** The agreements the install would carry once every item has been looked at again. */
  async function consentsAfterRecheck(ids: readonly DevItemId[]) {
    if (!environment) return [];
    await queryClient.refetchQueries({ queryKey: queryKeys.devSetupItems });
    const fresh: Record<DevItemId, DevDetection | undefined> = {};
    for (const item of items) {
      fresh[item.id] = queryClient.getQueryData<DevDetection>(queryKeys.devSetupItem(item.id));
    }
    const rebuilt = buildChecklist({ stacks, environment, detections: fresh, jobs });
    return collectConsents(buildInstallPlan(ids, rebuilt.entries, environment.os).steps);
  }

  async function startInstall(ids: readonly DevItemId[], consented: boolean): Promise<void> {
    try {
      await window.agentmat.devSetup.install({ ids: [...ids], consented });
    } catch (error) {
      if (plainMessage(error) !== CONSENT_REQUIRED) {
        toast.error(`Could not start the install. ${plainMessage(error)}`);
        return;
      }
      // Main sees an agreement this page did not, because the machine changed since the last
      // check. Look again and ask with what the fresh list says. If it still shows none, or the
      // agreement was already accepted, there is nothing to ask, so say so without the code.
      const consents = consented ? [] : await consentsAfterRecheck(ids);
      if (consents.length === 0) {
        toast.error('Could not start the install. Refresh the list and try again.');
        return;
      }
      if (await acceptAgreements(consents)) await startInstall(ids, true);
    }
  }

  async function install(ids: readonly DevItemId[]): Promise<void> {
    const steps =
      checklist && environment
        ? buildInstallPlan(ids, checklist.entries, environment.os).steps
        : [];
    const consents = collectConsents(steps);
    if (consents.length > 0 && !(await acceptAgreements(consents))) return;
    await startInstall(ids, consents.length > 0);
  }

  function recheck(id: DevItemId): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupItem(id) });
    // A row with an update is looked at again for that too. Main redoes just this tool's check, and
    // asking the page's checks again then reads the fresh answer from its memory.
    const state = checklist?.rows.find((row) => row.item.id === id)?.state;
    if (state && hasUpdate(state)) {
      void window.agentmat.devSetup
        .updates([id], { force: true })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.devSetupUpdates }))
        .catch(() => undefined);
    }
  }

  async function update(ids: readonly DevItemId[]): Promise<void> {
    try {
      // No agreement to accept: that was done when the tool was installed.
      await window.agentmat.devSetup.install({ ids: [...ids], intent: 'update' });
    } catch (error) {
      toast.error(`Could not start the update. ${plainMessage(error)}`);
    }
  }

  return {
    environment,
    environmentFailed: environmentQuery.isError && !environment,
    retryEnvironment: () => {
      void environmentQuery.refetch();
    },
    stacks,
    toggleStack: (id) => {
      const stack = DEV_STACKS.find((one) => one.id === id);
      // Essentials is always on, and an id from nowhere is not a stack.
      if (!stack || stack.alwaysOn) return;
      const next = stacks.includes(stack.id)
        ? stacks.filter((one) => one !== stack.id)
        : [...stacks, stack.id];
      saveStacks.mutate(normalizeDevSetupStacks(next));
    },
    checklist,
    job,
    plan,
    updatePlan,
    updatesStatus,
    install,
    installAll: () => install(checklist ? missingItemIds(checklist.entries) : []),
    update,
    // Only what the app can run itself. The rest is left for the person, and the button says so.
    updateAll: () => update(updatePlan?.steps ?? []),
    cancel: (id) => {
      void window.agentmat.devSetup.cancel(id);
    },
    recheck,
    recheckAll: () => {
      // The machine too: a package manager may have been installed since the page opened.
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupEnvironment });
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupItems });
      // And the update checks, which this time ask their sources again rather than main's memory.
      setUpdateRound((round) => round + 1);
    },
    openInTerminal: ({ id, name, command, intent }) => {
      const updating = intent === 'update';
      // The command is typed in but not run: the person reads it and presses Enter themselves.
      useTerminalStore.getState().openSession({
        title: `${updating ? 'Update' : 'Install'} ${name}`,
        initialInput: command,
      });
      toast.info(`Press Enter in the terminal to ${updating ? 'update' : 'install'} ${name}.`);
      setWaiting((current) => ({ ...current, [id]: { at: Date.now(), update: updating } }));
    },
    copyCommand: async ({ name, command }) => {
      try {
        await navigator.clipboard.writeText(command);
        toast.success(`Copied the command for ${name}.`);
      } catch {
        toast.error('Could not copy. Select the command and copy it by hand.');
      }
    },
    addToPath: async ({ id, name }) => {
      try {
        const { changed, where } = await window.agentmat.devSetup.addToPath(id);
        if (changed) toast.success(`Added ${name} to ${where}. Open a new terminal to use it.`);
        else toast.info(`${name} is already on your PATH.`);
        // The row drops its warning once the fresh check finds the tool on the PATH.
        recheck(id);
      } catch (error) {
        toast.error(`Could not add ${name} to your PATH. ${plainMessage(error)}`);
        // Main looked at the tool just before refusing, so the row may still show the old state.
        recheck(id);
      }
    },
  };
}
