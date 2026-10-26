import { coreErrorCode } from '@shared/coreErrors';
import type {
  DeployAccountInput,
  DeployCoreUpdateResult,
  DeployInstallResult,
  DeploySetupPhase,
  DeploySetupProgress,
  DeploySetupProgressEvent,
} from '@shared/deployTypes';
import { type SshErrorCode, sshErrorCode, sshErrorMessage } from '@shared/sshErrors';
import { create } from 'zustand';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';

/**
 * Installs, updates and removals of the server core, per server. They keep running in the main
 * process when the Deploy page is left, so their progress lives here and the page picks it up again.
 */

/** A step-up the core asked for, or the password or code that answers one. */
export interface UpdateProof {
  password?: string;
  totpCode?: string;
}

export interface SetupRun {
  kind: 'install' | 'uninstall' | 'update';
  planned: DeploySetupPhase[];
  events: DeploySetupProgress[];
  status: 'running' | 'done' | 'failed';
  error: string | null;
  errorCode: SshErrorCode | null;
  result: DeployInstallResult | null;
  /** For a removal: whether the core's data stays on the server. */
  keepData?: boolean;
  /** For an update through the core: how it ended. */
  update?: DeployCoreUpdateResult;
}

interface DeploySetupState {
  runs: Record<string, SetupRun>;
  /** Resolves with the result, or null when the install failed or one was already running. */
  install: (
    serverId: string,
    planned: DeploySetupPhase[],
    sudoPassword: string | null,
    account?: DeployAccountInput,
  ) => Promise<DeployInstallResult | null>;
  /** Resolves true once the core is gone. */
  uninstall: (serverId: string, keepData: boolean, sudoPassword: string | null) => Promise<boolean>;
  /**
   * Updates the core through the core itself (no SSH). A step-up the core wants is thrown, with
   * no run left behind, so the caller can ask for the password and try again. A core that cannot
   * replace itself ends the run as failed with `update.outcome` set to `needs-ssh`.
   */
  updateCore: (
    serverId: string,
    planned: DeploySetupPhase[],
    proof?: UpdateProof,
  ) => Promise<DeployCoreUpdateResult | null>;
  clear: (serverId: string) => void;
}

export const useDeploySetupStore = create<DeploySetupState>((set, get) => {
  const update = (serverId: string, change: (run: SetupRun) => Partial<SetupRun>): void =>
    set((state) => {
      const run = state.runs[serverId];
      return run ? { runs: { ...state.runs, [serverId]: { ...run, ...change(run) } } } : state;
    });

  async function start<T>(
    serverId: string,
    kind: SetupRun['kind'],
    planned: DeploySetupPhase[],
    call: () => Promise<T>,
    extra: Partial<SetupRun> = {},
    finish: (value: T) => Partial<SetupRun> = () => ({}),
    rethrow: (error: unknown) => boolean = () => false,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (get().runs[serverId]?.status === 'running') return { ok: false };
    set((state) => ({
      runs: {
        ...state.runs,
        [serverId]: {
          kind,
          planned,
          events: [],
          status: 'running',
          error: null,
          errorCode: null,
          result: null,
          ...extra,
        },
      },
    }));
    const stop = window.runova.deploy.onSetupProgress((event: DeploySetupProgressEvent) => {
      if (event.serverId !== serverId) return;
      update(serverId, (run) => ({ events: [...run.events, event.progress] }));
    });
    try {
      const value = await withHostKeyTrust(serverId, call);
      // One update, so whoever sees 'done' also sees the result. The result may say it failed.
      update(serverId, () => ({ status: 'done', ...finish(value) }));
      return { ok: true, value };
    } catch (error) {
      if (rethrow(error)) {
        get().clear(serverId);
        throw error;
      }
      update(serverId, () => ({
        status: 'failed',
        error: sshErrorMessage(error),
        errorCode: sshErrorCode(error),
      }));
      return { ok: false };
    } finally {
      stop();
    }
  }

  return {
    runs: {},
    install: async (serverId, planned, sudoPassword, account) => {
      const outcome = await start(
        serverId,
        'install',
        planned,
        () =>
          window.runova.deploy.install({
            serverId,
            sudoPassword,
            ...(account ? { account } : {}),
          }),
        {},
        (result) => ({ result }),
      );
      return outcome.ok ? outcome.value : null;
    },
    uninstall: async (serverId, keepData, sudoPassword) => {
      const outcome = await start(
        serverId,
        'uninstall',
        ['stop', 'remove'],
        () => window.runova.deploy.uninstall({ serverId, keepData, sudoPassword }),
        { keepData },
      );
      return outcome.ok;
    },
    updateCore: async (serverId, planned, proof) => {
      const outcome = await start(
        serverId,
        'update',
        planned,
        () => window.runova.deploy.updateCore({ serverId, ...proof }),
        {},
        (update): Partial<SetupRun> =>
          update.outcome === 'needs-ssh'
            ? { update, status: 'failed', error: update.reason }
            : { update },
        (error) => coreErrorCode(error) === 'stepUpRequired',
      );
      return outcome.ok ? outcome.value : null;
    },
    clear: (serverId) =>
      set((state) => {
        const { [serverId]: _cleared, ...rest } = state.runs;
        return { runs: rest };
      }),
  };
});
