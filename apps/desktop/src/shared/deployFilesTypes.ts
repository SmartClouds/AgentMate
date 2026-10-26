import type {
  ConflictReason,
  LocalChange,
  PlanAction,
  RemoteObservation,
  RemoteVerdict,
} from '@runova/core';
import type { SshAuthMethod } from './apiTypes';
import type { FilesErrorCode } from './deployFilesErrors';

/**
 * FTP and SFTP sites in Deploy (E23): a local deploy folder sent to a folder on a server, with the
 * changes since the last deploy reviewed first. A stored password or key passphrase never crosses
 * IPC: the renderer sends a new one in and only ever learns whether there is one.
 */

export type FileSiteProtocol = 'sftp' | 'ftps' | 'ftp';

/** A login of the site's own. `authMethod` is always `password` for FTP and FTPS. */
export interface FileSiteCustomLogin {
  kind: 'custom';
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** SFTP with `privateKey` only. */
  privateKeyPath: string | null;
  /** SFTP: the SHA-256 host key fingerprint the user trusted (64 hex digits). */
  hostKeyFingerprint: string | null;
  /** FTPS: the SHA-256 fingerprint of a certificate the user trusted although it failed the checks. */
  tlsPin: string | null;
  /** FTPS: the name the certificate is checked against, when it is not `host` (shared hosts). */
  tlsServername: string | null;
}

export type FileSiteConnection =
  /** SFTP through a server saved in Remote: its login and its pinned host key. */
  { kind: 'saved'; sshServerId: string } | (FileSiteCustomLogin & { hasSecret: boolean });

export type FileSiteConnectionInput =
  | { kind: 'saved'; sshServerId: string }
  | (FileSiteCustomLogin & {
      /** The password or key passphrase just typed. Left out on an edit, the stored one stays. */
      secret?: string;
    });

/** What Test connection learned about the server. */
export interface FileSiteCapabilities {
  /** A file can be replaced in one step (rename over the old one). */
  atomicReplace: boolean;
  /** How a file's time on the server is read: exactly, per file with MDTM, or not at all. */
  mtime: 'exact' | 'mdtm' | 'none';
  checkedAt: number;
}

export type FilesRunState = 'done' | 'partial' | 'failed' | 'cancelled';
export type FilesRunTrigger = 'user' | 'deployOnSave';

export interface FileSiteLastDeploy {
  at: number;
  state: FilesRunState;
  trigger: FilesRunTrigger;
  uploaded: number;
  deleted: number;
  failed: number;
}

/** Why Deploy on save stopped and is waiting for the user. */
export interface FilesNeedsReview {
  reason: 'conflicts' | 'massDelete' | 'failed' | 'paused';
  message: string;
  at: number;
}

export interface FileSite {
  id: string;
  label: string;
  protocol: FileSiteProtocol;
  connection: FileSiteConnection;
  /** Absolute POSIX path on the server. */
  remoteRoot: string;
  /** Absolute path of the deploy folder on this computer. */
  localFolder: string;
  projectIds: string[];
  deployOnSave: boolean;
  /** Seconds of quiet after the last change before Deploy on save starts (2 to 120). */
  quietSeconds: number;
  /** The site's own ignore lines, `.gitignore` style, `!` allowed. */
  ignorePatterns: string[];
  capabilities: FileSiteCapabilities | null;
  lastDeploy: FileSiteLastDeploy | null;
  needsReview: FilesNeedsReview | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileSiteInput {
  label: string;
  protocol: FileSiteProtocol;
  connection: FileSiteConnectionInput;
  remoteRoot: string;
  localFolder: string;
  projectIds: string[];
  deployOnSave: boolean;
  quietSeconds: number;
  ignorePatterns: string[];
}

export type FilesTestStep = 'reach' | 'login' | 'folder' | 'write' | 'replace' | 'time' | 'cleanup';

export interface FilesTestStepResult {
  step: FilesTestStep;
  status: 'ok' | 'warning' | 'failed' | 'skipped';
  /** A plain sentence for a warning or a failure; null when it went fine. */
  message: string | null;
}

/** An FTPS certificate that failed the checks, for the user to look at. */
export interface FilesCertificateInfo {
  /** SHA-256 of the certificate, 64 lowercase hex digits. */
  fingerprint256: string;
  subject: string;
  issuer: string;
  /** The names the certificate is valid for (subject alternative names, else the common name). */
  names: string[];
  validTo: string;
  reason: 'selfSigned' | 'nameMismatch' | 'expired' | 'untrusted';
}

/**
 * Test connection runs on a site that may not be saved yet. With `siteId`, a left-out secret is
 * the stored one.
 */
export interface FilesTestInput {
  siteId: string | null;
  site: FileSiteInput;
}

export interface FilesTestResult {
  ok: boolean;
  steps: FilesTestStepResult[];
  capabilities: FileSiteCapabilities | null;
  /** The remote folder as the server resolved it. */
  remoteRoot: string | null;
  /** SFTP with a login of the site's own: the key the server presented, when it is not trusted yet. */
  hostKey: { presented: string; stored: string | null } | null;
  certificate: FilesCertificateInfo | null;
  error: { code: FilesErrorCode; message: string } | null;
}

export interface FilesBrowseInput {
  siteId: string | null;
  site: FileSiteInput | null;
  /** Null for the folder the login starts in. */
  path: string | null;
}

export interface FilesBrowseResult {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

export type FilesLeftOutReason =
  | 'hardDenied'
  | 'agentFiles'
  | 'ignored'
  | 'symlink'
  | 'tooLarge'
  | 'notUtf8'
  | 'caseCollision'
  | 'invalidPath';

export interface FilesLeftOut {
  path: string;
  reason: FilesLeftOutReason;
}

export interface FilesPendingFile {
  path: string;
  change: LocalChange;
  /** The local size, or the size the last deploy sent for a deleted file. */
  size: number;
}

/** The live list of what changed in the deploy folder since the last deploy. */
export interface FilesChangesSnapshot {
  siteId: string;
  computedAt: number;
  state: 'ready' | 'scanning' | 'folderMissing' | 'tooManyFiles' | 'error';
  error: string | null;
  /** Sorted by path. */
  files: FilesPendingFile[];
  totals: { added: number; modified: number; deleted: number; bytes: number };
  leftOut: FilesLeftOut[];
  /** True when there were more left-out paths than the list carries. */
  leftOutTruncated: boolean;
  localFileCount: number;
  baseFileCount: number;
  /** No deploy has finished on this site yet. */
  firstDeploy: boolean;
}

export interface FilesPlanChange {
  path: string;
  local: LocalChange;
  remote: RemoteVerdict;
  action: PlanAction;
  conflict: ConflictReason | null;
  size: number;
  unverified: boolean;
  server: RemoteObservation | null;
  base: RemoteObservation | null;
}

export type FilesPlanNotice =
  /** Times on this server cannot be compared, so changes there are judged by size alone. */
  | 'sizeOnly'
  /** Too many files to ask the server for each time, so this plan compares sizes only. */
  | 'mdtmCapped'
  /** This server cannot replace a file in one step. */
  | 'notAtomic'
  /** Every time on the server moved by the same whole hours: a clock change, not edits. */
  | 'clockShift';

export interface FilesPlanInput {
  siteId: string;
}

/** A plan made in main and kept there for ten minutes; the renderer deploys it by id. */
export interface FilesPlanView {
  planId: string;
  siteId: string;
  createdAt: number;
  expiresAt: number;
  changes: FilesPlanChange[];
  uploadBytes: number;
  deleteCount: number;
  serverOnlyDrift: string[];
  missingOnServer: string[];
  firstDeploy: { existing: number; sameSize: number } | null;
  clockShiftHours: number | null;
  /** More deletes than Deploy on save may do on its own (over 20, or over a quarter of the base). */
  massDelete: boolean;
  notices: FilesPlanNotice[];
}

export type FilesConflictChoice = 'overwrite' | 'skip';

export interface FilesDeployInput {
  siteId: string;
  planId: string;
  /** The plan's paths to act on; the rest stay pending. */
  paths: string[];
  /** One choice for every conflict among `paths`. */
  conflicts: Record<string, FilesConflictChoice>;
  /** For a first deploy over existing files: take same-size files as sent, or send everything. */
  firstDeploy: 'adoptSameSize' | 'overwrite' | null;
  /** Paths from `missingOnServer` to send again. */
  reupload: string[];
}

export type FilesRunPhase =
  | 'connecting'
  | 'checking'
  | 'folders'
  | 'uploading'
  | 'deleting'
  | 'cleaning'
  | 'done';

export interface FilesProgressEvent {
  siteId: string;
  runId: string;
  trigger: FilesRunTrigger;
  phase: FilesRunPhase;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentPath: string | null;
}

export interface FilesRunFailure {
  path: string;
  code: FilesErrorCode;
  message: string;
}

export interface FilesRunResult {
  runId: string;
  siteId: string;
  trigger: FilesRunTrigger;
  state: FilesRunState;
  startedAt: number;
  finishedAt: number;
  uploaded: number;
  deleted: number;
  adopted: number;
  /** Deselected, skipped conflicts, or edited during the run: still pending. */
  skipped: number;
  bytes: number;
  failed: FilesRunFailure[];
  /** Every replace was done in one step. */
  atomic: boolean;
  /** What stopped the run, for `failed` (and a `partial` that broke off). */
  error: { code: FilesErrorCode; message: string } | null;
}

export type FilesHistoryEntry = FilesRunResult;

export interface FilesNeedsReviewEvent {
  siteId: string;
  needsReview: FilesNeedsReview | null;
}

export interface FilesSitesChangedEvent {
  sites: FileSite[];
}
