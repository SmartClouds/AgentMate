import { isAbsolute } from 'node:path';
import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import { filesError, filesErrorCode, filesErrorMessage } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import type { FilesService } from '../deploy/files/service';

/**
 * The FTP and SFTP site channels (E23). Like the rest of Deploy they answer only the main
 * window's own frame, and every argument is checked here before the service sees it; the store
 * then checks what each field means. What comes back is only ever the service's public answers,
 * so a password or key passphrase typed into the dialog goes in through `create`, `update` and
 * `test` and never out again.
 *
 * Electron only carries an error's message across, so every failure leaves here as a plain Error
 * whose message holds its `[files:code]`; one without a code gets `server`.
 */

const C = IPC.deployFiles;

const id = z.string().min(1).max(128);
const fingerprint = z.string().max(200).nullable();
const path = z.string().max(4096);

const connectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), sshServerId: id }),
  z.object({
    kind: z.literal('custom'),
    host: z.string().max(255),
    port: z.number(),
    username: z.string().max(256),
    authMethod: z.enum(['password', 'privateKey']),
    privateKeyPath: path.nullable(),
    hostKeyFingerprint: fingerprint,
    tlsPin: fingerprint,
    tlsServername: z.string().max(255).nullable(),
    secret: z.string().max(8192).optional(),
  }),
]);

/** One shape for a save, a test and the folder browser; the store refuses empty folders on save. */
const siteSchema = z.object({
  label: z.string().max(500),
  protocol: z.enum(['sftp', 'ftps', 'ftp']),
  connection: connectionSchema,
  remoteRoot: path,
  localFolder: path,
  projectIds: z.array(id).max(500),
  deployOnSave: z.boolean(),
  quietSeconds: z.number(),
  ignorePatterns: z.array(z.string().max(2000)).max(1000),
});

const testSchema = z.object({ siteId: id.nullable(), site: siteSchema });
const browseSchema = z.object({
  siteId: id.nullable(),
  site: siteSchema.nullable(),
  path: path.nullable(),
});
const planSchema = z.object({ siteId: id });
const deploySchema = z.object({
  siteId: id,
  planId: id,
  paths: z.array(path).max(200_000),
  conflicts: z.record(path, z.enum(['overwrite', 'skip'])),
  firstDeploy: z.enum(['adoptSameSize', 'overwrite']).nullable(),
  reupload: z.array(path).max(200_000),
});
const ignoreSchema = z.array(z.string().max(20_000)).max(5000);

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Only the field's name: the value could be the password.
  const field = parsed.error.issues[0]?.path.join('.');
  throw filesError('invalidInput', `That ${what} is not valid${field ? ` (${field})` : ''}.`);
}

const siteId = (value: unknown) => parse(id, value, 'site id');

/** A plain Error with the code in its message, the only part Electron carries across. */
function coded(error: unknown): Error {
  if (filesErrorCode(error)) return new Error((error as Error).message ?? String(error));
  return filesError('server', filesErrorMessage(error));
}

export interface DeployFilesHandlerDeps {
  service: FilesService;
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

export function registerDeployFilesHandlers(deps: DeployFilesHandlerDeps): void {
  const { service } = deps;
  /** Windows already known, so their going away is listened for once. */
  const known = new WeakSet<WebContents>();

  /** The window's id names its subscriptions; a reload, crash or close lets go of all of them. */
  function subscriberOf(contents: WebContents): string {
    const subscriberId = String(contents.id);
    if (!known.has(contents)) {
      known.add(contents);
      // Kept in `known` after a reload: the listeners stay, and the WeakSet lets go with the window.
      const gone = () => service.dropSubscriber(subscriberId);
      contents.on('did-navigate', gone);
      contents.on('render-process-gone', gone);
      contents.once('destroyed', gone);
    }
    return subscriberId;
  }

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (deps.guard && !deps.guard(event)) {
        throw new Error('FTP and SFTP sites answer only the main window.');
      }
      try {
        return await listener(event, ...args);
      } catch (error) {
        throw coded(error);
      }
    });
  };

  handle(C.list, () => service.list());
  handle(C.get, (_event, value) => service.get(siteId(value)));
  handle(C.create, (_event, value) => service.create(parse(siteSchema, value, 'site')));
  handle(C.update, (_event, value, input) =>
    service.update(siteId(value), parse(siteSchema, input, 'site')),
  );
  handle(C.remove, (_event, value) => service.remove(siteId(value)));
  handle(C.test, (_event, value) => service.test(parse(testSchema, value, 'test')));
  handle(C.browseRemote, (_event, value) =>
    service.browseRemote(parse(browseSchema, value, 'folder request')),
  );

  handle(C.pickLocalFolder, async (event, value) => {
    const start = parse(path.nullable(), value ?? null, 'folder');
    const options: OpenDialogOptions = {
      title: 'Pick the deploy folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(start && isAbsolute(start) ? { defaultPath: start } : {}),
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(C.validateIgnore, (_event, value) =>
    service.validateIgnore(parse(ignoreSchema, value, 'list of ignore lines')),
  );

  handle(C.subscribe, (event, value) =>
    service.subscribe(siteId(value), subscriberOf(event.sender)),
  );
  handle(C.unsubscribe, (event, value) => {
    service.unsubscribe(siteId(value), String(event.sender.id));
  });
  handle(C.changes, (_event, value) => service.changes(siteId(value)));
  handle(C.plan, (_event, value) => service.plan(parse(planSchema, value, 'plan').siteId));
  handle(C.deploy, (_event, value) => service.deploy(parse(deploySchema, value, 'deploy')));
  handle(C.cancel, (_event, value) => service.cancel(siteId(value)));
  handle(C.history, (_event, value) => service.history(siteId(value)));
  handle(C.forgetBase, (_event, value) => service.forgetBase(siteId(value)));
  handle(C.setDeployOnSave, (_event, value, enabled) =>
    service.setDeployOnSave(siteId(value), parse(z.boolean(), enabled, 'switch')),
  );
  handle(C.hostKeyStatus, (_event, value) => service.hostKeyStatus(siteId(value)));
  handle(C.trustHostKey, (_event, value, key) =>
    service.trustHostKey(siteId(value), parse(z.string().max(200), key, 'fingerprint')),
  );
  handle(C.trustCertificate, (_event, value, key) =>
    service.trustCertificate(siteId(value), parse(z.string().max(200), key, 'fingerprint')),
  );
}
