import { createFileSiteIgnoreRules } from '@agentmat/core';
import { filesError } from '../../../shared/deployFilesErrors';
import type {
  FileSite,
  FileSiteInput,
  FilesBrowseInput,
  FilesBrowseResult,
  FilesCertificateInfo,
  FilesChangesSnapshot,
  FilesDeployInput,
  FilesHistoryEntry,
  FilesNeedsReview,
  FilesNeedsReviewEvent,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
  FilesRunTrigger,
  FilesTestInput,
  FilesTestResult,
} from '../../../shared/deployFilesTypes';
import { isHostKeyFingerprint, type SshHostKeyStatus } from '../../../shared/sshHostKey';
import { onVaultUnlocked } from '../../ssh/vault';
import { createAutoDeploy } from './autoDeploy';
import { foldAllJournals, peekBase, removeBaseFiles, resetBase } from './bases';
import { type ChangesDeps, createChangesService } from './changes';
import { readHistory, removeHistory } from './history';
import { walkSiteFolder } from './localWalk';
import { createPlanner } from './plan';
import { browseRemote, testConnection } from './probe';
import { createRunner } from './run';
import { createFolderWatcher } from './siteWatcher';
import {
  createFileSite,
  getFileSite,
  keepsTrust,
  MAX_IGNORE_LINE,
  MAX_IGNORE_LINES,
  onFileSitesChanged,
  readFileSites,
  removeFileSite,
  setCapabilities,
  setDeployOnSave,
  setHostKeyFingerprint,
  setLastDeploy,
  setNeedsReview,
  setTlsPin,
  toPublicFileSite,
  updateFileSite,
} from './store';
import { connectTargetOf, connectTargetOfInput } from './target';
import { FilesTransportError } from './transport/errors';
import type { OpenRemoteFiles } from './transport/types';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * The FTP and SFTP sites of Deploy (E23) as one facade, the one thing the IPC handlers call. It
 * joins the site store, Test connection and the remote folder browser, the plan and the run, the
 * live list of changes and Deploy on save, and adds what none of them does alone:
 * - one deploy, test, forget or remove per site at a time; a second call gets `[files:busy]`;
 * - a run's outcome lands on the site (its last deploy, a review it settled) and in the windows,
 *   and the list of changes is walked again before the deploy answers;
 * - trust is never taken from what the dialog sent. A host key or certificate the dialog trusted
 *   is read from the server again and stored only when it is the same one;
 * - Deploy on save hears only about edits a person made, never about the writes a deploy makes
 *   itself, or a pause would lift on its own.
 *
 * What goes out to the windows is only ever `toPublicFileSite` output: a secret stays in main.
 */

export interface FilesServiceEvents {
  /** A watched site's pending changes changed. */
  changes: (snapshot: FilesChangesSnapshot) => void;
  progress: (event: FilesProgressEvent) => void;
  runFinished: (result: FilesRunResult) => void;
  needsReview: (event: FilesNeedsReviewEvent) => void;
  /** After every write to the store, whatever made it. */
  sitesChanged: (sites: FileSite[]) => void;
}

export interface FilesServiceDeps {
  events: FilesServiceEvents;
  /** The OS notification for a new review of Deploy on save. */
  notify: (site: FileSite, review: FilesNeedsReview) => void;
  openRemote: OpenRemoteFiles;
  /** The host key an SFTP login of the site's own presents (connect.ts). */
  readHostKey: (target: FilesConnectTarget) => Promise<string>;
  /** The certificate an FTPS server sends (transport/ftpRemote.ts). */
  readCertificate: (target: FilesConnectTarget) => Promise<FilesCertificateInfo>;
  watch: ChangesDeps['watch'];
  walk: ChangesDeps['walk'];
  onVaultUnlocked: (listener: () => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export type FilesIgnoreCheck = { ok: true } | { ok: false; line: number; reason: string };

export interface FilesService {
  list: () => Promise<FileSite[]>;
  get: (siteId: string) => Promise<FileSite | null>;
  create: (input: FileSiteInput) => Promise<FileSite>;
  update: (siteId: string, input: FileSiteInput) => Promise<FileSite>;
  /** Files on the server are not touched. */
  remove: (siteId: string) => Promise<void>;
  test: (input: FilesTestInput) => Promise<FilesTestResult>;
  browseRemote: (input: FilesBrowseInput) => Promise<FilesBrowseResult>;
  validateIgnore: (lines: readonly string[]) => FilesIgnoreCheck;
  subscribe: (siteId: string, subscriberId: string) => Promise<FilesChangesSnapshot>;
  unsubscribe: (siteId: string, subscriberId: string) => void;
  /** A window closed or reloaded: lets go of every site it watched. */
  dropSubscriber: (subscriberId: string) => void;
  /** The watched snapshot when there is one, else a walk now. */
  changes: (siteId: string) => Promise<FilesChangesSnapshot>;
  plan: (siteId: string) => Promise<FilesPlanView>;
  deploy: (input: FilesDeployInput) => Promise<FilesRunResult>;
  cancel: (siteId: string) => Promise<void>;
  history: (siteId: string) => Promise<FilesHistoryEntry[]>;
  forgetBase: (siteId: string) => Promise<void>;
  setDeployOnSave: (siteId: string, enabled: boolean) => Promise<FileSite>;
  hostKeyStatus: (siteId: string) => Promise<SshHostKeyStatus>;
  trustHostKey: (siteId: string, fingerprint: string) => Promise<void>;
  trustCertificate: (siteId: string, fingerprint256: string) => Promise<void>;
  /** At startup: folds what stopped runs left, then starts Deploy on save where it is on. */
  start: () => Promise<void>;
  /** At quit: stops every run, watcher and timer. */
  close: () => void;
}

const defaultDeps: Omit<FilesServiceDeps, 'events'> = {
  notify: () => undefined,
  // Loaded on first use: the transports pull in the SSH pool and basic-ftp.
  openRemote: async (target, options) =>
    (await import('./connect')).openRemoteFiles(target, options),
  readHostKey: async (target) => (await import('./connect')).readHostKey(target),
  readCertificate: async (target) =>
    (await import('./transport/ftpRemote')).readCertificate(target),
  watch: (root, onSettle) => createFolderWatcher(root, onSettle),
  walk: walkSiteFolder,
  onVaultUnlocked,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const FINGERPRINT = /^[0-9a-f]{64}$/;

function noop(): void {
  // Deliberately nothing: for a failure that is already shown elsewhere.
}

/** A listener that throws (a window that just closed) must not fail the work that told it. */
function safely(tell: () => void): void {
  try {
    tell();
  } catch {
    // Nothing to do: the next event tells it again.
  }
}

function siteUnknown(): Error {
  return filesError('siteUnknown', 'That site is no longer saved.');
}

/** Lowercase hex without colons or spaces, as the store keeps it. */
function cleanFingerprint(value: unknown): string {
  const fingerprint = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[:\s]/g, '');
  if (!FINGERPRINT.test(fingerprint)) {
    throw filesError('invalidInput', 'That is not a SHA-256 fingerprint (64 hex digits).');
  }
  return fingerprint;
}

/**
 * Checks the site's own ignore lines the way the settings box holds them: one entry a line, blank
 * ones included, so the line named is the one the user sees.
 */
export function checkIgnoreLines(lines: readonly string[]): FilesIgnoreCheck {
  let counted = 0;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (typeof raw !== 'string') return { ok: false, line, reason: 'This line is not text.' };
    if (/[\r\n]/.test(raw.replace(/\r$/, ''))) {
      return { ok: false, line, reason: 'A line cannot hold a line break.' };
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_IGNORE_LINE) {
      return { ok: false, line, reason: `Keep each line to ${MAX_IGNORE_LINE} characters.` };
    }
    if (trimmed) counted += 1;
    if (counted > MAX_IGNORE_LINES) {
      return { ok: false, line, reason: `Keep the list to ${MAX_IGNORE_LINES} lines.` };
    }
  }
  const compiled = createFileSiteIgnoreRules([
    { source: 'site settings', text: lines.join('\n'), negations: true },
  ]);
  return compiled.ok ? { ok: true } : { ok: false, line: compiled.line, reason: compiled.reason };
}

/** A login of the site's own as a connect target, without its secret: enough to read a key. */
function probeTargetOf(site: StoredFileSite): FilesConnectTarget {
  const { connection } = site;
  if (connection.kind !== 'custom') {
    throw filesError(
      'invalidInput',
      'This site signs in through a server saved in Remote, which keeps its own key.',
    );
  }
  const { secretEnvelope: _sealed, ...login } = connection;
  return {
    protocol: site.protocol,
    login: { ...login, secret: null },
    remoteRoot: site.remoteRoot,
  };
}

/** Whether a tested connection is the one the site is saved with, so what it learned holds. */
function sameServer(site: StoredFileSite, target: FilesConnectTarget): boolean {
  if (site.protocol !== target.protocol || site.remoteRoot !== target.remoteRoot) return false;
  const { connection } = site;
  const { login } = target;
  if (connection.kind === 'saved') {
    return login.kind === 'saved' && login.sshServerId === connection.sshServerId;
  }
  return (
    login.kind === 'custom' &&
    login.host === connection.host &&
    login.port === connection.port &&
    login.username === connection.username
  );
}

interface Lock {
  controller: AbortController | null;
}

interface FormTrust {
  hostKey: string | null;
  tlsPin: string | null;
}

const NO_TRUST: FormTrust = { hostKey: null, tlsPin: null };

export function createFilesService(
  overrides: Partial<FilesServiceDeps> & Pick<FilesServiceDeps, 'events'>,
): FilesService {
  const deps: FilesServiceDeps = { ...defaultDeps, ...overrides };
  const { events } = deps;
  const locks = new Map<string, Lock>();
  /** Sites each window watches, so a window that goes away lets go of all of them. */
  const subscriptions = new Map<string, Set<string>>();

  const changes = createChangesService({
    // Read only: folding the journal during a run would lose what the run finished.
    readBase: peekBase,
    walk: deps.walk,
    watch: deps.watch,
    now: deps.now,
    publish: (_siteId, snapshot) => safely(() => events.changes(snapshot)),
  });
  const planner = createPlanner({ openRemote: deps.openRemote, now: deps.now });
  const runner = createRunner({
    takePlan: planner.take,
    giveBackPlan: planner.giveBack,
    openRemote: deps.openRemote,
    now: deps.now,
    onProgress: (event) => safely(() => events.progress(event)),
  });

  async function storeReview(siteId: string, review: FilesNeedsReview | null): Promise<void> {
    await setNeedsReview(siteId, review);
    safely(() => events.needsReview({ siteId, needsReview: review }));
  }

  const auto = createAutoDeploy({
    changes,
    getSite: getFileSite,
    // Nobody is there to trust a new host key, so one never trusted pauses Deploy on save.
    plan: (siteId) => planner.plan(siteId, { unattended: true }),
    deploy: (input, trigger) => runLocked(input, trigger),
    setNeedsReview: storeReview,
    notify: (siteId, review) => {
      void getFileSite(siteId)
        .then((site) => {
          if (site) deps.notify(toPublicFileSite(site), review);
        })
        .catch(noop);
    },
    onVaultUnlocked: deps.onVaultUnlocked,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    now: deps.now,
  });

  const stopSites = onFileSitesChanged((sites) =>
    safely(() => events.sitesChanged(sites.map(toPublicFileSite))),
  );

  function hold(siteId: string, controller: AbortController | null): () => void {
    if (locks.has(siteId)) {
      throw filesError(
        'busy',
        'Another deploy or test of this site is running. Wait for it to finish, then try again.',
      );
    }
    const lock: Lock = { controller };
    locks.set(siteId, lock);
    return () => {
      if (locks.get(siteId) === lock) locks.delete(siteId);
    };
  }

  async function locked<T>(siteId: string, work: () => Promise<T>): Promise<T> {
    const release = hold(siteId, null);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function siteOrThrow(siteId: string): Promise<StoredFileSite> {
    const site = await getFileSite(siteId);
    if (!site) throw siteUnknown();
    return site;
  }

  /** Puts a run's outcome on the site. The run happened, so a store failure does not undo it. */
  async function record(result: FilesRunResult): Promise<void> {
    try {
      const site = await setLastDeploy(result.siteId, {
        at: result.finishedAt,
        state: result.state,
        trigger: result.trigger,
        uploaded: result.uploaded,
        deleted: result.deleted,
        failed: result.failed.length,
      });
      const reason = site?.needsReview?.reason;
      if (
        result.trigger === 'user' &&
        result.state === 'done' &&
        (reason === 'conflicts' || reason === 'failed')
      ) {
        // What the review was about was just sent by hand.
        await storeReview(result.siteId, null);
      }
    } catch {
      // Shown again with the next deploy.
    }
  }

  async function runLocked(
    input: FilesDeployInput,
    trigger: FilesRunTrigger,
  ): Promise<FilesRunResult> {
    const siteId = input.siteId;
    const controller = new AbortController();
    const release = hold(siteId, controller);
    let result: FilesRunResult | null = null;
    auto.runStarted(siteId, trigger);
    try {
      result = await runner.run(input, trigger, controller.signal);
      const finished = result;
      await record(finished);
      // The list the windows show should already be the one after the deploy.
      await changes.refresh(siteId).catch(noop);
      safely(() => events.runFinished(finished));
      return finished;
    } finally {
      release();
      auto.runFinished(siteId, trigger, result);
    }
  }

  /**
   * The host key or certificate the dialog says the user trusted, read from the server again.
   * Null when there is nothing new to trust: none sent, or the one the save keeps anyway.
   */
  async function trustFromForm(
    input: FileSiteInput,
    existing: StoredFileSite | null,
  ): Promise<FormTrust> {
    const connection = input?.connection;
    if (connection?.kind !== 'custom') return NO_TRUST;
    const protocol = input.protocol;
    const sent =
      protocol === 'sftp'
        ? connection.hostKeyFingerprint
        : protocol === 'ftps'
          ? connection.tlsPin
          : null;
    if (!sent) return NO_TRUST;
    const fingerprint = cleanFingerprint(sent);
    const target = await connectTargetOfInput({ ...input, remoteRoot: '/' }, null);
    if (target.login.kind !== 'custom') return NO_TRUST;
    const { host, port } = target.login;
    const prior = existing?.connection.kind === 'custom' ? existing.connection : null;
    if (prior && existing && keepsTrust(existing, protocol, { host, port })) {
      const kept = protocol === 'sftp' ? prior.hostKeyFingerprint : prior.tlsPin;
      if (kept === fingerprint) return NO_TRUST;
    }
    if (protocol === 'sftp') {
      const presented = (await deps.readHostKey(target)).toLowerCase();
      if (presented !== fingerprint) {
        throw new FilesTransportError(
          'hostKeyChanged',
          `${host} presented a different host key just now. Run Test connection again and check it before you trust it.`,
          { hostKey: { presented, stored: fingerprint } },
        );
      }
      return { hostKey: fingerprint, tlsPin: null };
    }
    const certificate = await deps.readCertificate(target);
    if (certificate.fingerprint256.toLowerCase() !== fingerprint) {
      throw new FilesTransportError(
        'tlsUntrusted',
        `${host} sent a different certificate just now. Run Test connection again and check it before you trust it.`,
        { certificate },
      );
    }
    return { hostKey: null, tlsPin: fingerprint };
  }

  async function applyTrust(site: StoredFileSite, trust: FormTrust): Promise<StoredFileSite> {
    let next = site;
    if (trust.hostKey) next = (await setHostKeyFingerprint(site.id, trust.hostKey)) ?? next;
    if (trust.tlsPin) next = (await setTlsPin(site.id, trust.tlsPin)) ?? next;
    return next;
  }

  /**
   * The connect target for what the dialog holds now, which may be unfinished: no local folder
   * and no remote folder yet (a test then checks the folder the login lands in). A host key or
   * certificate the dialog trusted is what the connection checks the server against; it is only
   * stored by a save, after the server was read again.
   */
  async function formTarget(
    site: FileSiteInput,
    existing: StoredFileSite | null,
  ): Promise<FilesConnectTarget> {
    if (typeof site !== 'object' || site === null) {
      throw filesError('invalidInput', 'The site is missing.');
    }
    const blankRoot = typeof site.remoteRoot !== 'string' || site.remoteRoot.trim() === '';
    const target = await connectTargetOfInput(
      blankRoot ? { ...site, remoteRoot: '/' } : site,
      existing,
    );
    if (blankRoot) target.remoteRoot = '.';
    const form = site.connection;
    if (target.login.kind === 'custom' && form?.kind === 'custom') {
      if (target.protocol === 'sftp' && form.hostKeyFingerprint) {
        target.login.hostKeyFingerprint = cleanFingerprint(form.hostKeyFingerprint);
      }
      if (target.protocol === 'ftps' && form.tlsPin) {
        target.login.tlsPin = cleanFingerprint(form.tlsPin);
      }
    }
    return target;
  }

  /**
   * The site was edited by a person: plans made before no longer hold, and a pause lifts. Trusting
   * a host key or certificate keeps the plans: what they list is unchanged, and a run that failed
   * on the key gave its plan back so the same review can be deployed (each write is still checked
   * against the server first).
   */
  function edited(site: StoredFileSite, options: { keepPlans?: boolean } = {}): void {
    if (!options.keepPlans) planner.forget(site.id);
    void changes.siteUpdated(site.id).catch(noop);
    void auto.siteUpdated(toPublicFileSite(site)).catch(noop);
  }

  return {
    list: async () => (await readFileSites()).map(toPublicFileSite),

    get: async (siteId) => {
      const site = await getFileSite(siteId);
      return site ? toPublicFileSite(site) : null;
    },

    async create(input) {
      const trust = await trustFromForm(input, null);
      const site = await applyTrust(await createFileSite(input, deps.now()), trust);
      if (site.deployOnSave) void auto.enable(site.id, site.quietSeconds).catch(noop);
      return toPublicFileSite(site);
    },

    async update(siteId, input) {
      const existing = await siteOrThrow(siteId);
      const trust = await trustFromForm(input, existing);
      const site = await applyTrust(await updateFileSite(siteId, input, deps.now()), trust);
      edited(site);
      return toPublicFileSite(site);
    },

    remove: (siteId) =>
      locked(siteId, async () => {
        await auto.disable(siteId).catch(noop);
        changes.siteRemoved(siteId);
        planner.forget(siteId);
        for (const sites of subscriptions.values()) sites.delete(siteId);
        if (!(await removeFileSite(siteId))) {
          // Not in the store: clear anything a half-finished remove left on disk.
          await removeBaseFiles(siteId);
          await removeHistory(siteId);
        }
      }),

    async test(input) {
      const siteId = input?.siteId ?? null;
      const existing = siteId ? await siteOrThrow(siteId) : null;
      const work = async () => {
        const target = await formTarget(input.site, existing);
        const result = await testConnection(target, deps.openRemote, { now: deps.now });
        if (existing && result.ok && result.capabilities && sameServer(existing, target)) {
          await setCapabilities(existing.id, result.capabilities);
        }
        return result;
      };
      return siteId ? locked(siteId, work) : work();
    },

    async browseRemote(input) {
      const siteId = input?.siteId ?? null;
      const existing = siteId ? await siteOrThrow(siteId) : null;
      let target: FilesConnectTarget;
      if (input?.site) target = await formTarget(input.site, existing);
      else if (existing) target = await connectTargetOf(existing);
      else throw filesError('invalidInput', 'Name the server to look at.');
      const remote = await deps.openRemote(target, { purpose: 'browse' });
      try {
        return await browseRemote(remote, typeof input.path === 'string' ? input.path : null);
      } finally {
        await remote.close().catch(noop);
      }
    },

    validateIgnore: checkIgnoreLines,

    async subscribe(siteId, subscriberId) {
      const snapshot = await changes.subscribe(siteId, subscriberId);
      const sites = subscriptions.get(subscriberId) ?? new Set<string>();
      sites.add(siteId);
      subscriptions.set(subscriberId, sites);
      return snapshot;
    },

    unsubscribe(siteId, subscriberId) {
      changes.unsubscribe(siteId, subscriberId);
      subscriptions.get(subscriberId)?.delete(siteId);
    },

    dropSubscriber(subscriberId) {
      for (const siteId of subscriptions.get(subscriberId) ?? []) {
        changes.unsubscribe(siteId, subscriberId);
      }
      subscriptions.delete(subscriberId);
    },

    changes: async (siteId) => changes.snapshot(siteId) ?? changes.refresh(siteId),

    plan: (siteId) => planner.plan(siteId),

    deploy: (input) => runLocked(input, 'user'),

    async cancel(siteId) {
      locks.get(siteId)?.controller?.abort();
    },

    history: (siteId) => readHistory(siteId),

    forgetBase: (siteId) =>
      locked(siteId, async () => {
        await siteOrThrow(siteId);
        await resetBase(siteId);
        // A kept plan judged against the old base would act on it.
        planner.forget(siteId);
        await changes.refresh(siteId).catch(noop);
      }),

    async setDeployOnSave(siteId, enabled) {
      const site = await setDeployOnSave(siteId, enabled === true);
      if (!site) throw siteUnknown();
      // Not awaited: turning it on walks the whole folder first.
      if (site.deployOnSave) void auto.enable(site.id, site.quietSeconds).catch(noop);
      else await auto.disable(site.id).catch(noop);
      return toPublicFileSite((await getFileSite(siteId)) ?? site);
    },

    async hostKeyStatus(siteId) {
      const site = await siteOrThrow(siteId);
      const target = sftpTarget(site);
      const login = target.login as Extract<FilesConnectTarget['login'], { kind: 'custom' }>;
      return {
        serverId: site.id,
        nickname: site.label,
        host: login.host,
        port: login.port,
        stored: login.hostKeyFingerprint,
        presented: await deps.readHostKey(target),
      };
    },

    async trustHostKey(siteId, fingerprint) {
      if (!isHostKeyFingerprint(fingerprint)) {
        throw filesError('invalidInput', 'That is not a host key fingerprint.');
      }
      const site = await siteOrThrow(siteId);
      const target = sftpTarget(site);
      const login = target.login as Extract<FilesConnectTarget['login'], { kind: 'custom' }>;
      // Read again, so what gets stored is what the server presents now, not what was passed in.
      const presented = await deps.readHostKey(target);
      if (presented !== fingerprint) {
        throw new FilesTransportError(
          'hostKeyChanged',
          `${login.host} presented a different key just now. Check it again before trusting it.`,
          { hostKey: { presented, stored: login.hostKeyFingerprint } },
        );
      }
      const updated = await setHostKeyFingerprint(site.id, fingerprint);
      if (updated) edited(updated, { keepPlans: true });
    },

    async trustCertificate(siteId, fingerprint256) {
      const fingerprint = cleanFingerprint(fingerprint256);
      const site = await siteOrThrow(siteId);
      if (site.protocol !== 'ftps') {
        throw filesError('invalidInput', 'Only an FTPS site has a certificate to trust.');
      }
      const target = probeTargetOf(site);
      const certificate = await deps.readCertificate(target);
      if (certificate.fingerprint256.toLowerCase() !== fingerprint) {
        throw new FilesTransportError(
          'tlsUntrusted',
          'The server sent a different certificate just now. Check it again before trusting it.',
          { certificate },
        );
      }
      const updated = await setTlsPin(site.id, fingerprint);
      if (updated) edited(updated, { keepPlans: true });
    },

    async start() {
      await foldAllJournals();
      const sites = await readFileSites().catch((): StoredFileSite[] => []);
      // One after another in the background: each start walks a whole folder.
      void (async () => {
        for (const site of sites) {
          if (site.deployOnSave) await auto.enable(site.id, site.quietSeconds).catch(noop);
        }
      })();
    },

    close() {
      for (const lock of locks.values()) lock.controller?.abort();
      auto.closeAll();
      changes.closeAll();
      stopSites();
    },
  };
}

/** An SFTP site with a login of its own, the only kind whose host key is trusted here. */
function sftpTarget(site: StoredFileSite): FilesConnectTarget {
  if (site.protocol !== 'sftp') {
    throw filesError('invalidInput', 'Only an SFTP site has a host key to trust.');
  }
  return probeTargetOf(site);
}
