import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isWpBase64UrlBytes,
  isWpConnectionId,
  validateWpItemPath,
  type WpFileMap,
  type WpScope,
} from '@runova/core';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { SealedSecretStore } from '../../ssh/vault';

/**
 * This computer's WordPress connections (E19), in `deploy-wordpress.json` beside the other Deploy
 * stores, and the last-synced file lists of WordPress projects, one file per project under
 * `wordpress/bases/`. Both live in the app's data folder, outside every project folder, so no
 * agent working in a project can change what the app believes the site holds.
 *
 * Each site's private key, and its HTTP Basic password when it has one, is only ever stored
 * sealed with the Servers vault, and moves with a passkey change. Anything unreadable is dropped
 * rather than trusted, and one write queue keeps two changes from losing each other.
 */

/** One connected site. Main process only: the renderer gets DeployWordPressSite. */
export interface StoredWpSite {
  id: string;
  label: string;
  /** From the connection key: home_url, the REST base, admin-ajax. */
  siteUrl: string;
  restUrl: string;
  ajaxUrl: string;
  /** From the site: rescue.php, kept only when it is on the same origin as the site. */
  rescueUrl: string | null;
  siteName: string;
  scope: WpScope;
  /** The site's Ed25519 public key from the connection key; every reply must verify with it. */
  sitePublicKey: string;
  connectionId: string;
  /** Unix seconds, from the site. */
  connectionExpiresAt: number | null;
  /** This computer's raw public key for the site, base64url. */
  publicKey: string;
  /** PKCS#8 PEM, sealed. */
  privateKey: SecretEnvelope;
  httpAuth: { username: string; password: SecretEnvelope } | null;
  allowPlainHttp: boolean;
  pluginVersion: string;
  protocol: number;
  /** Which URL answered last: decided at the first verified reply, then kept. */
  endpoint: 'rest' | 'ajax' | null;
  /** Seconds to add to this computer's clock to get the site's. */
  clockOffset: number;
  /** Milliseconds, this computer's clock. */
  connectedAt: number;
  lastSeenAt: number | null;
}

/**
 * A deploy that was started and has not been seen to finish. If the app stops part way, the next
 * contact with the site finds out how it ended: a deploy that reached `done` makes its pending
 * base the project's base; anything else is rolled back or dropped.
 */
export interface StoredWpInflight {
  siteId: string;
  deployId: string;
  projectId: string | null;
  operationId: string;
  /** Milliseconds. */
  startedAt: number;
}

export interface WordPressStateFile {
  version: 1;
  sites: StoredWpSite[];
  /** By site id: one deploy per site at a time. */
  inflight: Record<string, StoredWpInflight>;
}

export interface WordPressStatePort {
  /** The parsed file, or null when there is none or it is not JSON. */
  read: () => Promise<unknown>;
  write: (value: WordPressStateFile) => Promise<void>;
}

const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEPLOY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  if (!isObject(value) || typeof value.ciphertext !== 'string') return false;
  if (value.mode === 'safeStorage') return true;
  return (
    value.mode === 'passphrase' && typeof value.iv === 'string' && typeof value.authTag === 'string'
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSite(value: unknown): value is StoredWpSite {
  if (!isObject(value)) return false;
  const auth = value.httpAuth;
  return (
    typeof value.id === 'string' &&
    SITE_ID.test(value.id) &&
    typeof value.label === 'string' &&
    isHttpUrl(value.siteUrl) &&
    isHttpUrl(value.restUrl) &&
    isHttpUrl(value.ajaxUrl) &&
    (value.rescueUrl === null || isHttpUrl(value.rescueUrl)) &&
    typeof value.siteName === 'string' &&
    (value.scope === 'read' || value.scope === 'write') &&
    isWpBase64UrlBytes(value.sitePublicKey, 32) &&
    typeof value.connectionId === 'string' &&
    isWpConnectionId(value.connectionId) &&
    (value.connectionExpiresAt === null || isTime(value.connectionExpiresAt)) &&
    isWpBase64UrlBytes(value.publicKey, 32) &&
    isEnvelope(value.privateKey) &&
    (auth === null ||
      (isObject(auth) && typeof auth.username === 'string' && isEnvelope(auth.password))) &&
    typeof value.allowPlainHttp === 'boolean' &&
    typeof value.pluginVersion === 'string' &&
    typeof value.protocol === 'number' &&
    (value.endpoint === null || value.endpoint === 'rest' || value.endpoint === 'ajax') &&
    typeof value.clockOffset === 'number' &&
    Number.isSafeInteger(value.clockOffset) &&
    isTime(value.connectedAt) &&
    (value.lastSeenAt === null || isTime(value.lastSeenAt))
  );
}

function isInflight(value: unknown): value is StoredWpInflight {
  return (
    isObject(value) &&
    typeof value.siteId === 'string' &&
    SITE_ID.test(value.siteId) &&
    typeof value.deployId === 'string' &&
    DEPLOY_ID.test(value.deployId) &&
    (value.projectId === null ||
      (typeof value.projectId === 'string' && RECORD_ID.test(value.projectId))) &&
    typeof value.operationId === 'string' &&
    isTime(value.startedAt)
  );
}

function parse(value: unknown): WordPressStateFile {
  const file: WordPressStateFile = { version: 1, sites: [], inflight: {} };
  if (!isObject(value) || value.version !== 1) return file;
  for (const site of Array.isArray(value.sites) ? value.sites : []) {
    if (isSite(site) && !file.sites.some((other) => other.id === site.id)) file.sites.push(site);
  }
  if (isObject(value.inflight)) {
    for (const [siteId, record] of Object.entries(value.inflight)) {
      if (isInflight(record) && record.siteId === siteId) file.inflight[siteId] = record;
    }
  }
  return file;
}

export class WordPressState {
  private queue: Promise<unknown> = Promise.resolve();

  /** Moves every sealed secret when the Servers passkey changes (see vault.ts). */
  readonly sealedKeys: SealedSecretStore = {
    prepare: async (move) => {
      const moved = new Map<string, { privateKey: SecretEnvelope; password?: SecretEnvelope }>();
      for (const site of (await this.read()).sites) {
        moved.set(site.id, {
          privateKey: await move(site.privateKey),
          ...(site.httpAuth ? { password: await move(site.httpAuth.password) } : {}),
        });
      }
      return () =>
        this.update((file) => ({
          ...file,
          sites: file.sites.map((site) => {
            const next = moved.get(site.id);
            if (!next) return site;
            return {
              ...site,
              privateKey: next.privateKey,
              httpAuth:
                site.httpAuth && next.password
                  ? { ...site.httpAuth, password: next.password }
                  : site.httpAuth,
            };
          }),
        }));
    },
  };

  constructor(private readonly port: WordPressStatePort) {}

  async sites(): Promise<StoredWpSite[]> {
    return (await this.read()).sites;
  }

  async site(id: string): Promise<StoredWpSite | null> {
    return (await this.sites()).find((site) => site.id === id) ?? null;
  }

  /** Adds the site, or replaces the one with the same id. */
  saveSite(site: StoredWpSite): Promise<void> {
    return this.update((file) => {
      const index = file.sites.findIndex((other) => other.id === site.id);
      const sites = [...file.sites];
      if (index === -1) sites.push(site);
      else sites[index] = site;
      return { ...file, sites };
    });
  }

  /** Changes a saved site; null when it is gone. */
  async updateSite(
    id: string,
    change: (site: StoredWpSite) => StoredWpSite,
  ): Promise<StoredWpSite | null> {
    let updated: StoredWpSite | null = null;
    await this.update((file) => ({
      ...file,
      sites: file.sites.map((site) => {
        if (site.id !== id) return site;
        updated = { ...change(site), id };
        return updated;
      }),
    }));
    return updated;
  }

  /** Forgets the site and any deploy of it still marked as running. */
  removeSite(id: string): Promise<void> {
    return this.update((file) => {
      const { [id]: _inflight, ...inflight } = file.inflight;
      return { ...file, sites: file.sites.filter((site) => site.id !== id), inflight };
    });
  }

  async inflight(siteId: string): Promise<StoredWpInflight | null> {
    return (await this.read()).inflight[siteId] ?? null;
  }

  setInflight(record: StoredWpInflight): Promise<void> {
    return this.update((file) => ({
      ...file,
      inflight: { ...file.inflight, [record.siteId]: record },
    }));
  }

  /** Clears the site's running deploy, only if it is still the one named. */
  clearInflight(siteId: string, deployId: string): Promise<void> {
    return this.update((file) => {
      if (file.inflight[siteId]?.deployId !== deployId) return file;
      const { [siteId]: _done, ...inflight } = file.inflight;
      return { ...file, inflight };
    });
  }

  private async read(): Promise<WordPressStateFile> {
    await this.queue.catch(() => undefined);
    return parse(await this.port.read());
  }

  private update(change: (file: WordPressStateFile) => WordPressStateFile): Promise<void> {
    const next = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.port.write(change(parse(await this.port.read())));
      });
    this.queue = next;
    return next;
  }
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Written to a temporary name and renamed over, readable only by the user. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function wordPressStateFilePort(path: string): WordPressStatePort {
  return { read: () => readJson(path), write: (value) => writeJson(path, value) };
}

/** One item's files as last synced. */
export interface WpBaseItem {
  isFile: boolean;
  files: WpFileMap;
}

/** What a WordPress project and its site last agreed on, by `wpItemKey`. */
export interface WpBase {
  version: 1;
  siteId: string;
  /** The site's key when this was written, so a relink to the same site can keep it. */
  sitePublicKey: string;
  /** The origin of the site's REST address then: staging clones share a key, not an origin. */
  siteOrigin: string;
  /** Milliseconds. */
  updatedAt: number;
  items: Record<string, WpBaseItem>;
}

const ITEM_KEY = /^(theme|plugin|mu-plugin):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function parseFiles(value: unknown): WpFileMap {
  const files: WpFileMap = {};
  if (!isObject(value)) return files;
  for (const [path, entry] of Object.entries(value)) {
    if (!validateWpItemPath(path).ok || !isObject(entry)) continue;
    const { sha256, size } = entry;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256) || !isTime(size)) continue;
    files[path] = { sha256, size };
  }
  return files;
}

function parseBase(value: unknown): WpBase | null {
  if (!isObject(value) || value.version !== 1) return null;
  if (typeof value.siteId !== 'string' || !SITE_ID.test(value.siteId)) return null;
  if (!isWpBase64UrlBytes(value.sitePublicKey, 32)) return null;
  if (typeof value.siteOrigin !== 'string' || value.siteOrigin.length > 300) return null;
  if (!isTime(value.updatedAt)) return null;
  const items: Record<string, WpBaseItem> = {};
  if (isObject(value.items)) {
    for (const [key, item] of Object.entries(value.items)) {
      if (!ITEM_KEY.test(key) || !isObject(item) || typeof item.isFile !== 'boolean') continue;
      items[key] = { isFile: item.isFile, files: parseFiles(item.files) };
    }
  }
  return {
    version: 1,
    siteId: value.siteId,
    sitePublicKey: value.sitePublicKey,
    siteOrigin: value.siteOrigin,
    updatedAt: value.updatedAt,
    items,
  };
}

/**
 * The bases, `<root>/<projectId>.json`, plus `<projectId>.pending.json` for a deploy that has
 * not been seen to finish. A base that cannot be read counts as none, which makes the next plan
 * compare against nothing: every file shows as new on both sides, never as deleted.
 */
export class WordPressBases {
  constructor(private readonly root: string) {}

  private path(projectId: string, pending = false): string {
    if (!RECORD_ID.test(projectId)) throw new Error('That is not a project.');
    return join(this.root, `${projectId}${pending ? '.pending' : ''}.json`);
  }

  async read(projectId: string): Promise<WpBase | null> {
    return parseBase(await readJson(this.path(projectId)));
  }

  async write(projectId: string, base: WpBase): Promise<void> {
    await writeJson(this.path(projectId), base);
  }

  async readPending(projectId: string): Promise<WpBase | null> {
    return parseBase(await readJson(this.path(projectId, true)));
  }

  async writePending(projectId: string, base: WpBase): Promise<void> {
    await writeJson(this.path(projectId, true), base);
  }

  async dropPending(projectId: string): Promise<void> {
    await rm(this.path(projectId, true), { force: true });
  }

  /** Makes the pending base the base; false when there was none to promote. */
  async promotePending(projectId: string): Promise<boolean> {
    const pending = await this.readPending(projectId);
    if (!pending) return false;
    await this.write(projectId, pending);
    await this.dropPending(projectId);
    return true;
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.path(projectId), { force: true });
    await this.dropPending(projectId);
  }
}
