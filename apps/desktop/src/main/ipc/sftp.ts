import { isAbsolute } from 'node:path';
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import { filesError } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import { isValidEntryName } from '../../shared/sftpNames';
import {
  SFTP_EDIT_MAX_BYTES,
  SFTP_LOCAL_PATH_MAX,
  SFTP_MAX_PATHS_PER_CALL,
  SFTP_REMOTE_PATH_MAX,
  type SftpPopOutView,
  type SftpSessionInfo,
  type SftpWindowAction,
  type SftpWindowState,
} from '../../shared/sftpTypes';
import { toCodedError, toLocalCodedError } from '../sftp/errors';
import type { LocalBrowseRegistry } from '../sftp/localBrowse';
import { localDelete, localList, localMkdir, localPlaces, localRename } from '../sftp/localFs';
import type { SftpService } from '../sftp/service';

/**
 * The SFTP file manager channels (E25). They answer only the top frame of the main window or of
 * a file manager pop-out (`sftpSenderAllowed`), and every argument is checked here before the
 * service sees it. A refusal names the field that was wrong and never its value, since paths and
 * file contents are the user's.
 *
 * The calling window is the owner: a session answers only the windows that own it (the one that
 * opened it, and its pop-out; the main window and the pop-outs share one session per server), and
 * the local writes (new folder, rename, delete) must land inside
 * a folder that window's pane listed (D13, see main/sftp/localBrowse.ts). A window that is
 * destroyed or whose renderer goes away leaves its sessions (ending those nobody else owns) and
 * takes its listed folders with it; a reload does not, so a page that comes back finds its
 * transfers still running (D3).
 *
 * Popping a session out is for the main window only, and the pop-out's window controls answer
 * the pop-out alone, acting on itself (main/sftp/window.ts).
 *
 * Electron only carries an error's message across, so every failure leaves as a plain Error
 * whose message holds its `[files:code]` or `[ssh:code]` tag.
 */

const ID = /^[A-Za-z0-9-]{1,64}$/;
/** Win32 device and long-path namespaces (`\\?\C:\x`, `\\.\pipe\x`), either slash. */
const DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;

const noNul = (value: string) => !value.includes('\0');

const serverId = z.string().min(1).max(128);
const sessionId = z.string().regex(ID);
/** Batch and conflict ids, which the engine makes as UUIDs. */
const queueId = z.string().regex(ID);
/** Item ids, a counter within each batch. */
const itemId = z.string().regex(/^[0-9]{1,10}$/);
/** What the remote path bar sends: absolute, `~`, `~/x`, relative, `..`. Only `list` takes it. */
const remoteInput = z.string().max(SFTP_REMOTE_PATH_MAX).refine(noNul);
const remotePath = z
  .string()
  .max(SFTP_REMOTE_PATH_MAX)
  .refine((value) => value.startsWith('/') && noNul(value));
const localPath = z
  .string()
  .min(1)
  .max(SFTP_LOCAL_PATH_MAX)
  .refine((value) => isAbsolute(value) && !DEVICE_PREFIX.test(value) && noNul(value));
const name = z.string().max(1024).refine(isValidEntryName);
const remotePaths = z.array(remotePath).min(1).max(SFTP_MAX_PATHS_PER_CALL);
const localPaths = z.array(localPath).min(1).max(SFTP_MAX_PATHS_PER_CALL);
const policy = z.enum(['ask', 'overwrite', 'skip', 'rename']).optional();

const uploadSchema = z.object({ localPaths, remoteDir: remotePath, policy });
const downloadSchema = z.object({ remotePaths, localDir: localPath, policy });
const chmodSchema = z.object({
  paths: remotePaths,
  mode: z.number().int().min(0).max(0o7777),
  recursive: z.enum(['none', 'all', 'files', 'dirs']),
});
const decisionSchema = z.object({
  action: z.enum(['overwrite', 'skip', 'rename']),
  applyToAll: z.boolean(),
});
const targetSchema = z
  .object({ batchId: queueId.optional(), itemId: itemId.optional() })
  .optional();
const writeTextSchema = z.object({
  path: remotePath,
  // UTF-16 code units never outnumber UTF-8 bytes, so text longer than the byte limit can never
  // fit. textFile.writeText checks the real byte count, BOM included.
  content: z.string().max(SFTP_EDIT_MAX_BYTES),
  bom: z.boolean(),
  base: z.object({ size: z.number().int().min(0), mtimeMs: z.number().min(0) }),
  force: z.boolean(),
});
const deleteOptions = z.object({ permanent: z.boolean() });
const windowAction = z.enum(['minimize', 'maximize', 'close']);
/** The folders a pop-out opens at, which ride on its URL. */
const popOutViewSchema = z
  .object({ remotePath: remotePath.optional(), localPath: localPath.optional() })
  .optional();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Only the field's name: the value could be a private path or the file's text.
  const field = parsed.error.issues[0]?.path.join('.');
  throw filesError('invalidInput', `That ${what} is not valid${field ? ` (${field})` : ''}.`);
}

const session = (value: unknown) => parse(sessionId, value, 'session id');
const remote = (value: unknown) => parse(remotePath, value, 'remote path');
const localArg = (value: unknown) => parse(localPath, value, 'local path');
const entryName = (value: unknown) => parse(name, value, 'name');

/** The pop-out windows (main/sftp/window.ts), passed in so the channels can be tested alone. */
export interface SftpWindowHandlers {
  isSftpWindow(contents: WebContents): boolean;
  /** The webContents ids of the main window and the pop-outs, which share one session per server. */
  linkedOwners(): number[];
  /** Opens the session's window at the folders of `view`, or focuses it. */
  open(info: SftpSessionInfo, view: SftpPopOutView): void;
  control(contents: WebContents, action: SftpWindowAction): void;
  state(contents: WebContents): SftpWindowState;
  backToMain(contents: WebContents): void;
}

export interface SftpHandlerDeps {
  service: SftpService;
  localBrowse: LocalBrowseRegistry;
  windows: SftpWindowHandlers;
  /** True for the windows that may use these channels (see `sftpSenderAllowed`, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

/**
 * The app's guard for these channels: the main window or a file manager pop-out, and only from
 * that window's own top frame.
 */
export function sftpSenderAllowed(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
  isSftpWindow: (contents: WebContents) => boolean,
): boolean {
  const fromMain = !!mainWindow && event.sender === mainWindow.webContents;
  if (!fromMain && !isSftpWindow(event.sender)) return false;
  return event.senderFrame === event.sender.mainFrame;
}

/** Which windows a channel answers, within those the guard lets in. */
type From = 'any' | 'main' | 'popOut';

export function registerSftpHandlers(deps: SftpHandlerDeps): void {
  const { service, localBrowse, windows } = deps;
  /** Windows already known, so their going away is listened for once. */
  const known = new WeakSet<WebContents>();

  /** The window's id owns its sessions; a destroyed window or a crashed renderer drops them. */
  function ownerOf(contents: WebContents): number {
    const ownerId = contents.id;
    if (!known.has(contents)) {
      known.add(contents);
      const gone = () => {
        localBrowse.dropOwner(ownerId);
        void service.dropOwner(ownerId);
      };
      contents.on('render-process-gone', gone);
      contents.once('destroyed', gone);
    }
    return ownerId;
  }

  /** Local channels code their failures as this computer's, never as the server's. */
  const local = (error: unknown) => toLocalCodedError(error);

  /**
   * Wraps a listener in the guard, the channel's own rule about which window may call it, and
   * the error coding. The guard admits only the main window and the pop-outs, so a sender that is
   * not a pop-out is the main window.
   */
  const guarded =
    (
      from: From,
      listener: (sender: WebContents, ...args: unknown[]) => unknown,
      code: (error: unknown) => Error = (error) => toCodedError(error),
    ) =>
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
      if (deps.guard && !deps.guard(event)) {
        throw new Error('The SFTP file manager answers only the main window and its own windows.');
      }
      try {
        const popOut = windows.isSftpWindow(event.sender);
        if (from === 'main' && popOut) {
          throw filesError('invalidInput', 'Only the main window can open a file manager window.');
        }
        if (from === 'popOut' && !popOut) {
          throw filesError('invalidInput', "Only the file manager's own window can do that.");
        }
        return await listener(event.sender, ...args);
      } catch (error) {
        throw new Error(code(error).message);
      }
    };

  const handle = (
    channel: string,
    listener: (ownerId: number, ...args: unknown[]) => unknown,
    code?: (error: unknown) => Error,
  ): void => {
    ipcMain.handle(
      channel,
      guarded('any', (sender, ...args) => listener(ownerOf(sender), ...args), code),
    );
  };

  handle(IPC.sftp.open, (owner, id) => {
    const linked = windows.linkedOwners();
    const peers = linked.includes(owner) ? linked : [];
    return service.open(owner, parse(serverId, id, 'server id'), { peers });
  });
  handle(IPC.sftp.close, (owner, id) => service.close(owner, session(id)));
  handle(IPC.sftp.list, (owner, id, path) =>
    service.list(owner, session(id), parse(remoteInput, path, 'path')),
  );
  handle(IPC.sftp.stat, (owner, id, path) => service.stat(owner, session(id), remote(path)));
  handle(IPC.sftp.mkdir, (owner, id, parentDir, value) =>
    service.mkdir(owner, session(id), remote(parentDir), entryName(value)),
  );
  handle(IPC.sftp.rename, (owner, id, path, value) =>
    service.rename(owner, session(id), remote(path), entryName(value)),
  );
  handle(IPC.sftp.remove, (owner, id, paths) =>
    service.remove(owner, session(id), parse(remotePaths, paths, 'list of paths')),
  );
  handle(IPC.sftp.chmod, (owner, id, input) =>
    service.chmod(owner, session(id), parse(chmodSchema, input, 'permissions change')),
  );
  handle(IPC.sftp.upload, (owner, id, input) =>
    service.upload(owner, session(id), parse(uploadSchema, input, 'upload')),
  );
  handle(IPC.sftp.download, (owner, id, input) =>
    service.download(owner, session(id), parse(downloadSchema, input, 'download')),
  );
  handle(IPC.sftp.resolveConflict, (owner, id, conflictId, decision) =>
    service.resolveConflict(
      owner,
      session(id),
      parse(queueId, conflictId, 'conflict id'),
      parse(decisionSchema, decision, 'answer'),
    ),
  );
  handle(IPC.sftp.cancel, (owner, id, target) =>
    service.cancel(owner, session(id), parse(targetSchema, target, 'target')),
  );
  handle(IPC.sftp.retry, (owner, id, target) =>
    service.retry(owner, session(id), parse(targetSchema, target, 'target')),
  );
  handle(IPC.sftp.clearFinished, (owner, id) => service.clearFinished(owner, session(id)));
  handle(IPC.sftp.queue, (owner, id) => service.queue(owner, session(id)));
  handle(IPC.sftp.readText, (owner, id, path) =>
    service.readText(owner, session(id), remote(path)),
  );
  handle(IPC.sftp.writeText, (owner, id, input) =>
    service.writeText(owner, session(id), parse(writeTextSchema, input, 'save')),
  );

  // The pop-out window. The main window pops out a session it owns; the pop-out's controls act on
  // the pop-out itself.
  ipcMain.handle(
    IPC.sftp.popOut,
    guarded('main', (sender, id, view) => {
      const info = service.info(ownerOf(sender), session(id));
      windows.open(info, parse(popOutViewSchema, view, 'folder to open at') ?? {});
    }),
  );
  ipcMain.handle(
    IPC.sftp.windowControl,
    guarded('popOut', (sender, action) =>
      windows.control(sender, parse(windowAction, action, 'window action')),
    ),
  );
  ipcMain.handle(
    IPC.sftp.windowState,
    guarded('popOut', (sender) => windows.state(sender)),
  );
  ipcMain.handle(
    IPC.sftp.backToMain,
    guarded('popOut', (sender) => windows.backToMain(sender)),
  );

  // Each change is judged by the folder its entry is in, so a listed folder itself cannot be
  // deleted or renamed, and a junction inside one can be without following it (D13).
  const guardFor = (owner: number) => (path: string) =>
    localBrowse.assertEntryWritable(owner, path);

  handle(IPC.sftp.localPlaces, () => localPlaces(), local);
  handle(
    IPC.sftp.localList,
    async (owner, path) => {
      const listing = await localList(localArg(path));
      localBrowse.record(owner, listing.path);
      return listing;
    },
    local,
  );
  handle(
    IPC.sftp.localMkdir,
    (owner, parentDir, value) =>
      localMkdir(localArg(parentDir), entryName(value), { guard: guardFor(owner) }),
    local,
  );
  handle(
    IPC.sftp.localRename,
    (owner, path, value) =>
      localRename(localArg(path), entryName(value), { guard: guardFor(owner) }),
    local,
  );
  handle(
    IPC.sftp.localDelete,
    async (owner, paths, options) => {
      const targets = parse(localPaths, paths, 'list of paths');
      const { permanent } = parse(deleteOptions, options, 'delete options');
      await localDelete(targets, { permanent, guard: guardFor(owner) });
    },
    local,
  );
}
