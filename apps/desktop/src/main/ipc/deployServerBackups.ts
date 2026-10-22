import type { IpcMainInvokeEvent } from 'electron';
import type {
  BackupDestinationKind,
  BackupDestinationSecret,
  BackupDestinationSettings,
  BackupPlanPreviewRequest,
  SaveBackupDestinationRequest,
  SaveBackupPlanRequest,
} from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type {
  DeployBackupDestinationInput,
  DeployBackupItemInput,
  DeployBackupNowInput,
  DeployBackupRunInput,
  DeployBackupSecretInput,
  DeployBringUpInput,
  DeployCloudDriveInput,
  DeployServerRestoreInput,
  DeployServerRestoreSource,
  DeployStoredBackupInput,
  DeployTelegramContinueInput,
  DeployTelegramStartInput,
} from '../../shared/deployServerBackupsTypes';
import { IPC } from '../../shared/ipcChannels';
import type { ServerRestores } from '../deploy/serverBackups/restore';
import type { ServerBackups } from '../deploy/serverBackups/service';
import { type DeployIpcRegistry, object, optionalText, serverId } from './deploy';

/**
 * The Backups section's channels (E28). Main window only, and every argument checked here before
 * the core hears of it; the core checks again and decides who may do what. Credentials pass
 * straight through to the core, which seals them. A refresh token is never taken from the
 * renderer (only the main process's own sign-in makes one), and a file to restore is named by the
 * token the open dialog gave out, never by a path.
 */

export interface DeployServerBackupsHandlerDeps {
  ipc: DeployIpcRegistry;
  backups: ServerBackups;
  restores: Pick<ServerRestores, 'restore' | 'bringUp'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: ReadonlySet<BackupDestinationKind> = new Set([
  'folder',
  'ftp',
  'sftp',
  'googleDrive',
  'oneDrive',
  'telegram',
]);
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const API_HASH = /^[0-9a-f]{32}$/i;
const PHONE = /^\+?[0-9 ()-]{5,24}$/;
const MAX_NAME = 100;
const MAX_FIELD = 1024;
const MAX_KEY = 16 * 1024;
const MAX_PASSWORD = 1024;
const MAX_IDS = 50;
/** Parts of at least 1 MiB and at most 100 GiB. */
const MIN_PART = 1024 * 1024;
const MAX_PART = 100 * 1024 ** 3;

function guid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

function optionalGuid(value: unknown, what: string): string | undefined {
  return value === undefined || value === null ? undefined : guid(value, what);
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`The ${what} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
  what: string,
): number | undefined {
  return value === undefined || value === null ? undefined : integer(value, min, max, what);
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say whether ${what}.`);
  return value;
}

function optionalFlag(value: unknown, what: string): boolean | undefined {
  return value === undefined || value === null ? undefined : flag(value, what);
}

/** One line of text, as a secret key or a password is. */
function line(value: unknown, max: number, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`Enter the ${what}.`);
  }
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NAME) {
    throw new Error(`A name has 1 to ${MAX_NAME} characters.`);
  }
  return value.trim();
}

function ids(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_IDS) {
    throw new Error(min > 0 ? 'Pick at least one destination.' : 'Pick the destinations again.');
  }
  return value.map((item) => guid(item, 'destination'));
}

function settings(value: unknown): BackupDestinationSettings {
  const input = object(value ?? {}, 'destination settings');
  const out: BackupDestinationSettings = {};
  const strings = [
    'path',
    'host',
    'userName',
    'hostKeySha256',
    'clientId',
    'folderName',
    'accountName',
    'chat',
  ] as const;
  for (const key of strings) {
    const found = optionalText(input[key], MAX_FIELD, key);
    if (found !== undefined) out[key] = found;
  }
  const port = optionalInteger(input.port, 1, 65_535, 'port');
  if (port !== undefined) out.port = port;
  const apiId = optionalInteger(input.apiId, 1, 2_147_483_647, 'api_id');
  if (apiId !== undefined) out.apiId = apiId;
  const tls = optionalFlag(input.tls, 'to use TLS');
  if (tls !== undefined) out.tls = tls;
  const premium = optionalFlag(input.isPremium, 'the account has Premium');
  if (premium !== undefined) out.isPremium = premium;
  return out;
}

function secret(value: unknown): BackupDestinationSecret | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, 'destination credentials');
  const out: BackupDestinationSecret = {};
  const limits = {
    password: MAX_PASSWORD,
    privateKey: MAX_KEY,
    privateKeyPassphrase: MAX_PASSWORD,
    clientSecret: MAX_FIELD,
    apiHash: MAX_FIELD,
    telegramLoginId: MAX_FIELD,
  } as const;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const found = optionalText(input[key], limits[key], key);
    if (found !== undefined) out[key] = found;
  }
  // A refresh token only ever comes from this process's own sign-in, never from a window. No
  // credentials at all means "keep the stored ones", which the core reads from a missing secret.
  return Object.keys(out).length > 0 ? out : undefined;
}

function destination(value: unknown): SaveBackupDestinationRequest {
  const input = object(value, 'a destination');
  if (typeof input.kind !== 'string' || !KINDS.has(input.kind as BackupDestinationKind)) {
    throw new Error('That is not a kind of destination this app knows.');
  }
  const id = optionalGuid(input.id, 'destination');
  const credentials = secret(input.secret);
  const maxPartBytes = optionalInteger(input.maxPartBytes, MIN_PART, MAX_PART, 'part size');
  return {
    ...(id ? { id } : {}),
    name: name(input.name),
    kind: input.kind as BackupDestinationKind,
    settings: settings(input.settings),
    ...(credentials ? { secret: credentials } : {}),
    ...(maxPartBytes ? { maxPartBytes } : {}),
  };
}

function destinationInput(value: unknown): DeployBackupDestinationInput {
  const input = object(value, 'a destination');
  return { serverId: serverId(input.serverId), destination: destination(input.destination) };
}

function itemInput(value: unknown, what: string): DeployBackupItemInput {
  const input = object(value, what);
  return { serverId: serverId(input.serverId), id: guid(input.id, what) };
}

function secretInput(value: unknown): DeployBackupSecretInput {
  const input = object(value, 'a secret key');
  const current =
    input.currentSecret === undefined || input.currentSecret === null || input.currentSecret === ''
      ? undefined
      : line(input.currentSecret, MAX_PASSWORD, 'current secret key');
  return {
    serverId: serverId(input.serverId),
    newSecret: line(input.newSecret, MAX_PASSWORD, 'new secret key'),
    ...(current ? { currentSecret: current } : {}),
  };
}

function timeZone(value: unknown): string {
  if (typeof value !== 'string' || !TIME_ZONE.test(value)) throw new Error('Pick a time zone.');
  return value;
}

function cron(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new Error('Pick when the plan runs.');
  }
  return value.trim();
}

function keep(input: Record<string, unknown>) {
  const keepDays = optionalInteger(input.keepDays, 1, 3650, 'number of days to keep');
  return {
    keepLast: integer(input.keepLast, 1, 1000, 'number of backups to keep'),
    ...(keepDays ? { keepDays } : {}),
  };
}

function planInput(value: unknown): { serverId: string; plan: SaveBackupPlanRequest } {
  const outer = object(value, 'a plan');
  const input = object(outer.plan, 'a plan');
  const id = optionalGuid(input.id, 'plan');
  return {
    serverId: serverId(outer.serverId),
    plan: {
      ...(id ? { id } : {}),
      name: name(input.name),
      enabled: flag(input.enabled, 'the plan is on'),
      cron: cron(input.cron),
      timeZone: timeZone(input.timeZone),
      ...keep(input),
      destinationIds: ids(input.destinationIds, 1),
    },
  };
}

function previewInput(value: unknown): { serverId: string; preview: BackupPlanPreviewRequest } {
  const outer = object(value, 'a plan');
  const input = object(outer.preview, 'a plan');
  const planId = optionalGuid(input.planId, 'plan');
  return {
    serverId: serverId(outer.serverId),
    preview: {
      ...(planId ? { planId } : {}),
      cron: cron(input.cron),
      timeZone: timeZone(input.timeZone),
      ...keep(input),
    },
  };
}

function runNowInput(value: unknown): DeployBackupNowInput {
  const input = object(value, 'a backup');
  return {
    serverId: serverId(input.serverId),
    destinationIds: ids(input.destinationIds, 0),
    download: flag(input.download, 'to save it on this computer'),
  };
}

function runInput(value: unknown): DeployBackupRunInput {
  const input = object(value, 'a backup run');
  return { serverId: serverId(input.serverId), runId: guid(input.runId, 'backup run') };
}

function storedInput(value: unknown): DeployStoredBackupInput {
  const input = object(value, 'a backup');
  return {
    serverId: serverId(input.serverId),
    destinationId: guid(input.destinationId, 'destination'),
    backupId: guid(input.backupId, 'backup'),
  };
}

function cloudInput(value: unknown): DeployCloudDriveInput {
  const input = object(value, 'a cloud drive');
  if (input.kind !== 'googleDrive' && input.kind !== 'oneDrive') {
    throw new Error('Sign in is for Google Drive or OneDrive.');
  }
  const destinationId = optionalGuid(input.destinationId, 'destination');
  const clientSecret = optionalText(input.clientSecret, MAX_FIELD, 'client secret');
  const maxPartBytes = optionalInteger(input.maxPartBytes, MIN_PART, MAX_PART, 'part size');
  return {
    serverId: serverId(input.serverId),
    ...(destinationId ? { destinationId } : {}),
    name: name(input.name),
    kind: input.kind,
    clientId: line(input.clientId, MAX_FIELD, 'client ID'),
    ...(clientSecret ? { clientSecret } : {}),
    folderName: line(input.folderName, 200, 'folder name'),
    ...(maxPartBytes ? { maxPartBytes } : {}),
  };
}

function telegramStart(value: unknown): DeployTelegramStartInput {
  const input = object(value, 'a Telegram sign-in');
  if (typeof input.apiHash !== 'string' || !API_HASH.test(input.apiHash)) {
    throw new Error('The api_hash is 32 letters and digits, as my.telegram.org shows it.');
  }
  if (typeof input.phoneNumber !== 'string' || !PHONE.test(input.phoneNumber)) {
    throw new Error('Enter the phone number with its country code, like +49 151 2345678.');
  }
  return {
    serverId: serverId(input.serverId),
    apiId: integer(input.apiId, 1, 2_147_483_647, 'api_id'),
    apiHash: input.apiHash,
    phoneNumber: input.phoneNumber,
  };
}

function telegramContinue(value: unknown): DeployTelegramContinueInput {
  const input = object(value, 'a Telegram sign-in');
  const code = optionalText(input.code, 16, 'code');
  const password = optionalText(input.password, MAX_PASSWORD, 'cloud password');
  return {
    serverId: serverId(input.serverId),
    loginId: line(input.loginId, 200, 'sign-in'),
    ...(code ? { code } : {}),
    ...(password ? { password } : {}),
  };
}

function restoreSource(value: unknown): DeployServerRestoreSource {
  const input = object(value, 'where the backup comes from');
  if (input.kind === 'file') {
    if (typeof input.fileToken !== 'string' || !GUID.test(input.fileToken)) {
      throw new Error('Pick the backup file again.');
    }
    return { kind: 'file', fileToken: input.fileToken };
  }
  if (input.kind === 'destination') {
    return {
      kind: 'destination',
      serverId: serverId(input.serverId),
      destinationId: guid(input.destinationId, 'destination'),
      backupId: guid(input.backupId, 'backup'),
    };
  }
  throw new Error('Pick the backup to restore again.');
}

function restoreInput(value: unknown): DeployServerRestoreInput {
  const input = object(value, 'a restore');
  if (typeof input.userName !== 'string' || !USER_NAME.test(input.userName)) {
    throw new Error('A user name has 1 to 64 letters, digits, dots, dashes, underscores or @.');
  }
  return {
    serverId: serverId(input.serverId),
    source: restoreSource(input.source),
    secret: line(input.secret, MAX_PASSWORD, 'secret key'),
    sudoPassword:
      input.sudoPassword === null || input.sudoPassword === undefined || input.sudoPassword === ''
        ? null
        : line(input.sudoPassword, MAX_PASSWORD, 'sudo password'),
    userName: input.userName,
    password: line(input.password, MAX_PASSWORD, 'password'),
  };
}

function bringUpInput(value: unknown): DeployBringUpInput {
  const input = object(value, 'a restore');
  if (typeof input.moveAddresses !== 'boolean') {
    throw new Error('Say whether to move the settings to the new address.');
  }
  const password = optionalText(input.password, MAX_PASSWORD, 'password');
  const totpCode = optionalText(input.totpCode, 16, 'authenticator code');
  return {
    serverId: serverId(input.serverId),
    moveAddresses: input.moveAddresses,
    ...(password ? { password } : {}),
    ...(totpCode ? { totpCode } : {}),
  };
}

export function registerDeployServerBackupsHandlers(deps: DeployServerBackupsHandlerDeps): void {
  const { ipc, backups, restores } = deps;
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployServerBackups.getSecret, (id) => backups.secret(serverId(id)));
  handle(IPC.deployServerBackups.setSecret, (value) => backups.setSecret(secretInput(value)));
  handle(IPC.deployServerBackups.listDestinations, (id) => backups.destinations(serverId(id)));
  handle(IPC.deployServerBackups.saveDestination, (value) =>
    backups.saveDestination(destinationInput(value)),
  );
  handle(IPC.deployServerBackups.deleteDestination, (value) =>
    backups.deleteDestination(itemInput(value, 'destination')),
  );
  handle(IPC.deployServerBackups.testDestination, (value) =>
    backups.testDestination(destinationInput(value)),
  );
  handle(IPC.deployServerBackups.connectCloudDrive, (value) =>
    backups.connectCloudDrive(cloudInput(value)),
  );
  handle(IPC.deployServerBackups.cancelCloudSignIn, (id) =>
    backups.cancelCloudSignIn(serverId(id)),
  );
  handle(IPC.deployServerBackups.startTelegramLogin, (value) =>
    backups.startTelegramLogin(telegramStart(value)),
  );
  handle(IPC.deployServerBackups.continueTelegramLogin, (value) =>
    backups.continueTelegramLogin(telegramContinue(value)),
  );
  handle(IPC.deployServerBackups.listPlans, (id) => backups.plans(serverId(id)));
  handle(IPC.deployServerBackups.savePlan, (value) => {
    const input = planInput(value);
    return backups.savePlan(input.serverId, input.plan);
  });
  handle(IPC.deployServerBackups.deletePlan, (value) =>
    backups.deletePlan(itemInput(value, 'plan')),
  );
  handle(IPC.deployServerBackups.previewPlan, (value) => {
    const input = previewInput(value);
    return backups.previewPlan(input.serverId, input.preview);
  });
  handle(IPC.deployServerBackups.runPlan, (value) => backups.runPlan(itemInput(value, 'plan')));
  handle(IPC.deployServerBackups.runNow, (value) => backups.runNow(runNowInput(value)));
  handle(IPC.deployServerBackups.listRuns, (id, limit) =>
    backups.runs(serverId(id), integer(limit, 1, 200, 'number of runs')),
  );
  handle(IPC.deployServerBackups.getRun, (value) => backups.run(runInput(value)));
  handle(IPC.deployServerBackups.watchRun, (value) => backups.watchRun(runInput(value)));
  handle(IPC.deployServerBackups.stopWatchingRun, (value) => backups.stopWatching(runInput(value)));
  handle(IPC.deployServerBackups.downloadRun, (value) => backups.downloadRun(runInput(value)));
  handle(IPC.deployServerBackups.listStored, (value) =>
    backups.storedBackups(itemInput(value, 'destination')),
  );
  handle(IPC.deployServerBackups.deleteStored, (value) => backups.deleteStored(storedInput(value)));
  handle(IPC.deployServerBackups.downloadStored, (value) =>
    backups.downloadStored(storedInput(value)),
  );
  handle(IPC.deployServerBackups.pickFile, () => backups.pick());
  handle(IPC.deployServerBackups.restore, (value) => restores.restore(restoreInput(value)));
  handle(IPC.deployServerBackups.pendingRestore, (id) => backups.pendingRestore(serverId(id)));
  handle(IPC.deployServerBackups.restoreStatus, (id) => backups.serverRestoreStatus(serverId(id)));
  handle(IPC.deployServerBackups.bringUp, (value) => restores.bringUp(bringUpInput(value)));
}
