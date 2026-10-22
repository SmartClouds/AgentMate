import type {
  BackupDestinationKind,
  BackupRunInfo,
  SaveBackupDestinationRequest,
  ServerRestoreStatus,
} from './deploy/protocol/generated/AgentMate.ServerCore.Contracts';

/**
 * The Backups section of a Deploy server (E28): IPC shapes the core's own contracts do not cover.
 * The core makes, encrypts, uploads, prunes and lists backups; the app owns the screens, the
 * Google Drive and OneDrive sign-in, downloads to this computer and the restore wizard. A
 * destination's credentials go straight to the core and are never read back, and a cloud drive's
 * refresh token never reaches the renderer.
 */

/** Optional proof for a call that needs a step-up, sent with it so the core takes it at once. */
export interface DeployBackupProof {
  password?: string;
  totpCode?: string;
}

export interface DeployBackupSecretInput {
  serverId: string;
  /** Needed to change a secret that is already set. */
  currentSecret?: string;
  newSecret: string;
}

export interface DeployBackupDestinationInput {
  serverId: string;
  destination: SaveBackupDestinationRequest;
}

export interface DeployBackupItemInput {
  serverId: string;
  id: string;
}

export interface DeployStoredBackupInput {
  serverId: string;
  destinationId: string;
  backupId: string;
}

export type DeployCloudDriveKind = Extract<BackupDestinationKind, 'googleDrive' | 'oneDrive'>;

/** Signs in to the user's own OAuth client in the browser, then saves the destination. */
export interface DeployCloudDriveInput {
  serverId: string;
  /** Set to sign in again for a destination that exists. */
  destinationId?: string;
  name: string;
  kind: DeployCloudDriveKind;
  clientId: string;
  /** Google's Desktop clients have one; OneDrive's public clients do not. */
  clientSecret?: string;
  folderName: string;
  maxPartBytes?: number;
}

export interface DeployBackupNowInput {
  serverId: string;
  destinationIds: string[];
  /** Also save the backup on this computer; the save dialog comes first. */
  download: boolean;
}

export interface DeployBackupNowResult {
  /** False when the save dialog was cancelled; nothing was made then. */
  started: boolean;
  run?: BackupRunInfo;
}

export interface DeployBackupRunInput {
  serverId: string;
  runId: string;
}

export interface DeployBackupDownload {
  /** False when the save dialog was cancelled. */
  saved: boolean;
  path?: string;
  sizeBytes?: number;
  /** Set when the run went well but saving it here did not. */
  error?: string;
}

export interface DeployBackupWatchResult {
  run: BackupRunInfo;
  /** Present when the run was started with `download`. */
  download?: DeployBackupDownload;
}

/** main -> the main window: a run as it stands, and how far its download is. */
export interface DeployBackupRunEvent {
  serverId: string;
  run: BackupRunInfo;
  downloadedBytes?: number;
}

export interface DeployTelegramStartInput {
  serverId: string;
  apiId: number;
  apiHash: string;
  phoneNumber: string;
}

export interface DeployTelegramContinueInput {
  serverId: string;
  loginId: string;
  code?: string;
  password?: string;
}

/** Where the backup to restore comes from. */
export type DeployServerRestoreSource =
  | {
      kind: 'destination';
      /** The server whose destination holds it; it may differ from the one restored onto. */
      serverId: string;
      destinationId: string;
      backupId: string;
    }
  /** A file on this computer, named by the token pickFile gave out. */
  | { kind: 'file'; fileToken: string };

export interface DeployServerRestoreInput {
  /** The server restored onto. */
  serverId: string;
  source: DeployServerRestoreSource;
  /** The secret key the backup was made under (or a format 1 backup's passphrase). */
  secret: string;
  /** The sudo password; null falls back to the saved login password, if there is one. */
  sudoPassword: string | null;
  /** An Owner in the backup this computer enrolls as, and their password. */
  userName: string;
  password: string;
}

export type DeployServerRestorePhase =
  | 'fetch'
  | 'download'
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

export interface DeployServerRestoreProgress {
  phase: DeployServerRestorePhase;
  title: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  percent?: number;
}

/** main -> the main window: a step of the restore, or how bringing the server up stands. */
export type DeployServerRestoreEvent =
  | { serverId: string; kind: 'step'; progress: DeployServerRestoreProgress }
  | { serverId: string; kind: 'bringUp'; status: ServerRestoreStatus };

export interface DeployServerRestoreResult {
  backupCoreVersion: string;
  backupHostName: string;
  backupCreatedAtUnixMs: number;
  previousStateFolder: string;
  /** Set when the core runs the backup but this computer could not sign in yet. */
  signInError?: string;
}

export interface DeployBringUpInput extends DeployBackupProof {
  serverId: string;
  /** Move every setting that named the old address to this server's address. */
  moveAddresses: boolean;
}

export type DeployMovedRecordArea = 'server' | 'healthCheck' | 'fileSite' | 'wordpressSite';

/** One of this computer's own records that named the old address and now names the new one. */
export interface DeployMovedRecord {
  area: DeployMovedRecordArea;
  name: string;
  from: string;
  to: string;
  /** A trusted host key or certificate pin was dropped, so the next connection asks again. */
  trustReset?: boolean;
}

export interface DeployBringUpResult {
  status: ServerRestoreStatus;
  /** This computer's records that were moved to the new address. */
  moved: DeployMovedRecord[];
  /** Set when the core finished but moving this computer's records failed. */
  movedError?: string;
}
