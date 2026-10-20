import type {
  SftpChmodInput,
  SftpConflict,
  SftpConflictDecision,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpTarget,
  SftpTextFile,
} from '@shared/sftpTypes';

/**
 * The props of the SFTP file manager's dialogs and transfer queue (E25). The page
 * (pages/SshFilesPage.tsx and stores/sftpStore.ts) renders these components, and each component
 * lives in a file of its own beside this one; this file is what both sides agree on.
 *
 * Callbacks that may take a while answer a promise: the component shows itself busy until it
 * settles. A rejection carries a `[files:code]` error (see filesProblem in
 * components/deploy/files/messages.ts for words to show).
 */

/** ConflictDialog.tsx: "This file already exists", one conflict at a time. */
export interface ConflictDialogProps {
  /** The conflict to ask about; null keeps the dialog closed. A new id means a new question. */
  conflict: SftpConflict | null;
  /**
   * The user's answer. Overwrite, Keep both and Skip send `applyToAll` as the checkbox stands;
   * Escape or closing the dialog sends `{ action: 'skip', applyToAll: false }`, this file only.
   * Overwrite is disabled when `conflict.target.isDirectory`.
   */
  onResolve: (decision: SftpConflictDecision) => void | Promise<void>;
  /** "Cancel this transfer": cancels the whole batch `conflict.batchId`. */
  onCancelBatch: (batchId: string) => void | Promise<void>;
  /**
   * The server that asks, shown as "On <name>" under the title. The dialog opens on whatever
   * page the user is on, so it says which server the question is about.
   */
  serverName?: string;
}

/** PropertiesDialog.tsx: details and permissions of the selected remote entries. */
export interface PropertiesDialogProps {
  open: boolean;
  /**
   * What is selected, one or more. With several, bits they disagree on show as indeterminate.
   * "Also apply inside" is offered only when one of them is a real folder (`isDirectory` and
   * not `isSymlink`), since recursive chmod never follows links.
   */
  entries: SftpRemoteEntry[];
  onOpenChange: (open: boolean) => void;
  /**
   * Apply: `paths` are the entries' paths, `recursive` is `none` unless a folder's "Also apply
   * inside" choice says otherwise. The dialog closes itself (through `onOpenChange(false)`) when
   * this resolves, and stays open with the error shown when it rejects.
   */
  onApply: (input: SftpChmodInput) => Promise<void>;
}

/** RemoteEditorDialog.tsx: a remote text file in Monaco, loaded lazily. */
export interface RemoteEditorDialogProps {
  open: boolean;
  /** The session to read and save through (`window.agentmat.sftp.readText` and `writeText`). */
  sessionId: string;
  /**
   * The saved server the file is on. When given, unsaved edits are kept under it and the path
   * (sftpEditorDraftStore), so they come back if the dialog unmounts before a save or discard.
   */
  serverId?: string;
  /**
   * The file to edit; null while closed. The dialog reads it when it opens. A file that is
   * `tooLarge` or `notText` gets a toast and the dialog closes itself through `onOpenChange(false)`.
   */
  path: string | null;
  /**
   * The file as the page already read it (the store reads before it opens the editor, so a
   * file that cannot be edited never flashes the dialog). When it is for `path`, the dialog
   * starts from it and skips its first read; Reload still reads.
   */
  initialFile?: SftpTextFile;
  /** Closing with unsaved changes asks first; this is only called once the user agreed. */
  onOpenChange: (open: boolean) => void;
  /** After each save, with the entry as it now is on the server, so the pane can refresh it. */
  onSaved?: (entry: SftpRemoteEntry) => void;
}

/** TransferQueue.tsx: the Transfers card at the bottom of the page. */
export interface TransferQueueProps {
  /** The session's queue; null before the first snapshot. The card collapses itself. */
  snapshot: SftpQueueSnapshot | null;
  /** Cancel on an item (`{ batchId, itemId }`), a batch (`{ batchId }`), or everything (`{}`). */
  onCancel: (target: SftpTarget) => void | Promise<void>;
  /** Retry, with the same targets as `onCancel`. */
  onRetry: (target: SftpTarget) => void | Promise<void>;
  /** "Clear finished": drops the batches that are over. */
  onClearFinished: () => void | Promise<void>;
  /** Whether the list starts shown. Defaults to true; the dock starts with the summary line. */
  defaultOpen?: boolean;
  className?: string;
}
