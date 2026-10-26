import type { BackupContents } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Security center's IPC shapes (E15): the checklist, its SSH fixes, and backups. SSH changes
 * run like firewall changes: previewed and applied over a brand-new SSH connection that signs in
 * with this computer's key, then kept over another new one, or reverted. Backups are encrypted on
 * the server with the user's passphrase and saved where the user picks; a restore runs over SSH as
 * root, so it also works on a new server.
 */

export interface DeploySshHardeningInput {
  serverId: string;
  disablePasswordLogin: boolean;
  restrictRootLogin: boolean;
}

export interface DeploySshDecisionInput {
  serverId: string;
  changeId: string;
}

export type DeploySshOperation = 'apply' | 'confirm' | 'revert';

export type DeploySshStep =
  | 'checkingLogin'
  | 'openingConnection'
  | 'applying'
  | 'confirming'
  | 'reverting';

export type DeploySshStepState = 'running' | 'done' | 'failed';

/** main -> the main window: one step of an SSH change. */
export interface DeploySshProgressEvent {
  serverId: string;
  operation: DeploySshOperation;
  step: DeploySshStep;
  state: DeploySshStepState;
  changeId?: string;
  message?: string;
  atUnixMs: number;
}

export interface DeployBackupInput {
  serverId: string;
  passphrase: string;
}

export interface DeployBackupResult {
  /** False when the save dialog was cancelled; nothing was made then. */
  saved: boolean;
  path?: string;
  sizeBytes?: number;
  sha256?: string;
  contents?: BackupContents;
}

/** A backup file the user picked to restore, known to the main process by its token only. */
export interface DeployBackupFile {
  token: string;
  name: string;
  sizeBytes: number;
}

export interface DeployRestoreInput {
  serverId: string;
  /** From pickBackup: the renderer never names a file path itself. */
  fileToken: string;
  passphrase: string;
  /** The sudo password; null falls back to the saved login password, if there is one. */
  sudoPassword: string | null;
  /** A user of the restored core this computer enrolls as, and its password, to sign in after. */
  userName: string;
  password: string;
}

export type DeployRestorePhase =
  | 'upload'
  | 'stage'
  | 'stop'
  | 'swap'
  | 'start'
  | 'health'
  | 'enroll'
  | 'sign-in'
  | 'rollback'
  | 'cleanup';

export interface DeployRestoreProgress {
  phase: DeployRestorePhase;
  title: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  percent?: number;
}

/** main -> the main window: one step of a restore. */
export interface DeployRestoreProgressEvent {
  serverId: string;
  progress: DeployRestoreProgress;
}

export interface DeployRestoreResult {
  /** The core version and server the backup came from, and when it was made. */
  backupCoreVersion: string;
  backupHostName: string;
  backupCreatedAtUnixMs: number;
  /** Where the server's state before the restore was kept, root only, for a look by hand. */
  previousStateFolder: string;
  /** Set when the core runs the backup but this computer could not sign in yet. */
  signInError?: string;
}
