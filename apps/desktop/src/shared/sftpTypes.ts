import type { FilesErrorCode } from './deployFilesErrors';

/**
 * The SFTP file manager for saved SSH servers (E25): a local pane, a remote pane and a transfer
 * queue. Everything that crosses IPC is here, and `SftpBridge` is what `window.agentmat.sftp`
 * offers. No secret ever comes through: the main process logs in with the saved server's
 * stored credentials.
 *
 * Remote paths are absolute POSIX paths (`/var/www/site`). Local paths are absolute paths of
 * this computer, in its own form (`C:\Users\me` on Windows). Times are milliseconds since the
 * epoch; the server's are whole seconds (SFTP version 3), so they always end in 000.
 *
 * Failures reject with an Error whose message carries a `[files:code]` tag (see
 * shared/deployFilesErrors.ts), or `[ssh:code]` for login and vault trouble (`[ssh:vault-locked]`,
 * host key prompts), so `withHostKeyTrust` and the vault unlock flow work unchanged.
 */

/** The largest file the remote editor opens. */
export const SFTP_EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** The most files and folders one transfer, delete or chmod may cover once expanded. */
export const SFTP_MAX_ITEMS_PER_BATCH = 100_000;
/** How many files transfer at once, across every batch of a session. */
export const SFTP_TRANSFER_CONCURRENCY = 3;
/** How many failed items a batch's snapshot carries; `failuresTruncated` says there were more. */
export const SFTP_FAILURES_PER_BATCH = 50;
/** The longest remote path a call takes. */
export const SFTP_REMOTE_PATH_MAX = 4096;
/** The longest local path a call takes (Windows' long path limit). */
export const SFTP_LOCAL_PATH_MAX = 32_767;
/** The most paths one call takes (a selection to upload, download, delete or chmod). */
export const SFTP_MAX_PATHS_PER_CALL = 10_000;

/**
 * What a remote entry is. A link counts as what it points at (`file` or `dir`, with `isSymlink`
 * set); `link` is only for a link that leads nowhere. `other` is a socket, device or pipe.
 */
export type SftpEntryKind = 'file' | 'dir' | 'link' | 'other';

/** One entry of a remote folder. */
export interface SftpRemoteEntry {
  name: string;
  /** Absolute path on the server. */
  path: string;
  kind: SftpEntryKind;
  /** True for a folder and for a link to one. */
  isDirectory: boolean;
  /** The entry itself is a symbolic link, working or broken. */
  isSymlink: boolean;
  /** Bytes. For a link, those of its target; for a broken link, the link's own. 0 for folders. */
  size: number;
  mtimeMs: number;
  /** The permission bits alone (`mode & 0o7777`), such as 0o755. */
  mode: number;
  /** The owner's name as the server's listing shows it (or a number). Null when not known. */
  owner: string | null;
  group: string | null;
}

/** One entry of a folder on this computer. */
export interface SftpLocalEntry {
  name: string;
  /** Absolute local path. */
  path: string;
  /** True for a folder and for a link or junction to one. */
  isDirectory: boolean;
  isSymlink: boolean;
  /** Bytes; 0 for folders. */
  size: number;
  mtimeMs: number;
  /** The permission bits (0o644). Null on Windows, where they mean nothing to the server. */
  mode: number | null;
  /** A dot file, a file with the Windows hidden attribute, or `desktop.ini` and the like. */
  hidden: boolean;
}

/** A folder's contents, for either pane. */
export interface SftpListing<E extends SftpRemoteEntry | SftpLocalEntry> {
  /** The folder listed, resolved: absolute, normalized, `~` expanded. */
  path: string;
  /** The folder above, or null at a root (`/`, `C:\`). */
  parent: string | null;
  entries: E[];
  /**
   * Only part of the folder came back (E27): a stopped or shell-less container's folder is read
   * from Docker's archive, which stops after a byte cap. Missing means the listing is whole.
   */
  partial?: boolean;
}

/** A place the local pane's Places menu offers. */
export interface SftpLocalPlace {
  /** Stable for the place, such as `home` or `drive:C`. */
  id: string;
  /** What the menu shows: `Home`, `Desktop`, `Drive (C:)`. */
  label: string;
  path: string;
  kind: 'drive' | 'home' | 'desktop' | 'documents' | 'downloads' | 'root';
}

/** An open SFTP session on a saved server, as `open` reports it. */
export interface SftpSessionInfo {
  sessionId: string;
  serverId: string;
  nickname: string;
  host: string;
  port: number;
  username: string;
  /** The login user's home folder on the server, where the remote pane starts. */
  home: string;
  /**
   * What the remote side is (E27): a saved server's disk over SFTP, or a container or volume
   * through the server core. Missing means `ssh`.
   */
  kind?: SftpTargetKind;
  /** What the remote side allows. Missing means everything (SFTP). */
  capabilities?: SftpCapabilities;
  /** Why some actions are off, in a sentence for the page; null or missing when nothing is. */
  limitation?: string | null;
}

export type SftpTargetKind = 'ssh' | 'container' | 'volume';

/**
 * The actions a remote side allows. Listing, transfers and new folders always work; a stopped or
 * shell-less container cannot rename, delete or change permissions, and so cannot be edited in
 * place either (a save is a rename over the old file).
 */
export interface SftpCapabilities {
  rename: boolean;
  remove: boolean;
  chmod: boolean;
  edit: boolean;
}

/**
 * What happens when a file being transferred is already at the target: `ask` stops for the
 * user (the default), `rename` keeps both by giving the new one the next free `name (N).ext`.
 */
export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';
/** The user's answer to one conflict. */
export type SftpConflictAction = 'overwrite' | 'skip' | 'rename';

/** What a batch does. Delete and chmod are queued and reported like transfers. */
export type SftpJobKind = 'upload' | 'download' | 'delete' | 'chmod';

/** One file or folder in a batch. */
export type SftpItemState =
  | 'queued'
  | 'running'
  /** Parked until the user answers the conflict the snapshot carries. */
  | 'conflict'
  | 'done'
  /** Left alone: a skip answer, or a link to a folder that a walk does not follow. */
  | 'skipped'
  | 'failed'
  | 'cancelled';

export type SftpBatchState =
  /** Walking the selected folders to find every file. Totals are null until this is over. */
  | 'expanding'
  | 'queued'
  | 'running'
  /** A conflict in this batch waits for an answer; other batches keep running. */
  | 'waiting'
  /** Over, with every item done or skipped. */
  | 'done'
  /** Over, with at least one item failed. */
  | 'failed'
  | 'cancelled';

/** One item of a batch, as the queue shows it. */
export interface SftpItemView {
  /** Unique within its batch. */
  itemId: string;
  /** Path below the batch's source, with `/` separators (`assets/app.css`), or the name alone. */
  relPath: string;
  /** Bytes to transfer; 0 for folders and for delete and chmod items. */
  size: number;
  /** Bytes transferred so far. */
  transferred: number;
  state: SftpItemState;
  /** What went wrong, in words, for a failed item. Null otherwise. */
  error: string | null;
  errorCode: FilesErrorCode | null;
}

/** One batch: what one upload, download, delete or chmod request turned into. */
export interface SftpBatchView {
  batchId: string;
  kind: SftpJobKind;
  /** What the queue row says: `site (124 files)`, or the name of a single file. */
  label: string;
  /**
   * Where the items come from: the local folder holding the selection for an upload, the remote
   * one for a download, the remote folder holding the paths for delete and chmod.
   */
  source: string;
  /** The folder they go to (remote for an upload, local for a download); null for delete and chmod. */
  target: string | null;
  state: SftpBatchState;
  /** Null while the batch is still expanding. */
  totalItems: number | null;
  doneItems: number;
  failedItems: number;
  skippedItems: number;
  /** Null while expanding; 0 for delete and chmod. */
  totalBytes: number | null;
  transferredBytes: number;
  /** Smoothed; null until there is a second of data to go on, or when nothing is moving. */
  bytesPerSecond: number | null;
  /** Seconds left at the current rate; null when that cannot be said. */
  etaSeconds: number | null;
  /** The items transferring now. */
  running: SftpItemView[];
  /** The failed items, the first `SFTP_FAILURES_PER_BATCH` of them. */
  failures: SftpItemView[];
  /** More items failed than `failures` holds. */
  failuresTruncated: boolean;
  createdAt: number;
  /** When the batch ended (done, failed or cancelled); null while it runs. */
  finishedAt: number | null;
}

/** A file that is already at the target, waiting for the user to say what to do. */
export interface SftpConflict {
  conflictId: string;
  batchId: string;
  itemId: string;
  direction: 'upload' | 'download';
  /** The file's name. */
  name: string;
  /** Path below the batch's source, as in `SftpItemView.relPath`. */
  relPath: string;
  /** The folder the file would go to (remote for an upload, local for a download). */
  targetDir: string;
  /** The file being sent. */
  source: { size: number; mtimeMs: number };
  /** What is already there. A folder can only be skipped or kept beside, never overwritten. */
  target: { size: number; mtimeMs: number; isDirectory: boolean };
  /** The name "Keep both" would give the new file, such as `report (1).pdf`. */
  renameTo: string;
  /**
   * Items of this batch not decided yet besides this one (queued, or parked on a conflict of
   * their own). "Apply to all" covers every one of them that turns out to conflict, so the
   * dialog can offer it whenever this is above 0.
   */
  remainingInBatch: number;
}

/** The whole queue of one session; sent on `onQueue` and answered by `queue`. */
export interface SftpQueueSnapshot {
  sessionId: string;
  /** Oldest first, finished ones included until `clearFinished`. */
  batches: SftpBatchView[];
  /** The one conflict to show now, or null. */
  conflict: SftpConflict | null;
  /** Further conflicts waiting behind `conflict`, across all batches. */
  pendingConflicts: number;
}

/** Sent once a batch is over, so the pane it changed can refresh and failures can be told. */
export interface SftpBatchFinished {
  sessionId: string;
  batchId: string;
  kind: SftpJobKind;
  /** The pane whose contents changed: `local` for a download, `remote` for everything else. */
  side: 'local' | 'remote';
  /** The folder on that side to refresh, or null when there is no one folder. */
  target: string | null;
  /** No item failed (skipped and cancelled ones do not count as failures). */
  ok: boolean;
  /** How many items failed. */
  failed: number;
}

/** Sent when a session ends without its page asking for it. */
export interface SftpSessionClosed {
  sessionId: string;
  serverId: string;
  /**
   * `removed`: the saved server was deleted. `closed`: the session ended. `disconnected`: another
   * view of the session (the page, the panel or the pop-out window) disconnected it. `quit`: the
   * app is quitting.
   */
  reason: 'removed' | 'closed' | 'disconnected' | 'quit';
}

/** Files and folders from anywhere on this computer to one remote folder. */
export interface SftpUploadInput {
  localPaths: string[];
  remoteDir: string;
  /** Default `ask`. */
  policy?: SftpConflictPolicy;
}

/** Remote files and folders to a local folder the local pane has listed. */
export interface SftpDownloadInput {
  remotePaths: string[];
  localDir: string;
  /** Default `ask`. */
  policy?: SftpConflictPolicy;
}

/**
 * How far a chmod of a folder reaches: the folder alone (`none`), or also everything inside
 * (`all`), only the files inside, or only the folders inside. Links are always left alone.
 */
export type SftpChmodScope = 'none' | 'all' | 'files' | 'dirs';

export interface SftpChmodInput {
  paths: string[];
  /** The permission bits to set, 0 to 0o7777. */
  mode: number;
  recursive: SftpChmodScope;
}

export interface SftpConflictDecision {
  action: SftpConflictAction;
  /** Give the same answer to the other conflicts of the same batch, now and later. */
  applyToAll: boolean;
}

/**
 * Which part of the queue `cancel` or `retry` acts on: one item of a batch (both ids), one batch
 * (`batchId` alone), or everything (empty, or left out).
 */
export interface SftpTarget {
  batchId?: string;
  itemId?: string;
}

/** What `remove`, `chmod`, `upload` and `download` answer: the batch they queued. */
export interface SftpBatchRef {
  batchId: string;
}

/** A remote text file opened in the editor. */
export interface SftpTextFile {
  path: string;
  /** The text, decoded as UTF-8, without a byte order mark. */
  content: string;
  /** Bytes on the server when it was read; sent back in `SftpWriteTextInput.base`. */
  size: number;
  mtimeMs: number;
  /** The permission bits, kept when it is saved. */
  mode: number;
  /** The file started with a UTF-8 byte order mark, which a save writes back. */
  bom: boolean;
}

export interface SftpWriteTextInput {
  path: string;
  content: string;
  bom: boolean;
  /** Size and mtime from `SftpTextFile`. A file that no longer matches fails with `changedOnServer`. */
  base: { size: number; mtimeMs: number };
  /** Save even when the file changed on the server since it was read. */
  force: boolean;
}

/**
 * The folders a pop-out opens at, those its opener showed. A remote one is absolute on the
 * server, a local one absolute on this computer; either is left out to start at home.
 */
export interface SftpPopOutView {
  remotePath?: string;
  localPath?: string;
}

/** What the pop-out's title bar asks of its own window. `maximize` toggles maximize and restore. */
export type SftpWindowAction = 'minimize' | 'maximize' | 'close';

/** The pop-out window as its title bar draws it. */
export interface SftpWindowState {
  isMaximized: boolean;
}

/**
 * `window.agentmat.sftp`. Every remote call takes the `sessionId` from `open` and only works from
 * the window that opened it; another window's id fails with `[files:invalidInput]`.
 *
 * Local writes (`localMkdir`, `localRename`, `localDelete`, and a download's `localDir`) must land
 * inside a folder `localList` listed for this window recently, else `[files:invalidInput]`.
 * Upload sources may come from anywhere, since the OS can drop any file on the page.
 */
export interface SftpBridge {
  /**
   * Opens a session on a saved server, or returns the one this window already has for it.
   * Rejects with `[ssh:vault-locked]` while the Servers vault is locked, and with the usual
   * `[ssh:*]` host key tags for an unknown or changed key.
   */
  open: (serverId: string) => Promise<SftpSessionInfo>;
  /** Ends the session: cancels its transfers and releases its connections. */
  close: (sessionId: string) => Promise<void>;
  /** A remote folder. `path` may be absolute, `~`, `~/x` or relative to home, `..` included. */
  list: (sessionId: string, path: string) => Promise<SftpListing<SftpRemoteEntry>>;
  /**
   * One remote entry, links followed, or null when nothing is there. `owner` and `group` may be
   * null when only a stat could be read.
   */
  stat: (sessionId: string, path: string) => Promise<SftpRemoteEntry | null>;
  /** Makes `name` in `parentDir` and answers its path. `[files:exists]` when the name is taken. */
  mkdir: (sessionId: string, parentDir: string, name: string) => Promise<string>;
  /** Renames in place and answers the new path. `[files:exists]` when the name is taken. */
  rename: (sessionId: string, path: string, newName: string) => Promise<string>;
  /** Deletes for good, folders with everything inside. Links are removed, never followed. */
  remove: (sessionId: string, paths: string[]) => Promise<SftpBatchRef>;
  chmod: (sessionId: string, input: SftpChmodInput) => Promise<SftpBatchRef>;
  upload: (sessionId: string, input: SftpUploadInput) => Promise<SftpBatchRef>;
  download: (sessionId: string, input: SftpDownloadInput) => Promise<SftpBatchRef>;
  /** Answers the conflict a snapshot showed. An unknown id fails with `[files:invalidInput]`. */
  resolveConflict: (
    sessionId: string,
    conflictId: string,
    decision: SftpConflictDecision,
  ) => Promise<void>;
  /** Cancels what `target` names, or everything. Cancelled is not failed. */
  cancel: (sessionId: string, target?: SftpTarget) => Promise<void>;
  /** Puts failed and cancelled items of `target`, or of every batch, back in the queue. */
  retry: (sessionId: string, target?: SftpTarget) => Promise<void>;
  /** Drops the batches that are over from the queue. */
  clearFinished: (sessionId: string) => Promise<void>;
  /** The queue as it is now, conflict included: what a page that came back shows first. */
  queue: (sessionId: string) => Promise<SftpQueueSnapshot>;
  /**
   * A remote file for the editor. `[files:tooLarge]` above `SFTP_EDIT_MAX_BYTES`,
   * `[files:notText]` for a binary file or one that is not UTF-8.
   */
  readText: (sessionId: string, path: string) => Promise<SftpTextFile>;
  /**
   * Saves the editor's text atomically, keeping the file's mode, and answers the entry as it now
   * is. `[files:changedOnServer]` when the file is not what `base` says and `force` is false.
   */
  writeText: (sessionId: string, input: SftpWriteTextInput) => Promise<SftpRemoteEntry>;
  /** Drives, Home, Desktop, Documents, Downloads (`/` on macOS and Linux). */
  localPlaces: () => Promise<SftpLocalPlace[]>;
  /**
   * A folder on this computer. Listing it is what lets this window write into it afterwards.
   * `[files:folderMissing]` when it is gone, `[files:invalidInput]` for a file.
   */
  localList: (path: string) => Promise<SftpListing<SftpLocalEntry>>;
  /** Makes `name` in `parentDir` and answers its path. `[files:exists]` when the name is taken. */
  localMkdir: (parentDir: string, name: string) => Promise<string>;
  /** Renames in place and answers the new path. `[files:exists]` when the name is taken. */
  localRename: (path: string, newName: string) => Promise<string>;
  /**
   * Moves the paths to the Trash, or deletes them for good with `permanent`. Rejects on the first
   * one that fails; those before it stay trashed, so a permanent retry of all of them is safe.
   */
  localDelete: (paths: string[], options: { permanent: boolean }) => Promise<void>;
  /** Snapshots of this window's sessions' queues. Answers an unsubscribe. */
  onQueue: (callback: (snapshot: SftpQueueSnapshot) => void) => () => void;
  onBatchFinished: (callback: (event: SftpBatchFinished) => void) => () => void;
  onSessionClosed: (callback: (event: SftpSessionClosed) => void) => () => void;
  /**
   * A session this window was handed, from a pop-out window that closed or crashed with sessions
   * this window did not have. Shown like one it connected to itself. Answers an unsubscribe.
   */
  onSessionAdopted: (callback: (info: SftpSessionInfo) => void) => () => void;
  /**
   * Opens the file manager of the session in a window of its own, or brings that window to the
   * front when it is open. The window becomes another owner of the same session, so its queue
   * and conflicts reach both. Main window only; a pop-out cannot pop out again. A new window opens
   * at the folders of `view`; one already open just comes to the front.
   */
  popOut: (sessionId: string, view?: SftpPopOutView) => Promise<void>;
  /** From the pop-out: minimize, maximize (or restore) or close its own window. */
  windowControl: (action: SftpWindowAction) => Promise<void>;
  /** From the pop-out: whether its window is maximized now. */
  windowState: () => Promise<SftpWindowState>;
  /** From the pop-out: its window was maximized or restored. Answers an unsubscribe. */
  onWindowState: (callback: (state: SftpWindowState) => void) => () => void;
  /**
   * From the pop-out: brings the main window to the front on this server's page and closes the
   * pop-out. The main window navigates through the app's usual route push (`app.onNavigate`).
   */
  backToMain: () => Promise<void>;
}
