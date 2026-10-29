import { coreErrorMessage } from '@shared/coreErrors';
import type {
  BackupRunInfo,
  ServerRestoreStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployRestoreProgress, DeployRestoreResult } from '@shared/deployHardeningTypes';
import type {
  DeployBackupDownload,
  DeployBackupNowResult,
  DeployBringUpResult,
  DeployServerRestoreProgress,
  DeployServerRestoreResult,
} from '@shared/deployServerBackupsTypes';
import { toast } from 'sonner';
import { create } from 'zustand';

/**
 * Back up now and a restore (E28), per server whose Backups section started them, and a restore
 * of the core's own backup over SSH from the Security area. They go on in the main process and on
 * the server when the Deploy page is left, so their progress is followed from here and the
 * section shows where they got to when it comes back.
 */

export interface BackupNow {
  /** The Back up now dialog is open; kept so it opens again over a run that is still going. */
  open: boolean;
  busy: boolean;
  run: BackupRunInfo | null;
  downloaded: number | null;
  saved: DeployBackupDownload | null;
  problem: string | null;
}

export type RestorePhase = 'form' | 'restoring' | 'pending' | 'bringingUp' | 'done';

export interface ServerRestore {
  /** The server restored onto, which may be another than the one whose section this is. */
  targetId: string;
  phase: RestorePhase;
  steps: DeployServerRestoreProgress[];
  bringUpStatus: ServerRestoreStatus | null;
  result: DeployBringUpResult | null;
  problem: string | null;
}

/** A restore of the core's own backup over SSH, from the Security area. */
export interface CoreRestore {
  /** The Restore dialog is open; kept so it opens again over a restore that is still going. */
  open: boolean;
  busy: boolean;
  steps: DeployRestoreProgress[];
  problem: string | null;
  result: DeployRestoreResult | null;
}

const NO_CORE_RESTORE: CoreRestore = {
  open: false,
  busy: false,
  steps: [],
  problem: null,
  result: null,
};

const NO_BACKUP: BackupNow = {
  open: false,
  busy: false,
  run: null,
  downloaded: null,
  saved: null,
  problem: null,
};

function fold<Step extends { phase: string; title: string }>(steps: Step[], event: Step): Step[] {
  const key = `${event.phase}:${event.title}`;
  const at = steps.findIndex((step) => `${step.phase}:${step.title}` === key);
  return at < 0 ? [...steps, event] : steps.map((step, index) => (index === at ? event : step));
}

interface DeployBackupRunState {
  backups: Record<string, BackupNow>;
  restores: Record<string, ServerRestore>;
  coreRestores: Record<string, CoreRestore>;
  /** Opens or closes the dialog. Closing it forgets a backup that is over. */
  setOpen: (serverId: string, open: boolean) => void;
  /** Starts the backup through `launch` (which may ask for a step-up), then follows it. */
  backUp: (
    serverId: string,
    launch: () => Promise<DeployBackupNowResult | undefined>,
    refresh?: () => void,
  ) => Promise<void>;
  setRestorePhase: (serverId: string, targetId: string, phase: RestorePhase) => void;
  setRestoreProblem: (serverId: string, targetId: string, problem: string | null) => void;
  /** Restores onto `targetId`, folding its steps, then waits for it to be brought up. */
  restore: (
    serverId: string,
    targetId: string,
    call: () => Promise<DeployServerRestoreResult | undefined>,
    after?: () => Promise<void>,
  ) => Promise<void>;
  /** Brings the restored server up, following its status. */
  bringUp: (
    serverId: string,
    call: () => Promise<DeployBringUpResult | undefined>,
    after?: () => void,
  ) => Promise<void>;
  /** Opens or closes the core's Restore dialog. Closing it forgets a restore that is over. */
  setCoreRestoreOpen: (serverId: string, open: boolean) => void;
  setCoreRestoreProblem: (serverId: string, problem: string | null) => void;
  /** Restores the core's backup over SSH, folding its steps. */
  restoreCore: (
    serverId: string,
    call: () => Promise<DeployRestoreResult>,
    after?: () => void,
  ) => Promise<void>;
}

export const useDeployBackupRunStore = create<DeployBackupRunState>((set, get) => {
  const patchBackup = (serverId: string, change: Partial<BackupNow>): void =>
    set((state) => ({
      backups: {
        ...state.backups,
        [serverId]: { ...(state.backups[serverId] ?? NO_BACKUP), ...change },
      },
    }));
  const patchRestore = (
    serverId: string,
    change: (restore: ServerRestore) => Partial<ServerRestore>,
  ): void =>
    set((state) => {
      const restore = state.restores[serverId];
      return restore
        ? { restores: { ...state.restores, [serverId]: { ...restore, ...change(restore) } } }
        : state;
    });
  /** Changes the restore onto `targetId`; one onto another server starts afresh. */
  const startRestore = (serverId: string, targetId: string, change: Partial<ServerRestore>) =>
    set((state) => {
      const kept = state.restores[serverId];
      const base: ServerRestore =
        kept?.targetId === targetId
          ? kept
          : {
              targetId,
              phase: 'form',
              steps: [],
              bringUpStatus: null,
              result: null,
              problem: null,
            };
      return { restores: { ...state.restores, [serverId]: { ...base, ...change } } };
    });
  /** The restore's events for the server restored onto, while one call runs. */
  const followRestore = (serverId: string, targetId: string) =>
    window.runova.deployServerBackups.onRestoreProgress((event) => {
      if (event.serverId !== targetId) return;
      if (event.kind === 'step') {
        patchRestore(serverId, (restore) => ({ steps: fold(restore.steps, event.progress) }));
      } else {
        patchRestore(serverId, () => ({ bringUpStatus: event.status }));
      }
    });

  const patchCore = (serverId: string, change: (restore: CoreRestore) => Partial<CoreRestore>) =>
    set((state) => {
      const restore = state.coreRestores[serverId] ?? NO_CORE_RESTORE;
      return {
        coreRestores: { ...state.coreRestores, [serverId]: { ...restore, ...change(restore) } },
      };
    });

  return {
    backups: {},
    restores: {},
    coreRestores: {},
    setCoreRestoreOpen: (serverId, open) => {
      const restore = get().coreRestores[serverId];
      if (restore?.busy) {
        patchCore(serverId, () => ({ open: true }));
      } else if (open) {
        patchCore(serverId, () => ({ ...NO_CORE_RESTORE, open: true }));
      } else {
        set((state) => {
          const { [serverId]: _gone, ...rest } = state.coreRestores;
          return { coreRestores: rest };
        });
      }
    },
    setCoreRestoreProblem: (serverId, problem) => patchCore(serverId, () => ({ problem })),
    restoreCore: async (serverId, call, after) => {
      if (get().coreRestores[serverId]?.busy) return;
      patchCore(serverId, () => ({ busy: true, problem: null, steps: [], result: null }));
      const stop = window.runova.deployHardening.onRestoreProgress((event) => {
        if (event.serverId !== serverId) return;
        const entry: DeployRestoreProgress = {
          phase: event.progress.phase,
          title: event.progress.title,
          status: event.progress.status,
          ...(event.progress.detail ? { detail: event.progress.detail } : {}),
        };
        patchCore(serverId, (restore) => ({ steps: fold(restore.steps, entry) }));
      });
      try {
        const result = await call();
        patchCore(serverId, () => ({ result }));
      } catch (error) {
        patchCore(serverId, () => ({ problem: coreErrorMessage(error) }));
      } finally {
        stop();
        patchCore(serverId, () => ({ busy: false }));
        after?.();
      }
    },
    setOpen: (serverId, open) => {
      const backup = get().backups[serverId];
      if (!open && backup && !backup.busy) {
        set((state) => {
          const { [serverId]: _gone, ...rest } = state.backups;
          return { backups: rest };
        });
        return;
      }
      if (open && backup && !backup.busy) {
        patchBackup(serverId, { ...NO_BACKUP, open: true });
        return;
      }
      patchBackup(serverId, { open });
    },
    backUp: async (serverId, launch, refresh) => {
      if (get().backups[serverId]?.busy) return;
      patchBackup(serverId, { busy: true, problem: null });
      const stop = window.runova.deployServerBackups.onRunProgress((event) => {
        if (event.serverId !== serverId) return;
        const current = get().backups[serverId]?.run;
        patchBackup(serverId, {
          ...(current && current.id === event.run.id ? { run: event.run } : {}),
          ...(event.downloadedBytes !== undefined ? { downloaded: event.downloadedBytes } : {}),
        });
      });
      try {
        const started = await launch();
        if (!started?.started || !started.run) return;
        patchBackup(serverId, { run: started.run });
        refresh?.();
        const watched = await window.runova.deployServerBackups.watchRun({
          serverId,
          runId: started.run.id,
        });
        patchBackup(serverId, { run: watched.run, saved: watched.download ?? null });
        if (watched.download?.saved) toast.success(`Backup saved to ${watched.download.path}`);
      } catch (error) {
        patchBackup(serverId, { problem: coreErrorMessage(error) });
      } finally {
        stop();
        patchBackup(serverId, { busy: false });
        refresh?.();
      }
    },
    setRestorePhase: (serverId, targetId, phase) => startRestore(serverId, targetId, { phase }),
    setRestoreProblem: (serverId, targetId, problem) =>
      startRestore(serverId, targetId, { problem }),
    restore: async (serverId, targetId, call, after) => {
      startRestore(serverId, targetId, { phase: 'restoring', steps: [], problem: null });
      const stop = followRestore(serverId, targetId);
      try {
        const restored = await call();
        if (!restored) {
          patchRestore(serverId, () => ({ phase: 'form' }));
          return;
        }
        await after?.();
        patchRestore(serverId, () => ({ phase: 'pending' }));
      } catch (error) {
        patchRestore(serverId, () => ({ phase: 'form', problem: coreErrorMessage(error) }));
      } finally {
        stop();
      }
    },
    bringUp: async (serverId, call, after) => {
      const targetId = get().restores[serverId]?.targetId;
      if (!targetId) return;
      patchRestore(serverId, () => ({ phase: 'bringingUp', problem: null, bringUpStatus: null }));
      const stop = followRestore(serverId, targetId);
      try {
        const done = await call();
        if (!done) {
          patchRestore(serverId, () => ({ phase: 'pending' }));
          return;
        }
        patchRestore(serverId, () => ({
          phase: 'done',
          result: done,
          bringUpStatus: done.status,
        }));
        after?.();
      } catch (error) {
        patchRestore(serverId, () => ({ phase: 'pending', problem: coreErrorMessage(error) }));
      } finally {
        stop();
      }
    },
  };
});
