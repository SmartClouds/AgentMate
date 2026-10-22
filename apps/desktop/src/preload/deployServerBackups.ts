import { ipcRenderer } from 'electron';
import type {
  BackupDestinationInfo,
  BackupDestinationTest,
  BackupPlanInfo,
  BackupPlanPreview,
  BackupPlanPreviewRequest,
  BackupRunInfo,
  BackupSecretStatus,
  PendingServerRestore,
  SaveBackupPlanRequest,
  ServerRestoreStatus,
  StoredBackupInfo,
  TelegramLoginState,
} from '../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployBackupFile } from '../shared/deployHardeningTypes';
import type {
  DeployBackupDestinationInput,
  DeployBackupDownload,
  DeployBackupItemInput,
  DeployBackupNowInput,
  DeployBackupNowResult,
  DeployBackupRunEvent,
  DeployBackupRunInput,
  DeployBackupSecretInput,
  DeployBackupWatchResult,
  DeployBringUpInput,
  DeployBringUpResult,
  DeployCloudDriveInput,
  DeployServerRestoreEvent,
  DeployServerRestoreInput,
  DeployServerRestoreResult,
  DeployStoredBackupInput,
  DeployTelegramContinueInput,
  DeployTelegramStartInput,
} from '../shared/deployServerBackupsTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * A server's Backups section (E28). Owners only. The changes may need a step-up
 * (`[core:stepUpRequired]`, which useStepUp answers). Credentials only go in; a cloud drive's
 * refresh token never comes out here.
 */
export function createDeployServerBackups(subscribe: Subscribe) {
  return {
    getSecret: (serverId: string): Promise<BackupSecretStatus> =>
      ipcRenderer.invoke(IPC.deployServerBackups.getSecret, serverId),
    setSecret: (input: DeployBackupSecretInput): Promise<BackupSecretStatus> =>
      ipcRenderer.invoke(IPC.deployServerBackups.setSecret, input),
    listDestinations: (serverId: string): Promise<BackupDestinationInfo[]> =>
      ipcRenderer.invoke(IPC.deployServerBackups.listDestinations, serverId),
    saveDestination: (input: DeployBackupDestinationInput): Promise<BackupDestinationInfo> =>
      ipcRenderer.invoke(IPC.deployServerBackups.saveDestination, input),
    deleteDestination: (input: DeployBackupItemInput): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployServerBackups.deleteDestination, input),
    testDestination: (input: DeployBackupDestinationInput): Promise<BackupDestinationTest> =>
      ipcRenderer.invoke(IPC.deployServerBackups.testDestination, input),
    /** Opens the browser to sign in, then saves the destination. Up to five minutes. */
    connectCloudDrive: (input: DeployCloudDriveInput): Promise<BackupDestinationInfo> =>
      ipcRenderer.invoke(IPC.deployServerBackups.connectCloudDrive, input),
    cancelCloudSignIn: (serverId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployServerBackups.cancelCloudSignIn, serverId),
    startTelegramLogin: (input: DeployTelegramStartInput): Promise<TelegramLoginState> =>
      ipcRenderer.invoke(IPC.deployServerBackups.startTelegramLogin, input),
    continueTelegramLogin: (input: DeployTelegramContinueInput): Promise<TelegramLoginState> =>
      ipcRenderer.invoke(IPC.deployServerBackups.continueTelegramLogin, input),
    listPlans: (serverId: string): Promise<BackupPlanInfo[]> =>
      ipcRenderer.invoke(IPC.deployServerBackups.listPlans, serverId),
    savePlan: (input: { serverId: string; plan: SaveBackupPlanRequest }): Promise<BackupPlanInfo> =>
      ipcRenderer.invoke(IPC.deployServerBackups.savePlan, input),
    deletePlan: (input: DeployBackupItemInput): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployServerBackups.deletePlan, input),
    previewPlan: (input: {
      serverId: string;
      preview: BackupPlanPreviewRequest;
    }): Promise<BackupPlanPreview> =>
      ipcRenderer.invoke(IPC.deployServerBackups.previewPlan, input),
    runPlan: (input: DeployBackupItemInput): Promise<BackupRunInfo> =>
      ipcRenderer.invoke(IPC.deployServerBackups.runPlan, input),
    /** For a copy on this computer the save dialog comes first; `started: false` when cancelled. */
    runNow: (input: DeployBackupNowInput): Promise<DeployBackupNowResult> =>
      ipcRenderer.invoke(IPC.deployServerBackups.runNow, input),
    listRuns: (serverId: string, limit: number): Promise<BackupRunInfo[]> =>
      ipcRenderer.invoke(IPC.deployServerBackups.listRuns, serverId, limit),
    getRun: (input: DeployBackupRunInput): Promise<BackupRunInfo | null> =>
      ipcRenderer.invoke(IPC.deployServerBackups.getRun, input),
    /** Follows a run until it ends (onRunProgress on the way) and saves it here when asked to. */
    watchRun: (input: DeployBackupRunInput): Promise<DeployBackupWatchResult> =>
      ipcRenderer.invoke(IPC.deployServerBackups.watchRun, input),
    stopWatchingRun: (input: DeployBackupRunInput): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployServerBackups.stopWatchingRun, input),
    downloadRun: (input: DeployBackupRunInput): Promise<DeployBackupDownload> =>
      ipcRenderer.invoke(IPC.deployServerBackups.downloadRun, input),
    onRunProgress: (callback: (event: DeployBackupRunEvent) => void): (() => void) =>
      subscribe(IPC.deployServerBackups.onRunProgress, callback),
    listStored: (input: DeployBackupItemInput): Promise<StoredBackupInfo[]> =>
      ipcRenderer.invoke(IPC.deployServerBackups.listStored, input),
    deleteStored: (input: DeployStoredBackupInput): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployServerBackups.deleteStored, input),
    downloadStored: (input: DeployStoredBackupInput): Promise<DeployBackupDownload> =>
      ipcRenderer.invoke(IPC.deployServerBackups.downloadStored, input),
    /** The open dialog; null when cancelled. The file is named by a token from here on. */
    pickFile: (): Promise<DeployBackupFile | null> =>
      ipcRenderer.invoke(IPC.deployServerBackups.pickFile),
    restore: (input: DeployServerRestoreInput): Promise<DeployServerRestoreResult> =>
      ipcRenderer.invoke(IPC.deployServerBackups.restore, input),
    pendingRestore: (serverId: string): Promise<PendingServerRestore | null> =>
      ipcRenderer.invoke(IPC.deployServerBackups.pendingRestore, serverId),
    restoreStatus: (serverId: string): Promise<ServerRestoreStatus | null> =>
      ipcRenderer.invoke(IPC.deployServerBackups.restoreStatus, serverId),
    bringUp: (input: DeployBringUpInput): Promise<DeployBringUpResult> =>
      ipcRenderer.invoke(IPC.deployServerBackups.bringUp, input),
    onRestoreProgress: (callback: (event: DeployServerRestoreEvent) => void): (() => void) =>
      subscribe(IPC.deployServerBackups.onRestoreProgress, callback),
  };
}
