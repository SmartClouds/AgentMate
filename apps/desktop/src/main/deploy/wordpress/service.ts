import { randomUUID } from 'node:crypto';
import {
  encodeWpFrame,
  isValidWpSlug,
  isWpLegacyRestUrl,
  type ProjectWordPressItemKind,
  WP_ROUTES,
  type WpAuditEntry,
  type WpConnectorMigrateResponse,
  type WpConnectorUpdateRequest,
  type WpConnectorUpdateResponse,
  type WpDeployRecord,
  type WpDeployRollbackResponse,
  type WpDeployStateResponse,
  type WpHealthCheck,
  type WpItem,
  type WpItemRef,
  type WpSiteInfo,
  type WpUpdateRefusal,
  wpItemRoot,
  wpKeyTransportSecurity,
} from '@runova/core';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type {
  DeployWordPressAuditQuery,
  DeployWordPressConnectInput,
  DeployWordPressDeployResult,
  DeployWordPressDisconnectInput,
  DeployWordPressOperationKind,
  DeployWordPressPhase,
  DeployWordPressProgressEvent,
  DeployWordPressRollbackInput,
  DeployWordPressSaveZipResult,
  DeployWordPressSettingsInput,
  DeployWordPressSite,
  DeployWordPressSiteInfo,
  DeployWordPressUpdateConnectorResult,
} from '../../../shared/deployWordPressTypes';
import {
  wordPressError,
  wordPressErrorCode,
  wordPressErrorMessage,
} from '../../../shared/wordpressErrors';
import { VaultLockedError } from '../../ssh/vaultErrors';
import { WpClient, WpRemoteError, wpRequestCap } from './client';
import { type ConnectorBundle, compareConnectorVersions } from './connectorBundle';
import { gzipBytes, privateKeyFromPem } from './crypto';
import { checkPlainHttp, pairWithSite, sameOriginRescueUrl, wpDeviceName } from './pairing';
import { cleanSiteText } from './siteText';
import type { StoredWpSite, WordPressBases, WordPressState } from './state';
import type { WpTransport } from './transport';

/**
 * WordPress sites in Deploy (E19, E20): connecting with a key, the site's settings, its info,
 * items, deploy history and audit log, and manual rollbacks. One operation runs per site at a
 * time, and any of them can be cancelled by the operation id the renderer picked.
 *
 * Secrets stay here: the private key and the HTTP password are unsealed for a call and dropped
 * with it. A locked Servers vault stops every call that needs one with `[wp:vaultLocked]`.
 */

export interface WordPressServiceDeps {
  state: WordPressState;
  bases: WordPressBases;
  transport: WpTransport;
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  isLocked: (envelope: SecretEnvelope | undefined) => boolean;
  progress: (event: DeployWordPressProgressEvent) => void;
  /** os.hostname(); the site lists this computer under it. */
  hostname: () => string;
  saveConnectorZip: () => Promise<DeployWordPressSaveZipResult>;
  /** The connector that ships with the app, unpacked for an in-app update of a site. */
  readConnectorBundle: () => Promise<ConnectorBundle>;
  /**
   * The bridge package that ships with the app: the same connector in the folder 1.63 used, the
   * only update a 1.63 site takes. Without it such a site is updated by hand once.
   */
  readBridgeBundle?: () => Promise<ConnectorBundle>;
  /** Milliseconds. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const VAULT_LOCKED =
  'The Servers vault is locked. Unlock it with your passkey to use this WordPress site.';
const KINDS: ReadonlySet<string> = new Set<ProjectWordPressItemKind>([
  'theme',
  'plugin',
  'mu-plugin',
]);
const HISTORY_LIMIT = 50;
/** The site health-checks itself before and after the swap, so allow it more than a pull needs. */
const CONNECTOR_UPDATE_TIMEOUT_MS = 120_000;
/** What a refused connector update says, by the site's reason, in this app's own words. */
const UPDATE_REFUSED: Record<WpUpdateRefusal, string> = {
  downgrade:
    'The connector on the site is newer than the one that comes with this app, so it was left as it is.',
  badPackage:
    'The site did not accept the connector files that come with this app, so nothing was changed. Download the plugin and upload it in wp-admin instead.',
  requirements:
    'The newer connector needs a newer PHP or WordPress than this site has, so it was not installed. Nothing was changed.',
  notReplaceable:
    "The connector's folder on the site can't be replaced from here (it may be a symlink or not writable), so nothing was changed. Download the plugin and upload it in wp-admin instead.",
  downloadFailed: 'The site could not download the connector from GitHub, so nothing was changed.',
};
/** Errors after which the site has changed nothing, so the app sends the files itself. */
const DOWNLOAD_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'badRequest',
  'timeout',
  'unreachable',
  'foreignResponse',
]);
/** More themes and plugins than any site has; a longer list is cut here. */
export const MAX_LISTED_ITEMS = 2000;

/** Where a site path lives in a project folder, for messages: `wp-content/themes/x/a.php`. */
export function wpMessagePath(item: WpItemRef, path: string): string {
  return path === item.slug && item.kind !== 'theme'
    ? wpItemRoot(item)
    : `${wpItemRoot(item)}/${path}`;
}

/** The origin of a site's REST address, which tells a staging clone from the site it copies. */
export function wpSiteOrigin(restUrl: string): string {
  try {
    return new URL(restUrl).origin.toLowerCase();
  } catch {
    return '';
  }
}

/** One site: the same key and the same REST origin. */
export function sameWpSite(
  site: Pick<StoredWpSite, 'sitePublicKey' | 'restUrl'>,
  sitePublicKey: string,
  restUrl: string,
): boolean {
  const origin = wpSiteOrigin(restUrl);
  return (
    site.sitePublicKey === sitePublicKey && origin !== '' && wpSiteOrigin(site.restUrl) === origin
  );
}

export function publicSite(site: StoredWpSite): DeployWordPressSite {
  return {
    id: site.id,
    label: site.label,
    siteUrl: site.siteUrl,
    siteName: site.siteName,
    scope: site.scope,
    transport: wpKeyTransportSecurity(site),
    allowPlainHttp: site.allowPlainHttp,
    hasHttpAuth: site.httpAuth !== null,
    pluginVersion: site.pluginVersion,
    protocol: site.protocol,
    connectedAt: site.connectedAt,
    lastSeenAt: site.lastSeenAt,
  };
}

export function cleanItem(item: WpItem): WpItem | null {
  if (typeof item !== 'object' || item === null) return null;
  if (typeof item.kind !== 'string' || !KINDS.has(item.kind)) return null;
  if (typeof item.slug !== 'string' || !isValidWpSlug(item.slug)) return null;
  return {
    kind: item.kind,
    slug: item.slug,
    name: cleanSiteText(item.name, 200) || item.slug,
    version: cleanSiteText(item.version, 40),
    isFile: item.isFile === true,
    active: item.active === true,
    networkActive: item.networkActive === true,
    writable: item.writable === true,
    protected: item.protected === true,
    ...(typeof item.parentTheme === 'string' && isValidWpSlug(item.parentTheme)
      ? { parentTheme: item.parentTheme }
      : {}),
    ...(typeof item.mainFile === 'string' && item.mainFile.length > 0
      ? { mainFile: cleanSiteText(item.mainFile, 300) }
      : {}),
  };
}

function isEntry<T>(value: T): value is NonNullable<T> {
  return typeof value === 'object' && value !== null;
}

function cleanRecord(record: WpDeployRecord): WpDeployRecord {
  return {
    ...record,
    deployId: cleanSiteText(record.deployId, 64),
    label: cleanSiteText(record.label, 200),
    connectionLabel: cleanSiteText(record.connectionLabel, 100),
  };
}

function cleanAudit(entry: WpAuditEntry): WpAuditEntry {
  return {
    ...entry,
    connectionLabel:
      entry.connectionLabel === null ? null : cleanSiteText(entry.connectionLabel, 100),
    ip: cleanSiteText(entry.ip, 64),
    detail: cleanSiteText(entry.detail, 500),
  };
}

export function cleanInfo(info: WpSiteInfo): WpSiteInfo {
  return {
    ...info,
    siteName: cleanSiteText(info.siteName, 200),
    homeUrl: cleanSiteText(info.homeUrl, 2048),
    siteUrl: cleanSiteText(info.siteUrl, 2048),
    wpVersion: cleanSiteText(info.wpVersion, 40),
    phpVersion: cleanSiteText(info.phpVersion, 40),
    pluginVersion: cleanSiteText(info.pluginVersion, 40),
    filesystemMethod: cleanSiteText(info.filesystemMethod, 40),
    activeTheme: {
      stylesheet: cleanSiteText(info.activeTheme?.stylesheet, 100),
      template: cleanSiteText(info.activeTheme?.template, 100),
    },
    guard: {
      installed: info.guard?.installed === true,
      rescueUrl:
        typeof info.guard?.rescueUrl === 'string'
          ? cleanSiteText(info.guard.rescueUrl, 2048)
          : null,
    },
    connection: {
      ...info.connection,
      label: cleanSiteText(info.connection?.label, 100),
    },
    // Absent from a connector that predates the update route, and that is not the same as false.
    selfUpdate: typeof info.selfUpdate === 'boolean' ? info.selfUpdate : undefined,
    updateDownload: info.updateDownload === true ? true : undefined,
  };
}

/** How a running operation reports its steps. */
export type WpReport = (
  phase: DeployWordPressPhase,
  done: number,
  total: number,
  bytes?: number,
) => void;

interface RunningOperation {
  siteId: string;
  controller: AbortController;
}

export class WordPressService {
  protected readonly now: () => number;
  private readonly operations = new Map<string, RunningOperation>();

  constructor(protected readonly deps: WordPressServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async listSites(): Promise<DeployWordPressSite[]> {
    return (await this.deps.state.sites()).map(publicSite);
  }

  async connect(input: DeployWordPressConnectInput): Promise<DeployWordPressSite> {
    // The key is good once: make sure the result can be sealed before spending it.
    await this.seal('runova');
    const paired = await pairWithSite({
      connectionKey: input.connectionKey,
      allowPlainHttp: input.allowPlainHttp === true,
      httpAuth: input.httpAuth ?? null,
      transport: this.deps.transport,
      deviceName: wpDeviceName(this.deps.hostname()),
      now: this.now,
    });
    const privateKey = await this.seal(paired.keyPair.privateKeyPem);
    const httpAuth = input.httpAuth
      ? { username: input.httpAuth.username, password: await this.seal(input.httpAuth.password) }
      : null;
    const siteName = cleanSiteText(paired.pair.siteName || paired.hello.siteName, 200);
    // The same site connected again keeps its record (and its projects). Staging clones share the
    // site key, so the key alone is not enough: the REST address must match too.
    const existing = (await this.deps.state.sites()).find((site) =>
      sameWpSite(site, paired.sitePublicKey, paired.restUrl),
    );
    const now = this.now();
    const site: StoredWpSite = {
      id: existing?.id ?? randomUUID(),
      label: input.label ?? existing?.label ?? (siteName || new URL(paired.siteUrl).host),
      siteUrl: paired.siteUrl,
      restUrl: paired.restUrl,
      ajaxUrl: paired.ajaxUrl,
      rescueUrl: paired.rescueUrl,
      siteName,
      scope: paired.pair.scope,
      sitePublicKey: paired.sitePublicKey,
      connectionId: paired.pair.connectionId,
      connectionExpiresAt: typeof paired.pair.expiresAt === 'number' ? paired.pair.expiresAt : null,
      publicKey: paired.keyPair.publicKey,
      privateKey,
      httpAuth,
      allowPlainHttp: input.allowPlainHttp === true,
      pluginVersion: cleanSiteText(paired.hello.pluginVersion, 40),
      protocol: paired.hello.protocol,
      endpoint: paired.endpoint,
      clockOffset: paired.clockOffset,
      connectedAt: now,
      lastSeenAt: now,
    };
    await this.deps.state.saveSite(site);
    // Connected again from this computer: the old connection is retired on the site, if it can be.
    if (existing && existing.connectionId !== site.connectionId) {
      await this.revoke(existing).catch(() => undefined);
    }
    return publicSite(site);
  }

  async disconnect(input: DeployWordPressDisconnectInput): Promise<void> {
    const site = await this.requireSite(input.siteId);
    if (this.siteBusy(site.id)) {
      throw wordPressError(
        'operationBusy',
        'A pull or deploy for this site is still running. Wait for it, or stop it, first.',
      );
    }
    if (input.revokeOnSite) {
      try {
        await this.revoke(site);
      } catch (error) {
        // A revoke that cannot be signed is refused; one the site cannot take is skipped.
        if (wordPressErrorCode(error) === 'vaultLocked') throw error;
      }
    }
    await this.deps.state.removeSite(site.id);
  }

  async updateSettings(input: DeployWordPressSettingsInput): Promise<DeployWordPressSite> {
    await this.requireSite(input.siteId);
    let httpAuth: StoredWpSite['httpAuth'] | undefined;
    if (input.httpAuth === null) httpAuth = null;
    else if (input.httpAuth) {
      httpAuth = {
        username: input.httpAuth.username,
        password: await this.seal(input.httpAuth.password),
      };
    }
    const updated = await this.deps.state.updateSite(input.siteId, (site) => ({
      ...site,
      label: input.label ?? site.label,
      allowPlainHttp: input.allowPlainHttp ?? site.allowPlainHttp,
      httpAuth: httpAuth === undefined ? site.httpAuth : httpAuth,
    }));
    if (!updated) throw this.siteUnknown();
    return publicSite(updated);
  }

  async siteInfo(siteId: string): Promise<DeployWordPressSiteInfo> {
    return this.withSite(siteId, async (client, site) => {
      const info = cleanInfo((await client.call(WP_ROUTES.siteInfo, {})).data);
      await this.deps.state.updateSite(site.id, (current) => ({
        ...current,
        siteName: info.siteName || current.siteName,
        pluginVersion: info.pluginVersion || current.pluginVersion,
        protocol: Number.isSafeInteger(info.protocol) ? info.protocol : current.protocol,
        scope:
          info.connection.scope === 'read' || info.connection.scope === 'write'
            ? info.connection.scope
            : current.scope,
        connectionExpiresAt:
          typeof info.connection.expiresAt === 'number' ? info.connection.expiresAt : null,
        rescueUrl: sameOriginRescueUrl(info.guard.rescueUrl, current) ?? current.rescueUrl,
        ...movedEndpoints(current, info.layout === 'runova' ? info.endpoints : undefined),
      }));
      return { ...info, checkedAt: this.now() };
    });
  }

  async listItems(siteId: string): Promise<WpItem[]> {
    return this.withSite(siteId, async (client) => {
      const { items } = (await client.call(WP_ROUTES.itemsList, {})).data;
      return (Array.isArray(items) ? items : [])
        .slice(0, MAX_LISTED_ITEMS)
        .map(cleanItem)
        .filter((item): item is WpItem => item !== null);
    });
  }

  async history(siteId: string): Promise<WpDeployRecord[]> {
    return this.withSite(siteId, async (client) => {
      const { deploys } = (await client.call(WP_ROUTES.deployHistory, { limit: HISTORY_LIMIT }))
        .data;
      return (Array.isArray(deploys) ? deploys : [])
        .slice(0, HISTORY_LIMIT)
        .filter(isEntry)
        .map(cleanRecord);
    });
  }

  async audit(query: DeployWordPressAuditQuery): Promise<WpAuditEntry[]> {
    return this.withSite(query.siteId, async (client) => {
      const { entries } = (
        await client.call(WP_ROUTES.auditList, {
          limit: query.limit,
          ...(query.before === undefined ? {} : { before: query.before }),
        })
      ).data;
      return (Array.isArray(entries) ? entries : [])
        .slice(0, query.limit)
        .filter(isEntry)
        .map(cleanAudit);
    });
  }

  async rollback(input: DeployWordPressRollbackInput): Promise<DeployWordPressDeployResult> {
    return this.runOperation(
      input.operationId,
      input.siteId,
      null,
      'rollback',
      async (signal, report) => {
        const started = this.now();
        return this.withSite(input.siteId, async (client) => {
          report('rollback', 0, 1);
          let result: WpDeployStateResponse & Partial<WpDeployRollbackResponse>;
          try {
            result = (
              await client.call(
                WP_ROUTES.deployRollback,
                { deployId: input.deployId, ...(input.force ? { force: true } : {}) },
                { signal },
              )
            ).data;
          } catch (error) {
            if (!(error instanceof WpRemoteError) || error.code !== 'foreignResponse') {
              throw conflictMessage(error);
            }
            // The site itself is failing: the guard and rescue.php can still roll back.
            result = (
              await client.call(WP_ROUTES.rescueRollback, { deployId: input.deployId }, { signal })
            ).data;
          }
          report('done', 1, 1);
          return {
            deployId: input.deployId,
            state: result.state,
            ...(result.reason ? { reason: result.reason } : {}),
            health: [],
            uploaded: Number.isSafeInteger(result.restored) ? (result.restored as number) : 0,
            deleted: Number.isSafeInteger(result.removed) ? (result.removed as number) : 0,
            durationMs: this.now() - started,
          };
        });
      },
    );
  }

  async cancel(operationId: string): Promise<void> {
    this.operations
      .get(operationId)
      ?.controller.abort(wordPressError('cancelled', 'Stopped before it finished.'));
  }

  saveConnectorZip(): Promise<DeployWordPressSaveZipResult> {
    return this.deps.saveConnectorZip();
  }

  /**
   * Replaces the connector on a site with the one that ships with this app. Only a connector that
   * reports `selfUpdate` has the route (older ones are updated by hand once). The site swaps its
   * own plugin folder, health-checks itself, and puts the old files back when it fails the check.
   *
   * A site that can download the release itself (`updateDownload`) is asked to first, which saves
   * pushing the plugin through a slow link. When it can't (no route out, GitHub down, a release
   * that differs), the app sends the files the way older connectors take them.
   */
  async updateConnector(siteId: string): Promise<DeployWordPressUpdateConnectorResult> {
    const bundle = await this.deps.readConnectorBundle();
    const result = await this.holdSite(siteId, () =>
      this.withSite(siteId, (client, site) => this.updateByLayout(client, site, bundle)),
    );
    if (result.outcome === 'current') return result;
    // Asked again either way: the reply is signed by whichever code runs on the site now, and the
    // answer is what the app remembers as the site's version.
    const after = await this.siteInfo(siteId);
    if (
      result.outcome === 'updated' &&
      compareConnectorVersions(after.pluginVersion, result.version) < 0
    ) {
      throw wordPressError(
        'internal',
        `The site took the update but still reports version ${after.pluginVersion}. Its PHP cache may need a moment, or a restart. Check again in a minute.`,
      );
    }
    return result;
  }

  /**
   * A site that still runs from the 1.63 folder (a 1.63 connector, which reports no layout, or the
   * bridge) only takes the bridge package, since its folder and its plugin entry are the old ones.
   * Once it runs the bridge, the site moves itself to runova-connector/ and the app saves the
   * addresses it answers at from then on. A move that does not happen leaves the site working
   * in the old folder; the reply says why, and the next update tries again.
   */
  private async updateByLayout(
    client: WpClient,
    site: StoredWpSite,
    bundle: ConnectorBundle,
  ): Promise<DeployWordPressUpdateConnectorResult> {
    const info = cleanInfo((await client.call(WP_ROUTES.siteInfo, {})).data);
    if (info.layout === 'runova') return this.sendConnector(client, bundle, info);
    if (!this.deps.readBridgeBundle) {
      throw wordPressError(
        'connectorOutdated',
        `The connector on this site (version ${info.pluginVersion || 'unknown'}) is the one from before AgentMate became Runova, and this build of Runova cannot move it. Upload the plugin once in wp-admin (Plugins > Add New > Upload Plugin).`, // legacy-name
      );
    }
    const bridge = await this.deps.readBridgeBundle();
    // A 1.63 site takes the bridge even at the same version: what changes is the code in it.
    const sent = await this.sendConnector(client, bridge, info, info.layout === undefined);
    if (sent.outcome === 'rolledBack') return sent;
    const moved = await this.moveConnector(client, site);
    if (moved !== true) return { ...sent, moveProblem: moved };
    return { ...sent, outcome: 'updated', moved: true };
  }

  /** `/connector/migrate`, then the new addresses saved. True, or why the site did not move. */
  private async moveConnector(client: WpClient, site: StoredWpSite): Promise<true | string> {
    let reply: WpConnectorMigrateResponse;
    try {
      reply = (
        await client.call(
          WP_ROUTES.connectorMigrate,
          {},
          { timeoutMs: CONNECTOR_UPDATE_TIMEOUT_MS },
        )
      ).data;
    } catch (error) {
      // A reply that got lost may still follow a move that worked; the site's info tells later.
      return cleanSiteText(wordPressErrorMessage(error), 300) || 'The site did not answer.';
    }
    if (reply.state === 'rolledBack') {
      return 'The site failed its health check with the connector in its new folder, so it stays in the old one and works as before.';
    }
    if (reply.state !== 'migrated' && reply.state !== 'current') {
      return 'The site sent back a reply to the move that Runova could not read.';
    }
    await this.deps.state.updateSite(site.id, (current) => ({
      ...current,
      ...movedEndpoints(current, reply),
      rescueUrl: sameOriginRescueUrl(reply.rescueUrl, current) ?? current.rescueUrl,
      pluginVersion: cleanSiteText(reply.version, 40) || current.pluginVersion,
    }));
    return true;
  }

  private async sendConnector(
    client: WpClient,
    bundle: ConnectorBundle,
    info: WpSiteInfo,
    /** Send it even when the site reports the same version (a 1.63 site getting the bridge). */
    resend = false,
  ): Promise<DeployWordPressUpdateConnectorResult> {
    const fromVersion = info.pluginVersion;
    const order = compareConnectorVersions(fromVersion, bundle.version);
    if (order > 0 || (order === 0 && !resend)) {
      return { outcome: 'current', fromVersion, version: bundle.version, checks: [] };
    }
    if (info.selfUpdate === false) {
      // It has the route, but PHP can't swap its folder here, and a manual upload won't change that.
      throw wordPressError('updateRefused', UPDATE_REFUSED.notReplaceable);
    }
    if (info.selfUpdate !== true) {
      throw wordPressError(
        'connectorOutdated',
        `The connector on this site (version ${fromVersion || 'unknown'}) can't update itself. Upload the plugin once in wp-admin (Plugins > Add New > Upload Plugin); after that, updates can be done from here.`,
      );
    }
    const files = bundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));

    let downloadProblem: string | undefined;
    if (bundle.downloadUrl && info.updateDownload === true) {
      const request: WpConnectorUpdateRequest = {
        version: bundle.version,
        files,
        download: { url: bundle.downloadUrl },
      };
      try {
        const result = await this.requestUpdate(client, request, [], fromVersion);
        return { ...result, source: 'site' };
      } catch (error) {
        if (!(error instanceof WpRemoteError) || !downloadFallsBack(error)) {
          throw this.connectorUpdateError(error, 0, undefined);
        }
        downloadProblem = cleanSiteText(wordPressErrorMessage(error), 300);
      }
    }

    const request: WpConnectorUpdateRequest = { version: bundle.version, files };
    const blobs = bundle.files.map((file) => file.bytes);
    // What goes on the wire is the gzipped frame, so that is what the site's limit is held against.
    const wireBytes = gzipBytes(
      encodeWpFrame({ route: WP_ROUTES.connectorUpdate, body: request, blobs }),
    ).length;
    const limit = info.limits?.maxRequestBytes;
    if (
      typeof limit === 'number' &&
      Number.isFinite(limit) &&
      wireBytes > wpRequestCap(info.limits)
    ) {
      throw this.updateTooLarge(wireBytes, limit);
    }
    try {
      const result = await this.requestUpdate(client, request, blobs, fromVersion);
      return { ...result, source: 'app', ...(downloadProblem ? { downloadProblem } : {}) };
    } catch (error) {
      throw this.connectorUpdateError(error, wireBytes, limit);
    }
  }

  /**
   * One `/connector/update` call. A reply that never came back may still have followed a swap that
   * worked, so the site is asked for its version before that counts as a failure.
   */
  private async requestUpdate(
    client: WpClient,
    request: WpConnectorUpdateRequest,
    blobs: Uint8Array[],
    fromVersion: string,
  ): Promise<DeployWordPressUpdateConnectorResult> {
    let reply: WpConnectorUpdateResponse;
    try {
      reply = (
        await client.call(WP_ROUTES.connectorUpdate, request, {
          blobs,
          timeoutMs: CONNECTOR_UPDATE_TIMEOUT_MS,
        })
      ).data;
    } catch (error) {
      const code = error instanceof WpRemoteError ? error.code : null;
      if (code === 'timeout' || code === 'unreachable' || code === 'foreignResponse') {
        const now = await client
          .call(WP_ROUTES.siteInfo, {})
          .then((reading) => cleanInfo(reading.data))
          .catch(() => null);
        if (now && compareConnectorVersions(now.pluginVersion, request.version) >= 0) {
          return { outcome: 'updated', fromVersion, version: request.version, checks: [] };
        }
      }
      throw error;
    }
    const state: unknown = reply.state;
    if (state !== 'updated' && state !== 'rolledBack') {
      throw wordPressError(
        'internal',
        'The connector sent back a reply to the update that Runova could not read.',
      );
    }
    return {
      outcome: state,
      fromVersion,
      version: request.version,
      checks: (Array.isArray(reply.checks) ? reply.checks : [])
        .slice(0, 10)
        .filter(isEntry)
        .map((check: WpHealthCheck) => ({
          name: check.name,
          status: typeof check.status === 'number' ? check.status : null,
          ok: typeof check.ok === 'boolean' ? check.ok : null,
          detail: cleanSiteText(check.detail, 300),
        })),
    };
  }

  private updateTooLarge(wireBytes: number, limit: number): Error {
    const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));
    return wordPressError(
      'updateRefused',
      `This site takes requests of about ${kb(limit)} KB at most, and the connector update needs about ${kb(wireBytes)} KB. Download the plugin and upload it in wp-admin instead.`,
    );
  }

  /** The site's refusal in this app's words; anything else passes through. */
  private connectorUpdateError(error: unknown, wireBytes: number, limit: unknown): unknown {
    if (!(error instanceof WpRemoteError)) return error;
    if (error.code === 'updateRefused') {
      const reason = error.details.reason as WpUpdateRefusal;
      // The site's own sentence names the PHP or WordPress version it needs; keep it.
      if (reason === 'requirements') return error;
      const known = Object.hasOwn(UPDATE_REFUSED, reason) ? UPDATE_REFUSED[reason] : null;
      return known ? new WpRemoteError('updateRefused', known, error.details, error.status) : error;
    }
    if (error.code === 'syntaxError') {
      const where = [error.details.path, error.details.line]
        .filter((part) => typeof part === 'string' || typeof part === 'number')
        .map((part) => cleanSiteText(String(part), 200))
        .join(', line ');
      return new WpRemoteError(
        'updateRefused',
        `This site's PHP can't run the new connector${where ? ` (a syntax error in ${where})` : ''}, so nothing was changed. The site's PHP version may be too old.`,
        error.details,
        error.status,
      );
    }
    if (error.code === 'tooLarge') {
      return typeof limit === 'number' && Number.isFinite(limit)
        ? this.updateTooLarge(wireBytes, limit)
        : new WpRemoteError(
            'updateRefused',
            'The site or its web server refused a request this large. Download the plugin and upload it in wp-admin instead.',
            error.details,
            error.status,
          );
    }
    return error;
  }

  // Shared plumbing.

  protected siteUnknown(): Error {
    return wordPressError(
      'siteUnknown',
      'That WordPress site is no longer connected on this computer. Connect it again.',
    );
  }

  protected async requireSite(siteId: string): Promise<StoredWpSite> {
    const site = await this.deps.state.site(siteId);
    if (!site) throw this.siteUnknown();
    return site;
  }

  protected async seal(plaintext: string): Promise<SecretEnvelope> {
    try {
      return await this.deps.seal(plaintext);
    } catch (error) {
      if (error instanceof VaultLockedError) throw wordPressError('vaultLocked', VAULT_LOCKED);
      throw error;
    }
  }

  private async unseal(envelope: SecretEnvelope): Promise<string> {
    if (this.deps.isLocked(envelope)) throw wordPressError('vaultLocked', VAULT_LOCKED);
    try {
      return await this.deps.unseal(envelope);
    } catch (error) {
      if (error instanceof VaultLockedError) throw wordPressError('vaultLocked', VAULT_LOCKED);
      throw wordPressError(
        'internal',
        'The saved key for this site could not be opened. Disconnect the site and connect it again.',
      );
    }
  }

  /** A client for the site, with its secrets unsealed for as long as the client lives. */
  protected async clientFor(site: StoredWpSite): Promise<WpClient> {
    checkPlainHttp(wpKeyTransportSecurity(site), site.allowPlainHttp);
    const privateKey = privateKeyFromPem(await this.unseal(site.privateKey));
    const httpAuth = site.httpAuth
      ? { username: site.httpAuth.username, password: await this.unseal(site.httpAuth.password) }
      : null;
    return new WpClient({
      transport: this.deps.transport,
      endpoints: { restUrl: site.restUrl, ajaxUrl: site.ajaxUrl, rescueUrl: site.rescueUrl },
      sitePublicKey: site.sitePublicKey,
      connectionId: site.connectionId,
      privateKey,
      httpAuth,
      endpoint: site.endpoint,
      clockOffset: site.clockOffset,
      now: this.now,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
  }

  /** Runs work against the site, then keeps what the client learned (endpoint, clock). */
  protected async withSite<T>(
    siteId: string,
    work: (client: WpClient, site: StoredWpSite) => Promise<T>,
  ): Promise<T> {
    const site = await this.requireSite(siteId);
    const client = await this.clientFor(site);
    await this.reconcile(site, client);
    let succeeded = false;
    try {
      const result = await work(client, site);
      succeeded = true;
      return result;
    } finally {
      if (
        succeeded ||
        client.endpoint !== site.endpoint ||
        client.clockOffset !== site.clockOffset
      ) {
        await this.deps.state
          .updateSite(site.id, (current) => ({
            ...current,
            endpoint: client.endpoint ?? current.endpoint,
            clockOffset: client.clockOffset,
            lastSeenAt: succeeded ? this.now() : current.lastSeenAt,
          }))
          .catch(() => undefined);
      }
    }
  }

  /**
   * Finds out how a deploy this computer started, and did not see finish, ended: one that reached
   * `done` makes its pending base the project's base; one still open is aborted, one applied is
   * rolled back; anything else is just forgotten. Best effort: a failure leaves it for next time.
   */
  protected async reconcile(site: StoredWpSite, client: WpClient): Promise<void> {
    const inflight = await this.deps.state.inflight(site.id);
    if (!inflight || this.siteBusy(site.id)) return;
    try {
      const { deploys } = (await client.call(WP_ROUTES.deployHistory, { limit: HISTORY_LIMIT }))
        .data;
      const record = (Array.isArray(deploys) ? deploys : []).find(
        (deploy) => deploy.deployId === inflight.deployId,
      );
      if (record?.state === 'done' && inflight.projectId) {
        await this.deps.bases.promotePending(inflight.projectId);
      } else {
        if (record?.state === 'open') {
          await client.call(WP_ROUTES.deployAbort, { deployId: inflight.deployId });
        } else if (record?.state === 'applying' || record?.state === 'applied') {
          await client.call(WP_ROUTES.deployRollback, { deployId: inflight.deployId });
        }
        if (inflight.projectId) await this.deps.bases.dropPending(inflight.projectId);
      }
      await this.deps.state.clearInflight(site.id, inflight.deployId);
    } catch {
      // Left for the next contact.
    }
  }

  private async revoke(site: StoredWpSite): Promise<void> {
    const client = await this.clientFor(site);
    await client.call(WP_ROUTES.connectionRevoke, {});
  }

  protected siteBusy(siteId: string): boolean {
    return [...this.operations.values()].some((operation) => operation.siteId === siteId);
  }

  /**
   * Keeps pulls, deploys and other holds off a site while `work` runs, without a progress stream
   * of its own (nothing in the work takes long enough to show steps).
   */
  private async holdSite<T>(siteId: string, work: () => Promise<T>): Promise<T> {
    if (this.siteBusy(siteId)) {
      throw wordPressError(
        'operationBusy',
        'A pull, deploy or update for this site is still running. Wait for it to finish.',
      );
    }
    const id = `connector-update-${randomUUID()}`;
    this.operations.set(id, { siteId, controller: new AbortController() });
    try {
      return await work();
    } finally {
      this.operations.delete(id);
    }
  }

  /**
   * One operation per site, cancellable by its id, reporting its steps as progress events and
   * ending with `done` or `failed`.
   */
  protected async runOperation<T>(
    operationId: string,
    siteId: string,
    projectId: string | null,
    kind: DeployWordPressOperationKind,
    work: (signal: AbortSignal, report: WpReport) => Promise<T>,
  ): Promise<T> {
    if (this.operations.has(operationId)) {
      throw wordPressError('operationBusy', 'That operation is already running.');
    }
    if (this.siteBusy(siteId)) {
      throw wordPressError(
        'operationBusy',
        'Another pull or deploy for this site is still running. Wait for it to finish.',
      );
    }
    const controller = new AbortController();
    this.operations.set(operationId, { siteId, controller });
    const report: WpReport = (phase, done, total, bytes) =>
      this.deps.progress({
        operationId,
        siteId,
        projectId,
        kind,
        phase,
        done,
        total,
        ...(bytes === undefined ? {} : { bytes }),
      });
    try {
      report('connecting', 0, 0);
      return await work(controller.signal, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.progress({
        operationId,
        siteId,
        projectId,
        kind,
        phase: 'failed',
        done: 0,
        total: 0,
        error: message,
      });
      throw error;
    } finally {
      this.operations.delete(operationId);
    }
  }
}

/**
 * The REST and admin-ajax addresses a site reports after it moved to its own folder, for a site
 * saved with its 1.63 ones. Only on the same origins, so a reply can never point the app at
 * another host. Nothing for a site already saved with the new ones.
 */
export function movedEndpoints(
  site: Pick<StoredWpSite, 'restUrl' | 'ajaxUrl'>,
  reported: { restUrl?: unknown; ajaxUrl?: unknown } | undefined,
): Partial<Pick<StoredWpSite, 'restUrl' | 'ajaxUrl'>> {
  if (!reported || !isWpLegacyRestUrl(site.restUrl)) return {};
  const { restUrl, ajaxUrl } = reported;
  if (typeof restUrl !== 'string' || typeof ajaxUrl !== 'string') return {};
  if (restUrl.length > 2048 || ajaxUrl.length > 2048 || isWpLegacyRestUrl(restUrl)) return {};
  const origin = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
    } catch {
      return null;
    }
  };
  if (origin(restUrl) === null || origin(restUrl) !== origin(site.restUrl)) return {};
  if (origin(ajaxUrl) === null || origin(ajaxUrl) !== origin(site.ajaxUrl)) return {};
  return { restUrl, ajaxUrl };
}

/** Whether a failed download left the site as it was, so sending the files is worth a try. */
function downloadFallsBack(error: WpRemoteError): boolean {
  if (error.code === 'updateRefused') return error.details.reason === 'downloadFailed';
  return DOWNLOAD_FALLBACK_CODES.has(error.code);
}

/**
 * A `[wp:conflict]` from the site, rewritten as a summary line and then one `<path>: <what>` line
 * per file, which is the shape the renderer reads. Other errors pass through.
 */
export function conflictMessage(error: unknown): unknown {
  if (!(error instanceof WpRemoteError) || error.code !== 'conflict') return error;
  const conflicts = Array.isArray(error.details.conflicts) ? error.details.conflicts : [];
  const lines = conflicts
    .filter(
      (conflict): conflict is { item: WpItemRef; path: string } =>
        typeof conflict === 'object' &&
        conflict !== null &&
        typeof conflict.path === 'string' &&
        typeof conflict.item?.slug === 'string' &&
        KINDS.has(conflict.item?.kind),
    )
    .slice(0, 200)
    .map(
      (conflict) =>
        `${cleanSiteText(wpMessagePath(conflict.item, conflict.path), 500)}: changed on the site since this deploy`,
    );
  if (lines.length === 0) return error;
  const summary =
    lines.length === 1
      ? '1 file changed on the site since this deploy.'
      : `${lines.length} files changed on the site since this deploy.`;
  return new WpRemoteError('conflict', [summary, ...lines].join('\n'), error.details, error.status);
}
