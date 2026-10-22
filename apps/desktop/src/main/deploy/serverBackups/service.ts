import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { coreErrorCode } from '../../../shared/coreErrors';
import type {
  BackupDestinationInfo,
  BackupDestinationTest,
  BackupFetchInfo,
  BackupPlanInfo,
  BackupPlanPreview,
  BackupPlanPreviewRequest,
  BackupRunInfo,
  BackupSecretStatus,
  PendingServerRestore,
  SaveBackupPlanRequest,
  ServerRestoreStatus,
  StoredBackupInfo,
  TelegramLoginState,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import type { DeployBackupFile } from '../../../shared/deployHardeningTypes';
import type {
  DeployBackupDestinationInput,
  DeployBackupDownload,
  DeployBackupItemInput,
  DeployBackupNowInput,
  DeployBackupNowResult,
  DeployBackupProof,
  DeployBackupRunEvent,
  DeployBackupRunInput,
  DeployBackupSecretInput,
  DeployBackupWatchResult,
  DeployCloudDriveInput,
  DeployStoredBackupInput,
  DeployTelegramContinueInput,
  DeployTelegramStartInput,
} from '../../../shared/deployServerBackupsTypes';
import type { CoreHttpClient } from '../connection/coreHttp';
import { type CoreCallDeps, callCore } from '../coreCalls';
import { type LoopbackSignInRequest, signInWithLoopback } from './oauth';

/**
 * A server's Backups section (E28), on this side. The core owns backups: it makes, encrypts with
 * the secret key, uploads to each destination, prunes and lists them, on a schedule that runs with
 * the app closed. This wraps its hub calls (all Owner only, the changes behind a step-up, which
 * callCore turns into `[core:stepUpRequired]`), follows runs and fetches until they end, streams a
 * backup down to where the user picked (asked first, so a cancelled dialog makes nothing), and
 * signs in to Google Drive or OneDrive for a destination. Credentials go straight to the core,
 * which seals them and never reads them back; a refresh token never leaves the main process except
 * to the core.
 */

const OWNER: ReadonlySet<string> = new Set(['owner']);
const MISSING_METHOD = /Method does not exist/i;
const POLL_MS = 1_500;
/** A stall this long ends a download; a slow link can take as long as it needs otherwise. */
const STALL_MS = 2 * 60_000;
/** A cloud sign-in kept for the retry after a step-up. */
const SIGN_IN_KEPT_MS = 10 * 60_000;
const MIN_SECRET = 12;
const MAX_SECRET = 1024;
/** Where the core keeps a fetched backup for `admin restore-stage`, root only. */
export const FETCH_FOLDER = '/var/lib/agentmate-core/backups/';

export interface ServerBackupsDeps extends CoreCallDeps {
  /** A REST call with this computer's session (DeployService.withCoreHttp). */
  withCoreHttp: <T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
  /** The save dialog; null when it was cancelled. */
  pickSavePath: (suggestedName: string) => Promise<string | null>;
  /** The open dialog; null when it was cancelled. */
  pickOpenPath: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  /** A run as it stands, for the window that follows it. */
  runProgress?: (event: DeployBackupRunEvent) => void;
  /** The browser sign-in; the loopback one unless a test swaps it. */
  signIn?: (
    request: LoopbackSignInRequest,
    signal: AbortSignal,
  ) => Promise<{ refreshToken: string }>;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
  now?: () => number;
}

export function secretProblem(secret: string): string | null {
  if (secret.length < MIN_SECRET) return `A secret key needs at least ${MIN_SECRET} characters.`;
  if (secret.length > MAX_SECRET) return `A secret key can be at most ${MAX_SECRET} characters.`;
  if (/[\r\n]/.test(secret)) return 'A secret key cannot contain a line break.';
  return null;
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function stepUp(hub: ICoreHub, proof: DeployBackupProof): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

export class ServerBackups {
  private readonly picked = new Map<string, string>();
  /** Where a run started with `download` is saved, by run. */
  private readonly saveTo = new Map<string, string>();
  private readonly watching = new Map<string, AbortController>();
  private readonly signIns = new Map<string, AbortController>();
  private readonly signedIn = new Map<string, { refreshToken: string; until: number }>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly pollMs: number;

  constructor(private readonly deps: ServerBackupsDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortable;
    this.pollMs = deps.pollMs ?? POLL_MS;
  }

  // The secret key.

  secret(serverId: string): Promise<BackupSecretStatus> {
    return this.call(serverId, (hub) => hub.getBackupSecret());
  }

  async setSecret(input: DeployBackupSecretInput): Promise<BackupSecretStatus> {
    const problem = secretProblem(input.newSecret);
    if (problem) throw new Error(problem);
    return this.call(
      input.serverId,
      (hub) =>
        hub.setBackupSecret({
          newSecret: input.newSecret,
          ...(input.currentSecret ? { currentSecret: input.currentSecret } : {}),
        }),
      true,
    );
  }

  // Destinations.

  destinations(serverId: string): Promise<BackupDestinationInfo[]> {
    return this.call(serverId, (hub) => hub.listBackupDestinations());
  }

  saveDestination(input: DeployBackupDestinationInput): Promise<BackupDestinationInfo> {
    return this.call(input.serverId, (hub) => hub.saveBackupDestination(input.destination), true);
  }

  deleteDestination(input: DeployBackupItemInput): Promise<boolean> {
    return this.call(input.serverId, (hub) => hub.deleteBackupDestination(input.id), true);
  }

  testDestination(input: DeployBackupDestinationInput): Promise<BackupDestinationTest> {
    return this.call(input.serverId, (hub) => hub.testBackupDestination(input.destination));
  }

  /**
   * Signs in to Google Drive or OneDrive in the browser, then saves the destination with the
   * refresh token. When the core wants a step-up first, the token waits here a few minutes so the
   * retry does not send the user through the browser again.
   */
  async connectCloudDrive(input: DeployCloudDriveInput): Promise<BackupDestinationInfo> {
    const key = [input.serverId, input.kind, input.clientId, input.destinationId ?? ''].join('|');
    let kept = this.signedIn.get(key);
    if (kept && kept.until < this.now()) {
      this.signedIn.delete(key);
      kept = undefined;
    }
    if (!kept) {
      this.signIns.get(input.serverId)?.abort();
      const controller = new AbortController();
      this.signIns.set(input.serverId, controller);
      try {
        const request: LoopbackSignInRequest = {
          kind: input.kind,
          clientId: input.clientId,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        };
        const signIn =
          this.deps.signIn ??
          ((asked, signal) =>
            signInWithLoopback(
              {
                openExternal: this.deps.openExternal,
                fetch: this.deps.fetch ?? fetch,
                signal,
              },
              asked,
            ));
        const { refreshToken } = await signIn(request, controller.signal);
        kept = { refreshToken, until: this.now() + SIGN_IN_KEPT_MS };
        this.signedIn.set(key, kept);
      } finally {
        if (this.signIns.get(input.serverId) === controller) this.signIns.delete(input.serverId);
      }
    }
    const token = kept.refreshToken;
    try {
      const saved = await this.saveDestination({
        serverId: input.serverId,
        destination: {
          ...(input.destinationId ? { id: input.destinationId } : {}),
          name: input.name,
          kind: input.kind,
          settings: { clientId: input.clientId, folderName: input.folderName },
          secret: {
            refreshToken: token,
            ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          },
          ...(input.maxPartBytes ? { maxPartBytes: input.maxPartBytes } : {}),
        },
      });
      this.signedIn.delete(key);
      return saved;
    } catch (error) {
      if (coreErrorCode(error) !== 'stepUpRequired') this.signedIn.delete(key);
      throw error;
    }
  }

  /** Stops a browser sign-in that is waiting. */
  cancelCloudSignIn(serverId: string): boolean {
    const controller = this.signIns.get(serverId);
    controller?.abort();
    return controller !== undefined;
  }

  startTelegramLogin(input: DeployTelegramStartInput): Promise<TelegramLoginState> {
    return this.call(
      input.serverId,
      (hub) =>
        hub.startTelegramLogin({
          apiId: input.apiId,
          apiHash: input.apiHash,
          phoneNumber: input.phoneNumber,
        }),
      true,
    );
  }

  continueTelegramLogin(input: DeployTelegramContinueInput): Promise<TelegramLoginState> {
    return this.call(
      input.serverId,
      (hub) =>
        hub.continueTelegramLogin({
          loginId: input.loginId,
          ...(input.code ? { code: input.code } : {}),
          ...(input.password ? { password: input.password } : {}),
        }),
      true,
    );
  }

  // Plans.

  plans(serverId: string): Promise<BackupPlanInfo[]> {
    return this.call(serverId, (hub) => hub.listBackupPlans());
  }

  savePlan(serverId: string, plan: SaveBackupPlanRequest): Promise<BackupPlanInfo> {
    return this.call(serverId, (hub) => hub.saveBackupPlan(plan));
  }

  deletePlan(input: DeployBackupItemInput): Promise<boolean> {
    return this.call(input.serverId, (hub) => hub.deleteBackupPlan(input.id));
  }

  previewPlan(serverId: string, request: BackupPlanPreviewRequest): Promise<BackupPlanPreview> {
    return this.call(serverId, (hub) => hub.previewBackupPlan(request));
  }

  runPlan(input: DeployBackupItemInput): Promise<BackupRunInfo> {
    return this.call(input.serverId, (hub) => hub.runBackupPlan(input.id));
  }

  // Runs.

  /**
   * Backs up now. For a copy on this computer the save dialog comes first, and nothing is made
   * when it is cancelled; the run is then saved there once it ends (watchRun).
   */
  async runNow(input: DeployBackupNowInput): Promise<DeployBackupNowResult> {
    let path: string | null = null;
    if (input.download) {
      path = await this.deps.pickSavePath(await this.suggestedName(input.serverId));
      if (!path) return { started: false };
    } else if (input.destinationIds.length === 0) {
      throw new Error('Pick at least one destination, or download the backup to this computer.');
    }
    const run = await this.call(
      input.serverId,
      (hub) =>
        hub.runBackupNow({ destinationIds: input.destinationIds, keepForDownload: input.download }),
      true,
    );
    if (path) this.saveTo.set(run.id, path);
    return { started: true, run };
  }

  runs(serverId: string, limit: number): Promise<BackupRunInfo[]> {
    return this.call(serverId, (hub) => hub.listBackupRuns(limit));
  }

  async run(input: DeployBackupRunInput): Promise<BackupRunInfo | null> {
    return (await this.call(input.serverId, (hub) => hub.getBackupRun(input.runId))) ?? null;
  }

  /** Follows a run until it ends, then saves it here when it was started with `download`. */
  async watchRun(input: DeployBackupRunInput): Promise<DeployBackupWatchResult> {
    const key = `${input.serverId}|${input.runId}`;
    this.watching.get(key)?.abort();
    const controller = new AbortController();
    this.watching.set(key, controller);
    try {
      const run = await this.waitForRun(input.serverId, input.runId, controller.signal);
      const path = this.saveTo.get(input.runId);
      if (!path) return { run };
      this.saveTo.delete(input.runId);
      if (run.state === 'failed') {
        return {
          run,
          download: { saved: false, error: run.error ?? 'The backup was not made.' },
        };
      }
      try {
        const sizeBytes = await this.stream(input.serverId, input.runId, path, (bytes) =>
          this.deps.runProgress?.({ serverId: input.serverId, run, downloadedBytes: bytes }),
        );
        return { run, download: { saved: true, path, sizeBytes } };
      } catch (error) {
        return {
          run,
          download: { saved: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    } finally {
      if (this.watching.get(key) === controller) this.watching.delete(key);
    }
  }

  stopWatching(input: DeployBackupRunInput): boolean {
    const controller = this.watching.get(`${input.serverId}|${input.runId}`);
    controller?.abort();
    return controller !== undefined;
  }

  /** Polls a run every second or two until it is no longer running. */
  async waitForRun(serverId: string, runId: string, signal?: AbortSignal): Promise<BackupRunInfo> {
    for (;;) {
      if (signal?.aborted)
        throw new Error('Following the backup stopped. It carries on on the server.');
      const run = await this.call(serverId, (hub) => hub.getBackupRun(runId));
      if (!run) throw new Error('The server has no such backup run.');
      this.deps.runProgress?.({ serverId, run });
      if (run.state !== 'running') return run;
      try {
        await this.sleep(this.pollMs, signal);
      } catch {
        throw new Error('Following the backup stopped. It carries on on the server.');
      }
    }
  }

  /** Saves a backup the core keeps for download (a run made with `download`) where the user picks. */
  async downloadRun(input: DeployBackupRunInput): Promise<DeployBackupDownload> {
    const path = await this.deps.pickSavePath(await this.suggestedName(input.serverId));
    if (!path) return { saved: false };
    const sizeBytes = await this.stream(input.serverId, input.runId, path);
    return { saved: true, path, sizeBytes };
  }

  // Stored backups.

  storedBackups(input: DeployBackupItemInput): Promise<StoredBackupInfo[]> {
    return this.call(input.serverId, (hub) => hub.listStoredBackups(input.id));
  }

  deleteStored(input: DeployStoredBackupInput): Promise<boolean> {
    return this.call(
      input.serverId,
      (hub) => hub.deleteStoredBackup(input.destinationId, input.backupId),
      true,
    );
  }

  /** Asks where to save, has the core fetch the backup from its destination, then streams it here. */
  async downloadStored(input: DeployStoredBackupInput): Promise<DeployBackupDownload> {
    const path = await this.deps.pickSavePath(await this.suggestedName(input.serverId));
    if (!path) return { saved: false };
    const fetched = await this.fetchToServer(input.serverId, input.destinationId, input.backupId);
    const sizeBytes = await this.stream(input.serverId, fetched.backupId, path);
    return { saved: true, path, sizeBytes };
  }

  /**
   * Has the core fetch a stored backup onto the server (joined and checked, root only, where
   * `admin restore-stage` reads it) and waits for it.
   */
  async fetchToServer(
    serverId: string,
    destinationId: string,
    backupId: string,
    onProgress?: (fetch: BackupFetchInfo) => void,
    signal?: AbortSignal,
  ): Promise<BackupFetchInfo> {
    let fetch = await this.call(
      serverId,
      (hub) => hub.fetchStoredBackup(destinationId, backupId),
      true,
    );
    for (;;) {
      onProgress?.(fetch);
      if (fetch.state === 'failed' || fetch.state === 'partlyFailed') {
        throw new Error(
          fetch.error ?? 'The server could not fetch the backup from its destination.',
        );
      }
      if (fetch.state === 'succeeded') return fetch;
      await this.sleep(this.pollMs, signal);
      const id = fetch.id;
      const next = await this.call(serverId, (hub) => hub.getBackupFetch(id));
      if (!next) throw new Error('The server lost track of the fetch. Try again.');
      fetch = next;
    }
  }

  // Restores (the steps that run on the core; the swap itself goes over SSH, see restore.ts).

  async pendingRestore(serverId: string): Promise<PendingServerRestore | null> {
    return (await this.call(serverId, (hub) => hub.getPendingServerRestore())) ?? null;
  }

  runServerRestore(
    serverId: string,
    moveAddresses: boolean,
    proof: DeployBackupProof = {},
  ): Promise<ServerRestoreStatus> {
    return this.call(
      serverId,
      async (hub) => {
        await stepUp(hub, proof);
        return hub.runServerRestore({ moveAddresses });
      },
      true,
    );
  }

  async serverRestoreStatus(serverId: string): Promise<ServerRestoreStatus | null> {
    return (await this.call(serverId, (hub) => hub.getServerRestoreStatus())) ?? null;
  }

  /** Polls how bringing the server up goes until it is done. */
  async waitForServerRestore(
    serverId: string,
    first: ServerRestoreStatus,
    onStatus: (status: ServerRestoreStatus) => void,
    signal?: AbortSignal,
  ): Promise<ServerRestoreStatus> {
    let status = first;
    for (;;) {
      onStatus(status);
      if (status.state !== 'running') return status;
      await this.sleep(this.pollMs, signal);
      const next = await this.serverRestoreStatus(serverId);
      if (!next) throw new Error('The server lost track of the restore.');
      status = next;
    }
  }

  // Files on this computer.

  /** Lets the user pick a backup file; the renderer gets a token for it, not its path. */
  async pick(): Promise<DeployBackupFile | null> {
    const path = await this.deps.pickOpenPath();
    if (!path) return null;
    const info = await stat(path);
    if (!info.isFile()) throw new Error('That is not a file.');
    const token = randomUUID();
    this.picked.set(token, path);
    return { token, name: basename(path), sizeBytes: info.size };
  }

  resolve(token: string): string {
    const path = this.picked.get(token);
    if (!path) throw new Error('Pick the backup file again.');
    return path;
  }

  /** Streams GET /api/v1/backups/{id} to `<path>.partial`, then renames it into place. */
  async stream(
    serverId: string,
    backupId: string,
    path: string,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    const partial = `${path}.partial`;
    try {
      const bytes = await this.deps.withCoreHttp(serverId, (client, token) =>
        client.download(
          `/api/v1/backups/${encodeURIComponent(backupId)}`,
          createWriteStream(partial, { mode: 0o600 }),
          {
            token,
            stallTimeoutMs: STALL_MS,
            ...(onBytes ? { onProgress: onBytes } : {}),
            ...(signal ? { signal } : {}),
          },
        ),
      );
      await rename(partial, path);
      return bytes;
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  private async suggestedName(serverId: string): Promise<string> {
    const date = new Date(this.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return `agentmate-${fileSafe(await this.deps.serverName(serverId))}-${date}.ambackup`;
  }

  private async call<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    needsStepUp = false,
  ): Promise<T> {
    try {
      return await callCore(this.deps, serverId, work, needsStepUp ? { stepUpFor: OWNER } : {});
    } catch (error) {
      if (error instanceof Error && MISSING_METHOD.test(error.message)) {
        throw new Error(
          'This server runs an older core without server backups. Update the core from the Overview, then try again.',
        );
      }
      throw error;
    }
  }
}
