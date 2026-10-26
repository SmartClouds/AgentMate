import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type {
  CoreUpdateRequest,
  CoreUpdateResult,
  LayoutMigrationResult,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployCoreLayout,
  DeployCoreRecord,
  DeployCoreUpdateResult,
  DeployHealth,
  DeploySetupPhase,
  DeploySetupProgress,
  DeployStepUpInput,
} from '../../shared/deployTypes';
import { releaseDirectory } from './bootstrap/installPlan';
import { releaseRidFor } from './bootstrap/osSupport';
import type { ReleaseSource } from './bootstrap/releaseSource';
import { type CoreHttpClient, CoreHttpError } from './connection/coreHttp';
import { isOlderCore, LEGACY_CORE, layoutOf, RUNOVA_CORE } from './coreLayout';
import { explainCoreRefusal } from './system';

/**
 * Updating a server's core through the core itself, so no SSH login or sudo password is needed:
 *
 * 1. The core is asked to download the release from GitHub itself, checked against the size and
 *    SHA-256 in this app's manifest. A development build has no public release, so it skips this.
 * 2. When the server cannot fetch it, this app gets the release (already checked) and uploads it
 *    over the core's own connection (REST, `PUT /api/v1/core/update`), which the core checks again.
 * 3. The core switches to the release a few seconds later from a transient unit and restarts. That
 *    unit goes back to the release before when the new one does not stay up, so this side waits
 *    for the core to answer again and says which release it came back on.
 *
 * 4. A server still on the layout from before the rename is then moved to the Runova one by the
 *    new core (`MigrateLayout`), and this side waits for it to come back under its new name. A
 *    move that fails is put back by the core and reported, but the update still counts.
 *
 * A core from before the rename (1.63 or older) only takes the tarball under its old name, and
 * reads the upload's headers under their old names, so those go to it.
 *
 * A core that cannot do this (older than this feature, or not installed by the app) ends in
 * `needs-ssh`, and the Deploy page offers the SSH installer instead. Updating takes an Owner with a
 * step-up, which the renderer asks for when the error says `stepUpRequired`.
 */

export const CORE_UPDATE_PATH = '/api/v1/core/update';

/** What a core without this feature answers to an unknown hub method. */
const MISSING_METHOD = /Method does not exist/i;
/** How long the restart may take before the update is reported as not finished. */
const COMEBACK_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;
/** The switch keeps the new core only if it is still up five seconds after it started. */
const SETTLE_MS = 8_000;
/** A migration stops the core, moves its folders and watches the new one for ten seconds. */
const MIGRATION_TIMEOUT_MS = 300_000;
const UPLOAD_STALL_MS = 60_000;
const OLDER_CORE = 'This server runs an older core that cannot update itself.';
const OWNERS_ONLY = 'Only an Owner of this server can update its core.';

const TITLES = {
  fetch: 'Download the server core on the server',
  download: 'Get the server core',
  upload: 'Upload it over the core connection',
  switch: 'Switch to the new release',
  health: 'Check that it answers',
  migrate: 'Move the core to its new name',
} as const satisfies Partial<Record<DeploySetupPhase, string>>;

type Phase = keyof typeof TITLES;
type Step = Omit<DeploySetupProgress, 'phase' | 'title'>;

export interface CoreUpdateDeps {
  releases: ReleaseSource;
  record: (serverId: string) => Promise<DeployCoreRecord | null>;
  saveRecord: (serverId: string, record: DeployCoreRecord) => Promise<void>;
  withHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
  withCoreHttp: <T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ) => Promise<T>;
  health: (serverId: string) => Promise<DeployHealth>;
  roles: (serverId: string) => string[] | null;
  /** The core restarted under the lasting connection; it starts over on the new one. */
  resetLink: (serverId: string) => void;
  progress: (progress: DeploySetupProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class NeedsSsh extends Error {}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function updateCoreLive(
  deps: CoreUpdateDeps,
  input: DeployStepUpInput,
): Promise<DeployCoreUpdateResult> {
  try {
    return await run(deps, input);
  } catch (error) {
    if (error instanceof NeedsSsh) return { outcome: 'needs-ssh', reason: error.message };
    throw error;
  }
}

/** Reports a step under its title. */
function report(deps: CoreUpdateDeps, phase: Phase, step: Step): void {
  deps.progress({ phase, title: TITLES[phase], ...step });
}

async function run(
  deps: CoreUpdateDeps,
  input: DeployStepUpInput,
): Promise<DeployCoreUpdateResult> {
  const { serverId } = input;
  const sleep = deps.sleep ?? sleepFor;
  const now = deps.now ?? Date.now;
  const record = await deps.record(serverId);
  if (!record) throw new Error('The server core is not installed on this server yet.');
  const rid = releaseRidFor(record.architecture);
  if (!rid) throw new NeedsSsh(`There is no server core build for ${record.architecture}.`);
  const before = await deps.health(serverId);
  // Only a core from before the rename needs the old tarball name and header names.
  const oldCore = layoutOf(record) === 'legacy' && isOlderCore(before.version);
  const remote = deps.releases.remote?.(rid) ?? null;
  const proof =
    input.password || input.totpCode
      ? {
          ...(input.password ? { password: input.password } : {}),
          ...(input.totpCode ? { totpCode: input.totpCode } : {}),
        }
      : null;

  let target: { version: string; sha256: string } | null = null;
  let via: 'server-download' | 'upload' = 'upload';
  if (remote) {
    const legacy = oldCore ? remote.legacy : undefined;
    const request: CoreUpdateRequest = {
      version: remote.version,
      file: legacy?.file ?? remote.file,
      sha256: remote.sha256,
      size: remote.size,
      downloadUrl: legacy?.url ?? remote.url,
    };
    report(deps, 'fetch', { status: 'running' });
    const answer = await callHub(deps, serverId, proof, (hub) => hub.updateCore(request));
    if (answer.outcome === 'unsupported') {
      throw new NeedsSsh(answer.problem ?? 'This core cannot replace itself.');
    }
    if (answer.outcome === 'switching') {
      report(deps, 'fetch', { status: 'done' });
      target = { version: remote.version, sha256: remote.sha256 };
      via = 'server-download';
    } else {
      report(deps, 'fetch', {
        status: 'failed',
        detail: `${answer.problem ?? 'The server could not download it.'} Runova sends it instead.`,
      });
    }
  } else if (proof) {
    // The upload is REST, which cannot step up on its own; the hub does it first.
    await callHub(deps, serverId, proof, async () => undefined);
  }

  if (!target) {
    target = await upload(deps, serverId, rid, oldCore);
  }

  report(deps, 'switch', {
    status: 'running',
    detail: 'The core restarts on the new release in a few seconds.',
  });
  const back = await waitForRestart(deps, serverId, before, target.version, sleep, now);
  if (back.version !== target.version) {
    report(deps, 'switch', { status: 'failed' });
    throw new Error(
      `Server core ${target.version} did not stay up, so the server went back to ${back.version}. The Logs section has what it wrote.`,
    );
  }
  report(deps, 'switch', { status: 'done' });
  report(deps, 'health', { status: 'done' });
  let layout: DeployCoreLayout = back.layout ?? 'legacy';
  const save = (to: DeployCoreLayout) =>
    deps.saveRecord(serverId, {
      ...record,
      version: target.version,
      release: releaseDirectory(target.version, target.sha256, to),
      layout: to,
      installedAt: now(),
    });
  await save(layout);
  deps.resetLink(serverId);

  let migrationError: string | undefined;
  if (layout === 'legacy' && !isOlderCore(target.version)) {
    const moved = await migrateLive(deps, serverId, proof, back, sleep, now);
    if (moved.layout === 'runova') {
      layout = 'runova';
      await save(layout);
    }
    migrationError = moved.error;
  }
  return {
    outcome: 'updated',
    version: target.version,
    previousVersion: before.version,
    via,
    layout,
    ...(migrationError ? { migrationError } : {}),
  };
}

/**
 * Asks the core to move the server to the Runova layout, then waits for it to come back from a
 * new start: under its new name when it worked, on the old layout with the reason when the core
 * put everything back. Never throws for a migration that did not happen: the update stands.
 */
async function migrateLive(
  deps: CoreUpdateDeps,
  serverId: string,
  proof: { password?: string; totpCode?: string } | null,
  before: DeployHealth,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<{ layout: DeployCoreLayout; error?: string }> {
  report(deps, 'migrate', { status: 'running', detail: 'The core restarts under its new name.' });
  const fail = (error: string) => {
    report(deps, 'migrate', {
      status: 'failed',
      detail: `The server stays on its old layout: ${error}`,
    });
    return { layout: 'legacy' as const, error };
  };
  let answer: LayoutMigrationResult;
  try {
    // The step-up from the update is still good; a fresh one only when the core asks for it.
    answer = await callHub(deps, serverId, null, (hub) => hub.migrateLayout()).catch(
      (error: unknown) => {
        if (proof?.password && coreErrorCode(error) === 'stepUpRequired') {
          return callHub(deps, serverId, proof, (hub) => hub.migrateLayout());
        }
        throw error;
      },
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (answer.outcome === 'alreadyMigrated') {
    report(deps, 'migrate', { status: 'done' });
    return { layout: 'runova' };
  }
  if (answer.outcome !== 'started') return fail(answer.problem ?? 'The core would not start it.');

  deps.resetLink(serverId);
  const deadline = now() + MIGRATION_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(POLL_MS);
    let health: DeployHealth;
    try {
      health = await deps.health(serverId);
    } catch {
      // Down while it moves.
      continue;
    }
    if (health.startedAtUnixMs === before.startedAtUnixMs) continue;
    deps.resetLink(serverId);
    if (health.layout === 'runova') {
      report(deps, 'migrate', { status: 'done' });
      return { layout: 'runova' };
    }
    return fail(health.migrationError ?? 'The core came back on its old layout.');
  }
  return fail(
    'The core did not answer within 5 minutes of the move. Check again from the Overview in a moment.',
  );
}

async function upload(
  deps: CoreUpdateDeps,
  serverId: string,
  rid: NonNullable<ReturnType<typeof releaseRidFor>>,
  oldCore: boolean,
): Promise<{ version: string; sha256: string }> {
  report(deps, 'download', { status: 'running' });
  const release = await deps.releases.release(rid).catch((error: unknown) => {
    report(deps, 'download', { status: 'failed' });
    throw error;
  });
  report(deps, 'download', { status: 'done' });
  const { size } = await stat(release.localPath);
  report(deps, 'upload', { status: 'running', percent: 0 });
  let lastPercent = 0;
  try {
    const answer = await deps.withCoreHttp(serverId, (client, token) =>
      client.putStream<CoreUpdateResult>(CORE_UPDATE_PATH, createReadStream(release.localPath), {
        token,
        contentType: 'application/gzip',
        contentLength: size,
        stallTimeoutMs: UPLOAD_STALL_MS,
        // Both names: a core from before the rename reads only the old ones (and the old file name).
        headers: {
          [RUNOVA_CORE.versionHeader]: release.version,
          [RUNOVA_CORE.fileHeader]: release.file,
          [RUNOVA_CORE.sha256Header]: release.sha256,
          [LEGACY_CORE.versionHeader]: release.version,
          [LEGACY_CORE.fileHeader]: (oldCore ? release.legacyFile : undefined) ?? release.file,
          [LEGACY_CORE.sha256Header]: release.sha256,
        },
        onProgress: (sent) => {
          const percent = Math.floor((sent / size) * 100);
          if (percent >= lastPercent + 5 || percent === 100) {
            lastPercent = percent;
            report(deps, 'upload', { status: 'running', percent });
          }
        },
      }),
    );
    if (answer.outcome !== 'switching') {
      throw new Error(answer.problem ?? 'The core did not take the release.');
    }
  } catch (error) {
    report(deps, 'upload', { status: 'failed' });
    throw explainUpload(error, deps.roles(serverId));
  }
  report(deps, 'upload', { status: 'done', percent: 100 });
  return { version: release.version, sha256: release.sha256 };
}

/** The upload's refusal in the words the Deploy page acts on. */
function explainUpload(error: unknown, roles: string[] | null): Error {
  if (!(error instanceof CoreHttpError))
    return error instanceof Error ? error : new Error(String(error));
  // A core older than this feature has no such route.
  if (error.status === 404) {
    return new NeedsSsh(OLDER_CORE);
  }
  const body = error.body as { code?: unknown; message?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : error.message;
  if (body?.code === 'unsupported') return new NeedsSsh(message);
  if (error.status === 403) {
    return !roles || roles.includes('owner')
      ? new Error(
          encodeCoreError(
            'stepUpRequired',
            'Confirm your password (or a code from your authenticator app) to update the core.',
          ),
        )
      : new Error(encodeCoreError('forbidden', OWNERS_ONLY));
  }
  return new Error(message);
}

async function callHub<T>(
  deps: CoreUpdateDeps,
  serverId: string,
  proof: { password?: string; totpCode?: string } | null,
  work: (hub: ICoreHub) => Promise<T>,
): Promise<T> {
  try {
    return await deps.withHub(serverId, async (hub) => {
      if (proof) await hub.stepUp(proof);
      return work(hub);
    });
  } catch (error) {
    if (error instanceof Error && MISSING_METHOD.test(error.message))
      throw new NeedsSsh(OLDER_CORE);
    // Only an Owner gets past a step-up here, so anyone else is told so rather than asked for it.
    const roles = deps.roles(serverId);
    const explained = explainCoreRefusal(error, roles, !roles || roles.includes('owner'));
    throw coreErrorCode(explained) === 'forbidden'
      ? new Error(encodeCoreError('forbidden', OWNERS_ONLY))
      : explained;
  }
}

/**
 * Waits for the core to answer from a new start, then a little longer, since the switch goes back
 * to the release before when the new one goes down within five seconds. Resolves with the health
 * of whichever release then runs.
 */
async function waitForRestart(
  deps: CoreUpdateDeps,
  serverId: string,
  before: DeployHealth,
  version: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<DeployHealth> {
  const deadline = now() + COMEBACK_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(POLL_MS);
    let health: DeployHealth;
    try {
      health = await deps.health(serverId);
    } catch {
      // Down while it restarts.
      continue;
    }
    if (health.startedAtUnixMs === before.startedAtUnixMs) continue;
    if (health.version !== version) return health;
    await sleep(SETTLE_MS);
    try {
      return await deps.health(serverId);
    } catch {
      // Gone again: the switch is going back. Keep waiting for whichever comes up.
    }
  }
  report(deps, 'switch', { status: 'failed' });
  throw new Error(
    'The core did not answer within 3 minutes of the switch. It may still be starting; check again from the Overview in a moment.',
  );
}
