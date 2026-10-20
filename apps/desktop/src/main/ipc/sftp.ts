import { isAbsolute } from 'node:path';
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import { filesError } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import { isValidEntryName } from '../../shared/sftpNames';
import {
  SFTP_EDIT_MAX_BYTES,
  SFTP_LOCAL_PATH_MAX,
  SFTP_MAX_PATHS_PER_CALL,
  SFTP_REMOTE_PATH_MAX,
} from '../../shared/sftpTypes';
import { toCodedError, toLocalCodedError } from '../sftp/errors';
import type { LocalBrowseRegistry } from '../sftp/localBrowse';
import { localDelete, localList, localMkdir, localPlaces, localRename } from '../sftp/localFs';
import type { SftpService } from '../sftp/service';

/**
 * The SFTP file manager channels (E25). Like Deploy's they answer only the main window's own
 * frame, and every argument is checked here before the service sees it. A refusal names the
 * field that was wrong and never its value, since paths and file contents are the user's.
 *
 * The calling window is the owner: a session answers only the window that opened it, and the
 * local writes (new folder, rename, delete) must land inside a folder that window's pane listed
 * (D13, see main/sftp/localBrowse.ts). A window that is destroyed or whose renderer goes away
 * takes its sessions and its listed folders with it; a reload does not, so a page that comes
 * back finds its transfers still running (D3).
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

export interface SftpHandlerDeps {
  service: SftpService;
  localBrowse: LocalBrowseRegistry;
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

export function registerSftpHandlers(deps: SftpHandlerDeps): void {
  const { service, localBrowse } = deps;
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

  const handle = (
    channel: string,
    listener: (ownerId: number, ...args: unknown[]) => unknown,
    code: (error: unknown) => Error = (error) => toCodedError(error),
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (deps.guard && !deps.guard(event)) {
        throw new Error('The SFTP file manager answers only the main window.');
      }
      try {
        return await listener(ownerOf(event.sender), ...args);
      } catch (error) {
        throw new Error(code(error).message);
      }
    });
  };

  handle(IPC.sftp.open, (owner, id) => service.open(owner, parse(serverId, id, 'server id')));
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
