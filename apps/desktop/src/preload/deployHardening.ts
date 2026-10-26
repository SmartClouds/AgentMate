import { ipcRenderer } from 'electron';
import type {
  SecurityChecklist,
  SshHardeningChangeInfo,
  SshHardeningPreview,
} from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployBackupFile,
  DeployBackupInput,
  DeployBackupResult,
  DeployRestoreInput,
  DeployRestoreProgressEvent,
  DeployRestoreResult,
  DeploySshDecisionInput,
  DeploySshHardeningInput,
  DeploySshProgressEvent,
} from '../shared/deployHardeningTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * The Security center of a server (E15): the checklist with its score, the SSH fixes (previewed,
 * applied over a new key login, then kept over another or reverted), backups saved where the user
 * picks, and restores over SSH. A missing role comes back as `[core:forbidden]`; a missing step-up
 * as SignalR's "unauthorized", which the step-up hook asks about.
 */
export function createDeployHardening(subscribe: Subscribe) {
  return {
    checklist: (serverId: string): Promise<SecurityChecklist> =>
      ipcRenderer.invoke(IPC.deployHardening.checklist, serverId),
    previewSsh: (input: DeploySshHardeningInput): Promise<SshHardeningPreview> =>
      ipcRenderer.invoke(IPC.deployHardening.previewSsh, input),
    applySsh: (input: DeploySshHardeningInput): Promise<SshHardeningChangeInfo> =>
      ipcRenderer.invoke(IPC.deployHardening.applySsh, input),
    confirmSsh: (input: DeploySshDecisionInput): Promise<SshHardeningChangeInfo> =>
      ipcRenderer.invoke(IPC.deployHardening.confirmSsh, input),
    revertSsh: (input: DeploySshDecisionInput): Promise<SshHardeningChangeInfo> =>
      ipcRenderer.invoke(IPC.deployHardening.revertSsh, input),
    onSshProgress: (callback: (event: DeploySshProgressEvent) => void): (() => void) =>
      subscribe(IPC.deployHardening.onSshProgress, callback),
    /** Asks where to save first; `saved: false` when that was cancelled. */
    createBackup: (input: DeployBackupInput): Promise<DeployBackupResult> =>
      ipcRenderer.invoke(IPC.deployHardening.createBackup, input),
    /** The open dialog; null when cancelled. The file is named by a token from here on. */
    pickBackup: (): Promise<DeployBackupFile | null> =>
      ipcRenderer.invoke(IPC.deployHardening.pickBackup),
    restore: (input: DeployRestoreInput): Promise<DeployRestoreResult> =>
      ipcRenderer.invoke(IPC.deployHardening.restore, input),
    onRestoreProgress: (callback: (event: DeployRestoreProgressEvent) => void): (() => void) =>
      subscribe(IPC.deployHardening.onRestoreProgress, callback),
  };
}
