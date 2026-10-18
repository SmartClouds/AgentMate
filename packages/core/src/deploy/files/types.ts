/**
 * The data the FTP and SFTP site planner works on (E23). Every path is relative to the site's
 * root, POSIX style (`css/site.css`), the same on this computer and on the server. A folder is
 * named the same way, with `''` for the root itself.
 *
 * Three views of one site meet here:
 * - local: what the deploy folder holds now, hashed;
 * - base: what the last deploy left on the server, as this computer sent it, plus what the server
 *   itself reported for the file right after it arrived;
 * - remote: what the server reports now, for the folders that were listed.
 */

/** Where a server's modified time came from. Two times only compare when this matches. */
export type RemoteTimeSource = 'sftp' | 'mlsd' | 'mdtm';

export interface LocalFileEntry {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export type LocalFileMap = Record<string, LocalFileEntry>;

/** What the server reported for one file. `mtimeMs` is null when it gave no usable time. */
export interface RemoteObservation {
  size: number;
  mtimeMs: number | null;
  via: RemoteTimeSource | null;
}

export interface BaseEntry {
  /** The bytes this computer sent. */
  sha256: string;
  size: number;
  /** The local file's modified time when it was hashed, so an unchanged file is not hashed again. */
  localMtimeMs: number;
  /** What the server reported right after the upload; null when it could not be read. */
  remote: RemoteObservation | null;
}

export type BaseMap = Record<string, BaseEntry>;

/**
 * What the server holds, for the folders that were read. A path whose folder is in `listedDirs`
 * and that is not in `entries` is missing on the server; a path whose folder was never listed is
 * unknown, and counts as the base.
 */
export interface PartialRemote {
  listedDirs: ReadonlySet<string>;
  entries: Readonly<Record<string, RemoteObservation>>;
}

/** How the local file differs from the base. */
export type LocalChange = 'added' | 'modified' | 'deleted';

/**
 * How the server's file compares with what the last deploy saw there.
 * - `unchanged`: same size and, from the same source, the same time.
 * - `changed`: a different size, or a different time from the same source.
 * - `missing`: the folder was listed and the file is not in it.
 * - `sizeOnly`: the size matches but the time could not be compared, so this is a guess.
 * - `unknown`: the folder was not listed.
 * - `untracked`: the server has a file the base does not know (a first deploy, or someone else's).
 */
export type RemoteVerdict =
  | 'unchanged'
  | 'changed'
  | 'missing'
  | 'sizeOnly'
  | 'unknown'
  | 'untracked';

export type PlanAction = 'upload' | 'deleteRemote' | 'adopt' | 'conflict';

export type ConflictReason = 'existsOnServer' | 'changedOnServer' | 'deletedOnServer';

export interface PlannedChange {
  path: string;
  local: LocalChange;
  remote: RemoteVerdict;
  action: PlanAction;
  conflict: ConflictReason | null;
  /** Bytes this change sends: the local size for an upload or a conflict, 0 otherwise. */
  size: number;
  /** True when the server side was judged by size alone, or not read at all. */
  unverified: boolean;
  /** What the server holds now, when it was read. */
  server: RemoteObservation | null;
  /** What the last deploy saw on the server. */
  base: RemoteObservation | null;
}

export interface SyncPlanInput {
  local: LocalFileMap;
  base: BaseMap;
  /** Null when the server was not read: a plan of local changes only, for the live list. */
  remote: PartialRemote | null;
  /** `bySize`: a file already on the server with the local size is taken as sent (adopt). */
  adopt?: 'bySize' | null;
}

export interface SyncPlan {
  /** Every path that needs something, conflicts included, sorted by path. */
  changes: PlannedChange[];
  conflicts: PlannedChange[];
  uploadBytes: number;
  deleteCount: number;
  /** Deleted here and already gone from the server: they only leave the base. */
  dropFromBase: string[];
  /** Unchanged here but changed on the server since the last deploy. Shown, never touched. */
  serverOnlyDrift: string[];
  /** Unchanged here but gone from the server. Offered for upload again, never by default. */
  missingOnServer: string[];
  /** An empty base over a server folder that already has files. */
  firstDeploy: { existing: number; sameSize: number } | null;
  /** Whole hours every changed time was shifted by (a server clock or DST change), or null. */
  clockShiftHours: number | null;
}
