import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import type { SecretEnvelope, SshAuthMethod } from '../../../shared/apiTypes';
import { filesError } from '../../../shared/deployFilesErrors';
import type {
  FileSite,
  FileSiteCapabilities,
  FileSiteConnectionInput,
  FileSiteCustomLogin,
  FileSiteInput,
  FileSiteLastDeploy,
  FileSiteProtocol,
  FilesNeedsReview,
} from '../../../shared/deployFilesTypes';
import { encryptSecret, registerSealedSecretStore, type SealedSecretStore } from '../../ssh/vault';
import { VaultLockedError } from '../../ssh/vaultErrors';
import { store } from '../../store';
import { removeBaseFiles, writePrivateJson } from './bases';
import { removeHistory } from './history';
import type { StoredFileSite, StoredFileSiteConnection } from './types';

/**
 * The FTP and SFTP sites the user added in Deploy (E23), in `deploy-files.json` beside the other
 * stores in the app's data folder. The password or key passphrase of a login of the site's own is
 * only ever stored sealed with the Servers vault, moves with a passkey change, and never leaves
 * main: `toPublicFileSite` swaps it for a `hasSecret` flag. Every change goes through one queue,
 * so a deploy recording its result while the user edits the site cannot lose either.
 *
 * A record that does not check out is dropped rather than trusted. A file that is not JSON at all
 * is refused instead: writing over it would lose every site.
 */

const FILE = 'deploy-files.json';
const SITE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_LABEL = 120;
const MAX_HOST = 255;
const MAX_USER = 256;
const MAX_REMOTE_ROOT = 1024;
export const MAX_IGNORE_LINES = 200;
export const MAX_IGNORE_LINE = 500;
export const DEFAULT_QUIET_SECONDS = 5;
const MIN_QUIET_SECONDS = 2;
const MAX_QUIET_SECONDS = 120;

export interface FileSitesState {
  sites: StoredFileSite[];
}

const envelopeSchema = z.union([
  z.object({ mode: z.literal('safeStorage'), ciphertext: z.string() }),
  z.object({
    mode: z.literal('passphrase'),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  }),
]);

const time = z.number().int().nonnegative();
const nullableText = z.string().nullable();

const connectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), sshServerId: z.string().min(1).max(128) }),
  z.object({
    kind: z.literal('custom'),
    host: z.string().min(1).max(MAX_HOST),
    port: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(MAX_USER),
    authMethod: z.enum(['password', 'privateKey']),
    privateKeyPath: nullableText,
    hostKeyFingerprint: nullableText,
    tlsPin: nullableText,
    tlsServername: nullableText,
    secretEnvelope: envelopeSchema.nullable(),
  }),
]);

/**
 * Checks the shape only; the input rules belong to `cleanInput`. A local folder that is gone
 * stays (the site then says so), and a quiet period out of range is brought back in on read.
 */
const siteSchema = z.object({
  id: z.string().regex(SITE_ID),
  label: z.string(),
  protocol: z.enum(['sftp', 'ftps', 'ftp']),
  connection: connectionSchema,
  remoteRoot: z.string(),
  localFolder: z.string().min(1),
  projectIds: z.array(z.string()),
  deployOnSave: z.boolean(),
  quietSeconds: z.number(),
  ignorePatterns: z.array(z.string()),
  capabilities: z
    .object({
      atomicReplace: z.boolean(),
      mtime: z.enum(['exact', 'mdtm', 'none']),
      checkedAt: time,
    })
    .nullable(),
  lastDeploy: z
    .object({
      at: time,
      state: z.enum(['done', 'partial', 'failed', 'cancelled']),
      trigger: z.enum(['user', 'deployOnSave']),
      uploaded: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
  needsReview: z
    .object({
      reason: z.enum(['conflicts', 'massDelete', 'failed', 'paused']),
      message: z.string(),
      at: time,
    })
    .nullable(),
  createdAt: time,
  updatedAt: time,
});

function storePath(): string {
  return join(app.getPath('userData'), 'data', FILE);
}

const INVALID = Symbol('invalid');

/** The parsed file, null when there is none, and `INVALID` when it is not JSON. */
async function readRaw(): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(storePath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID;
  }
}

function parseSites(value: unknown): StoredFileSite[] {
  if (value === INVALID) {
    throw new Error(`${FILE} is not valid JSON. Fix or remove it to use FTP and SFTP sites.`);
  }
  const list =
    typeof value === 'object' && value !== null && Array.isArray((value as FileSitesState).sites)
      ? (value as FileSitesState).sites
      : [];
  const sites: StoredFileSite[] = [];
  for (const entry of list) {
    const parsed = siteSchema.safeParse(entry);
    if (!parsed.success) {
      const id = (entry as { id?: unknown } | null)?.id;
      // biome-ignore lint/suspicious/noConsole: a dropped site should be visible, not silently missing
      console.warn(
        `[deploy-files] dropped site record ${typeof id === 'string' ? id : '(no id)'}: it does not check out`,
      );
      continue;
    }
    if (sites.some((site) => site.id === parsed.data.id)) continue;
    const site = parsed.data as StoredFileSite;
    site.quietSeconds = cleanQuietSeconds(site.quietSeconds);
    sites.push(site);
  }
  return sites;
}

let queue: Promise<unknown> = Promise.resolve();

/** Told the sites as saved after every write, whatever made it (an edit, a deploy, a prune). */
export type FileSitesListener = (sites: StoredFileSite[]) => void;

const changeListeners = new Set<FileSitesListener>();

/** Listens for writes to the store. Returns a function that stops listening. */
export function onFileSitesChanged(listener: FileSitesListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function tellListeners(sites: StoredFileSite[]): void {
  for (const listener of changeListeners) {
    try {
      listener(structuredClone(sites));
    } catch {
      // A listener that fails must not fail the write, which is already on disk.
    }
  }
}

export async function readFileSites(): Promise<StoredFileSite[]> {
  await queue;
  return parseSites(await readRaw());
}

export async function getFileSite(id: string): Promise<StoredFileSite | null> {
  return (await readFileSites()).find((site) => site.id === id) ?? null;
}

/**
 * Reads the sites, lets `change` edit them in place, and writes them back if anything changed.
 * Changes run one after another; one that throws writes nothing and does not stop the next.
 */
export function mutateFileSites<T>(change: (state: FileSitesState) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const state: FileSitesState = { sites: parseSites(await readRaw()) };
    const before = JSON.stringify(state.sites);
    const result = await change(state);
    if (JSON.stringify(state.sites) !== before) {
      await writePrivateJson(storePath(), { version: 1, sites: state.sites });
      tellListeners(state.sites);
    }
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** The site as the renderer may see it: the sealed secret becomes `hasSecret`. */
export function toPublicFileSite(stored: StoredFileSite): FileSite {
  const { connection } = stored;
  return {
    id: stored.id,
    label: stored.label,
    protocol: stored.protocol,
    connection:
      connection.kind === 'saved'
        ? { kind: 'saved', sshServerId: connection.sshServerId }
        : {
            kind: 'custom',
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authMethod: connection.authMethod,
            privateKeyPath: connection.privateKeyPath,
            hostKeyFingerprint: connection.hostKeyFingerprint,
            tlsPin: connection.tlsPin,
            tlsServername: connection.tlsServername,
            hasSecret: connection.secretEnvelope !== null,
          },
    remoteRoot: stored.remoteRoot,
    localFolder: stored.localFolder,
    projectIds: [...stored.projectIds],
    deployOnSave: stored.deployOnSave,
    quietSeconds: stored.quietSeconds,
    ignorePatterns: [...stored.ignorePatterns],
    capabilities: stored.capabilities ? { ...stored.capabilities } : null,
    lastDeploy: stored.lastDeploy ? { ...stored.lastDeploy } : null,
    needsReview: stored.needsReview ? { ...stored.needsReview } : null,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/** Moves every sealed secret when the Servers passkey changes (see ssh/vault.ts). */
export const fileSitesSealedStore: SealedSecretStore = {
  prepare: async (move) => {
    /** By site: the envelope that was moved, and what it became. */
    const moved = new Map<string, { from: string; to: SecretEnvelope }>();
    for (const site of await readFileSites()) {
      const { connection } = site;
      if (connection.kind === 'custom' && connection.secretEnvelope) {
        moved.set(site.id, {
          from: connection.secretEnvelope.ciphertext,
          to: await move(connection.secretEnvelope),
        });
      }
    }
    return () =>
      mutateFileSites(async (state) => {
        for (const site of state.sites) {
          const { connection } = site;
          if (connection.kind !== 'custom' || !connection.secretEnvelope) continue;
          const prepared = moved.get(site.id);
          if (prepared && connection.secretEnvelope.ciphertext === prepared.from) {
            connection.secretEnvelope = prepared.to;
            continue;
          }
          // Saved since the move was prepared (an edit with a new secret, a new site): sealed
          // with the key that is about to go, so it moves now. Writing the prepared one over it
          // would bring back the old secret.
          try {
            connection.secretEnvelope = await move(connection.secretEnvelope);
          } catch {
            // Left as it is; the site then asks for its password again.
          }
        }
      });
  },
};

/** Registers the store with the vault. Returns a function that unregisters it again. */
export function registerFileSitesSealedStore(): () => void {
  return registerSealedSecretStore(fileSitesSealedStore);
}

function invalid(message: string): Error {
  return filesError('invalidInput', message);
}

function cleanProtocol(value: unknown): FileSiteProtocol {
  if (value === 'sftp' || value === 'ftps' || value === 'ftp') return value;
  throw invalid('Pick SFTP, FTPS or FTP as the protocol.');
}

function cleanLabel(value: unknown): string {
  const label = String(value ?? '').trim();
  if (!label) throw invalid('Give the site a name.');
  if (label.length > MAX_LABEL) throw invalid(`Keep the name to ${MAX_LABEL} characters.`);
  return label;
}

/** An absolute POSIX path, tidied: no empty or `.` segments and no trailing slash. */
export function cleanRemoteRoot(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.includes('\\')) {
    throw invalid('Use forward slashes in the remote folder, not backslashes.');
  }
  if (!text.startsWith('/')) {
    throw invalid('The remote folder must be a full path on the server, starting with /.');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw invalid('The remote folder cannot hold control characters.');
  }
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw invalid('The remote folder cannot contain .. segments.');
  const cleaned = `/${segments.join('/')}`;
  if (cleaned.length > MAX_REMOTE_ROOT) {
    throw invalid(`Keep the remote folder to ${MAX_REMOTE_ROOT} characters.`);
  }
  return cleaned;
}

function samePath(a: string, b: string): boolean {
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  return insensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function realOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * The deploy folder by its real path. It must exist and be a folder, and it cannot be a whole
 * drive, the home folder itself, or anywhere near AgentMate's own data, so a deploy can never send
 * a whole disk or the app's sealed stores.
 */
async function cleanLocalFolder(value: unknown): Promise<string> {
  const text = String(value ?? '').trim();
  if (!text || !isAbsolute(text)) {
    throw invalid('Pick the deploy folder on this computer (a full path).');
  }
  let resolved: string;
  try {
    resolved = await realpath(text);
  } catch {
    throw invalid('That deploy folder does not exist.');
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw invalid('The deploy folder must be a folder, not a file.');
  }
  if (samePath(parse(resolved).root, resolved)) {
    throw invalid('The deploy folder cannot be the root of a drive. Pick the folder of the site.');
  }
  const home = await realOrSelf(app.getPath('home'));
  if (samePath(home, resolved)) {
    throw invalid(
      'The deploy folder cannot be your home folder itself. Pick the folder of the site.',
    );
  }
  const userData = await realOrSelf(app.getPath('userData'));
  if (
    samePath(userData, resolved) ||
    isInside(resolved, userData) ||
    isInside(userData, resolved)
  ) {
    throw invalid("The deploy folder cannot be inside AgentMate's own data folder.");
  }
  return resolved;
}

async function cleanProjectIds(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) throw invalid('The projects must be a list.');
  const ids = [...new Set(value.map((id) => String(id)))];
  if (ids.length === 0) return ids;
  const live = new Set((await store.getProjects()).map((project) => project.id));
  if (ids.some((id) => !live.has(id))) {
    throw filesError('projectUnknown', 'One of the projects no longer exists.');
  }
  return ids;
}

function cleanQuietSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_QUIET_SECONDS;
  return Math.min(MAX_QUIET_SECONDS, Math.max(MIN_QUIET_SECONDS, Math.round(seconds)));
}

function cleanIgnorePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid('The ignore lines must be a list of text lines.');
  const lines: string[] = [];
  for (const line of value) {
    if (typeof line !== 'string') throw invalid('Each ignore line must be text.');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_IGNORE_LINE) {
      throw invalid(`Keep each ignore line to ${MAX_IGNORE_LINE} characters.`);
    }
    lines.push(trimmed);
  }
  if (lines.length > MAX_IGNORE_LINES) {
    throw invalid(`Keep the ignore list to ${MAX_IGNORE_LINES} lines.`);
  }
  return lines;
}

function cleanHostName(value: unknown, message: string): string {
  const host = String(value ?? '').trim();
  if (!host || /\s/.test(host) || host.length > MAX_HOST) throw invalid(message);
  return host;
}

/** A cleaned connection, still with the secret just typed (if any) unsealed. */
export type CleanFileSiteConnection =
  | { kind: 'saved'; sshServerId: string }
  | (Omit<FileSiteCustomLogin, 'hostKeyFingerprint' | 'tlsPin'> & { secret: string | null });

/**
 * Checks the connection part of a site. A saved server must be SFTP and still saved in Remote;
 * FTP and FTPS always sign in with a password. A trusted host key or certificate is never taken
 * from here: it is only stored after the server was read again (`setHostKeyFingerprint`).
 */
export async function cleanFileSiteConnection(
  protocol: FileSiteProtocol,
  connection: FileSiteConnectionInput,
): Promise<CleanFileSiteConnection> {
  if (connection?.kind === 'saved') {
    if (protocol !== 'sftp') throw invalid('A server saved in Remote can only be used over SFTP.');
    const id = String(connection.sshServerId ?? '');
    const servers = await store.getSshServers();
    if (!servers.some((server) => server.id === id)) {
      throw invalid('That saved server no longer exists.');
    }
    return { kind: 'saved', sshServerId: id };
  }
  if (connection?.kind !== 'custom') throw invalid('Pick a saved server or enter a login.');

  const host = cleanHostName(connection.host, 'Enter the server host name, without spaces.');
  const port = Number(connection.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid('The port must be a whole number from 1 to 65535.');
  }
  const username = String(connection.username ?? '').trim();
  if (!username || username.length > MAX_USER) {
    throw invalid('Enter the username to sign in with.');
  }
  const authMethod: SshAuthMethod =
    protocol === 'sftp' && connection.authMethod === 'privateKey' ? 'privateKey' : 'password';
  let privateKeyPath: string | null = null;
  if (authMethod === 'privateKey') {
    const keyPath = String(connection.privateKeyPath ?? '').trim();
    if (!keyPath || !isAbsolute(keyPath)) {
      throw invalid('Pick the private key file to sign in with (a full path).');
    }
    privateKeyPath = keyPath;
  }
  const servername = protocol === 'ftps' ? String(connection.tlsServername ?? '').trim() : '';
  const tlsServername = servername
    ? cleanHostName(servername, 'Enter the certificate name without spaces.')
    : null;
  const secret =
    typeof connection.secret === 'string' && connection.secret ? connection.secret : null;
  return {
    kind: 'custom',
    host,
    port,
    username,
    authMethod,
    privateKeyPath,
    tlsServername,
    secret,
  };
}

type CustomLike = Pick<FileSiteCustomLogin, 'host' | 'port' | 'username' | 'authMethod'>;

/**
 * Whether a stored secret still means the same thing for this login. A password for one user on
 * one server is not a password for another, and a login password is not a key passphrase, so any
 * of those changing without a new secret drops the stored one.
 */
export function reusesStoredSecret(
  existing: Pick<StoredFileSite, 'protocol'> & { connection: StoredFileSiteConnection },
  protocol: FileSiteProtocol,
  login: CustomLike,
): boolean {
  const prior = existing.connection;
  return (
    prior.kind === 'custom' &&
    existing.protocol === protocol &&
    prior.authMethod === login.authMethod &&
    prior.host === login.host &&
    prior.port === login.port &&
    prior.username === login.username
  );
}

/** A trusted host key or certificate only means something for the endpoint it was read from. */
export function keepsTrust(
  existing: Pick<StoredFileSite, 'protocol'> & { connection: StoredFileSiteConnection },
  protocol: FileSiteProtocol,
  login: Pick<FileSiteCustomLogin, 'host' | 'port'>,
): boolean {
  const prior = existing.connection;
  return (
    prior.kind === 'custom' &&
    existing.protocol === protocol &&
    prior.host === login.host &&
    prior.port === login.port
  );
}

async function seal(secret: string): Promise<SecretEnvelope> {
  try {
    return await encryptSecret(secret);
  } catch (error) {
    if (error instanceof VaultLockedError || (error as Error)?.name === 'VaultLockedError') {
      throw filesError(
        'vaultLocked',
        'Unlock the Servers vault with your passkey to save this login.',
      );
    }
    throw error;
  }
}

/** The secret just typed, sealed; null when none was. */
async function sealTyped(cleaned: CleanFileSiteConnection): Promise<SecretEnvelope | null> {
  return cleaned.kind === 'custom' && cleaned.secret ? seal(cleaned.secret) : null;
}

/**
 * The connection to store. `existing` must be read in the same store change that writes the
 * result, so a stored secret it keeps is the one on disk then (a passkey change may have just
 * moved it).
 */
function storedConnection(
  protocol: FileSiteProtocol,
  cleaned: CleanFileSiteConnection,
  existing: StoredFileSite | null,
  sealed: SecretEnvelope | null,
): StoredFileSiteConnection {
  if (cleaned.kind === 'saved') return cleaned;
  const prior = existing?.connection.kind === 'custom' ? existing.connection : null;
  const { secret: _secret, ...login } = cleaned;
  let secretEnvelope: SecretEnvelope | null = sealed;
  if (!secretEnvelope && prior && existing && reusesStoredSecret(existing, protocol, login)) {
    secretEnvelope = prior.secretEnvelope;
  }
  const trusted = prior && existing && keepsTrust(existing, protocol, login) ? prior : null;
  return {
    ...login,
    hostKeyFingerprint: trusted?.hostKeyFingerprint ?? null,
    tlsPin: trusted?.tlsPin ?? null,
    secretEnvelope,
  };
}

/** Where the server side of a site points; what Test connection found holds only for that. */
function serverKey(site: Pick<StoredFileSite, 'protocol' | 'connection' | 'remoteRoot'>): string {
  const { connection } = site;
  const endpoint =
    connection.kind === 'saved'
      ? ['saved', connection.sshServerId]
      : ['custom', connection.host, connection.port, connection.username];
  return JSON.stringify([site.protocol, ...endpoint, site.remoteRoot]);
}

interface CleanedSite {
  label: string;
  protocol: FileSiteProtocol;
  connection: CleanFileSiteConnection;
  remoteRoot: string;
  localFolder: string;
  projectIds: string[];
  deployOnSave: boolean;
  quietSeconds: number;
  ignorePatterns: string[];
}

async function cleanInput(input: FileSiteInput): Promise<CleanedSite> {
  if (typeof input !== 'object' || input === null) throw invalid('The site is missing.');
  const label = cleanLabel(input.label);
  const protocol = cleanProtocol(input.protocol);
  const connection = await cleanFileSiteConnection(protocol, input.connection);
  const remoteRoot = cleanRemoteRoot(input.remoteRoot);
  const localFolder = await cleanLocalFolder(input.localFolder);
  const ignorePatterns = cleanIgnorePatterns(input.ignorePatterns);
  const projectIds = await cleanProjectIds(input.projectIds);
  return {
    label,
    protocol,
    connection,
    remoteRoot,
    localFolder,
    projectIds,
    deployOnSave: input.deployOnSave === true,
    quietSeconds: cleanQuietSeconds(input.quietSeconds),
    ignorePatterns,
  };
}

/** Checks and saves a new site. The secret typed in, if any, is sealed before it is written. */
export async function createFileSite(
  input: FileSiteInput,
  now: number = Date.now(),
): Promise<StoredFileSite> {
  const cleaned = await cleanInput(input);
  const connection = storedConnection(
    cleaned.protocol,
    cleaned.connection,
    null,
    await sealTyped(cleaned.connection),
  );
  const site: StoredFileSite = {
    id: randomUUID(),
    ...cleaned,
    connection,
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: now,
    updatedAt: now,
  };
  await mutateFileSites((state) => {
    state.sites.push(site);
  });
  return site;
}

/**
 * Checks and saves an edit. A left-out secret keeps the stored one while the login is the same;
 * moving to another host or port forgets the trusted host key and certificate; pointing the site
 * at another server or folder forgets what Test connection found there.
 */
export async function updateFileSite(
  id: string,
  input: FileSiteInput,
  now: number = Date.now(),
): Promise<StoredFileSite> {
  const cleaned = await cleanInput(input);
  if (!(await getFileSite(id))) throw filesError('siteUnknown', 'That site no longer exists.');
  const sealed = await sealTyped(cleaned.connection);
  return mutateFileSites((state) => {
    const index = state.sites.findIndex((site) => site.id === id);
    if (index < 0) throw filesError('siteUnknown', 'That site no longer exists.');
    const current = state.sites[index];
    // Read here, in the same change as the write, never from a read made before it.
    const connection = storedConnection(cleaned.protocol, cleaned.connection, current, sealed);
    const next: StoredFileSite = {
      ...current,
      ...cleaned,
      connection,
      updatedAt: now,
    };
    if (serverKey(next) !== serverKey(current)) next.capabilities = null;
    state.sites[index] = next;
    return next;
  });
}

/** Removes the site and what this computer kept about it. Files on the server are not touched. */
export async function removeFileSite(id: string): Promise<boolean> {
  const removed = await mutateFileSites((state) => {
    const before = state.sites.length;
    state.sites = state.sites.filter((site) => site.id !== id);
    return state.sites.length !== before;
  });
  if (!removed) return false;
  await removeBaseFiles(id);
  await removeHistory(id);
  return true;
}

/** Applies `change` to one site and gives it back, or null when the site is gone. */
function updateOne(
  id: string,
  change: (site: StoredFileSite) => void,
): Promise<StoredFileSite | null> {
  return mutateFileSites((state) => {
    const site = state.sites.find((one) => one.id === id);
    if (!site) return null;
    change(site);
    return site;
  });
}

export function setNeedsReview(
  id: string,
  needsReview: FilesNeedsReview | null,
): Promise<StoredFileSite | null> {
  return updateOne(id, (site) => {
    site.needsReview = needsReview ? { ...needsReview } : null;
  });
}

export function setLastDeploy(
  id: string,
  lastDeploy: FileSiteLastDeploy | null,
): Promise<StoredFileSite | null> {
  return updateOne(id, (site) => {
    site.lastDeploy = lastDeploy ? { ...lastDeploy } : null;
  });
}

export function setCapabilities(
  id: string,
  capabilities: FileSiteCapabilities | null,
): Promise<StoredFileSite | null> {
  return updateOne(id, (site) => {
    site.capabilities = capabilities ? { ...capabilities } : null;
  });
}

export function setDeployOnSave(id: string, enabled: boolean): Promise<StoredFileSite | null> {
  return updateOne(id, (site) => {
    site.deployOnSave = enabled === true;
  });
}

function cleanFingerprint(value: string | null): string | null {
  if (value === null) return null;
  const fingerprint = String(value).trim().toLowerCase();
  if (!FINGERPRINT.test(fingerprint)) {
    throw invalid('That is not a SHA-256 fingerprint (64 hex digits).');
  }
  return fingerprint;
}

function customConnection(site: StoredFileSite) {
  if (site.connection.kind !== 'custom') {
    throw invalid('This site signs in through a server saved in Remote, which keeps its own key.');
  }
  return site.connection;
}

/** Stores the SFTP host key the user trusted, after it was read from the server again. */
export async function setHostKeyFingerprint(
  id: string,
  fingerprint: string | null,
): Promise<StoredFileSite | null> {
  const cleaned = cleanFingerprint(fingerprint);
  return updateOne(id, (site) => {
    customConnection(site).hostKeyFingerprint = cleaned;
  });
}

/** Pins the FTPS certificate the user trusted, after it was read from the server again. */
export async function setTlsPin(id: string, pin: string | null): Promise<StoredFileSite | null> {
  const cleaned = cleanFingerprint(pin);
  return updateOne(id, (site) => {
    customConnection(site).tlsPin = cleaned;
  });
}

/**
 * Lets go of projects that no longer exist and keeps the sites. Gives the ids of the sites that
 * changed.
 */
export function pruneFileSiteProjects(existingProjectIds: ReadonlySet<string>): Promise<string[]> {
  return mutateFileSites((state) => {
    const changed: string[] = [];
    for (const site of state.sites) {
      const kept = site.projectIds.filter((id) => existingProjectIds.has(id));
      if (kept.length === site.projectIds.length) continue;
      site.projectIds = kept;
      changed.push(site.id);
    }
    return changed;
  });
}

/**
 * Unlinks deleted projects from their sites; the sites stay. Takes the ids just removed, and also
 * sweeps against what is saved, which is how it catches what a restored backup left behind at
 * startup. Never throws: a disk error leaves the links for the next sweep.
 */
export async function pruneOrphanFileSites(removed: { projectIds?: string[] } = {}): Promise<void> {
  try {
    const gone = new Set(removed.projectIds ?? []);
    const live = new Set(
      (await store.getProjects()).map((project) => project.id).filter((id) => !gone.has(id)),
    );
    await pruneFileSiteProjects(live);
  } catch {
    // Left for the next launch.
  }
}
