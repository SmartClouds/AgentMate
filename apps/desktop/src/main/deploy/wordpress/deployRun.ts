import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WP_MAX_FRAME_BLOBS,
  WP_ROUTES,
  type WpConflict,
  type WpDeployItem,
  type WpDeployOp,
  type WpDeployState,
  type WpFileMap,
  type WpHealthCheck,
  type WpItemRef,
  type WpLimits,
  type WpPlannedChange,
  type WpRefusal,
  type WpRefusalReason,
  type WpRollbackReason,
  type WpSyntaxError,
  wpItemKey,
  wpItemRoot,
  wpMirrorPath,
} from '@runova/core';
import type {
  DeployWordPressDeployResult,
  DeployWordPressPhase,
} from '../../../shared/deployWordPressTypes';
import { type WordPressErrorCode, wordPressError } from '../../../shared/wordpressErrors';
import { WpBatchSizer, type WpClient, WpRemoteError, wpRequestCap } from './client';
import { hashFile } from './localManifest';
import { cleanSiteText } from './siteText';

/**
 * One deploy of a WordPress project (E19, E20): begin, upload, commit until applied, verify,
 * finalize. The site takes a snapshot of everything it touches and checks PHP syntax before it
 * applies anything; after the apply its own loopback checks and this computer's GET of the home
 * page must pass, or the deploy is rolled back. A failure or a cancel after `begin` aborts an open
 * deploy and rolls back an applied one, and the project's base only moves once the site says
 * `done`.
 */

export interface WpDeployRunInput {
  client: WpClient;
  projectRoot: string;
  label: string;
  /** Uploads and remote deletes, plus conflicts when the user forced the deploy. */
  changes: readonly WpPlannedChange[];
  items: readonly { item: WpItemRef; isFile: boolean; create: boolean }[];
  /** The project's files as the plan saw them, by wpItemKey. */
  local: ReadonlyMap<string, WpFileMap>;
  /** The site's limits, until begin reports its own. */
  limits: WpLimits;
  force: boolean;
  signal?: AbortSignal;
  report: (phase: DeployWordPressPhase, done: number, total: number, bytes?: number) => void;
  now: () => number;
  /** This computer's GET of the site's home page. */
  external: () => Promise<WpHealthCheck>;
  /** The deploy is open on the site: note it, so a crash can be cleaned up on the next contact. */
  started: (deployId: string) => Promise<void>;
  /** The deploy ended; `done` moves the base, anything else drops the pending one. */
  ended: (deployId: string, state: WpDeployState) => Promise<void>;
}

interface PutOp {
  index: number;
  op: WpDeployOp;
  absolute: string;
  mirror: string;
}

const MAX_COMMIT_CALLS = 2000;

const REFUSAL_TEXT: Record<WpRefusalReason, string> = {
  empty: 'the path is empty',
  tooLong: 'the path is too long',
  controlChar: 'the name holds a control character',
  backslash: 'the name holds a backslash',
  absolute: 'the path is absolute',
  driveLetter: 'the path names a drive',
  colon: 'the name holds a colon',
  emptySegment: 'the path has an empty folder name',
  traversal: 'the path leaves its folder',
  segmentTooLong: 'a name in the path is too long',
  trailingDotOrSpace: 'a name ends in a dot or space',
  reservedName: 'a name is reserved on Windows',
  hardDenied: 'it is on the list of files that never leave this computer',
  itemUnknown: 'the site has no such theme or plugin',
  itemProtected: 'it belongs to Runova Connector itself',
  notWritable: 'PHP cannot write there',
  symlink: 'it is a link on the site',
  tooLarge: 'it is too large',
  deletesActivePluginMainFile: "it would delete an active plugin's main file",
  touchesActiveThemeCore: "it would remove one of the active theme's core files",
};

const PATH_REASONS: ReadonlySet<WpRefusalReason> = new Set<WpRefusalReason>([
  'empty',
  'tooLong',
  'controlChar',
  'backslash',
  'absolute',
  'driveLetter',
  'colon',
  'emptySegment',
  'traversal',
  'segmentTooLong',
  'trailingDotOrSpace',
  'reservedName',
  'hardDenied',
  'symlink',
]);

function siteRef(value: unknown): WpItemRef | null {
  const ref = value as WpItemRef | null;
  return ref && typeof ref.slug === 'string' && typeof ref.kind === 'string' ? ref : null;
}

/** Where a site path is in the project folder, for messages. */
function shownPath(
  isFiles: ReadonlyMap<string, boolean>,
  item: WpItemRef | null,
  path: unknown,
): string {
  const text = typeof path === 'string' ? path : '';
  if (!item) return cleanSiteText(text, 300) || 'a file';
  if (text === '') return cleanSiteText(wpItemRoot(item), 300);
  try {
    return cleanSiteText(wpMirrorPath(item, isFiles.get(wpItemKey(item)) ?? false, text), 400);
  } catch {
    return cleanSiteText(`${wpItemRoot(item)}/${text}`, 400);
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

export function syntaxErrorMessage(
  errors: readonly WpSyntaxError[],
  isFiles: ReadonlyMap<string, boolean>,
): Error {
  const files = new Set(
    errors.map((error) => {
      const item = siteRef(error.item);
      return `${item ? wpItemKey(item) : ''}/${error.path}`;
    }),
  ).size;
  const lines = errors
    .slice(0, 200)
    .map(
      (error) =>
        `${shownPath(isFiles, siteRef(error.item), error.path)}:${Number.isSafeInteger(error.line) ? error.line : 0}: ${cleanSiteText(error.message, 300)}`,
    );
  const summary =
    files === 1 ? '1 PHP file has a syntax error.' : `${files} PHP files have syntax errors.`;
  return wordPressError('syntaxError', [summary, ...lines].join('\n'));
}

export function conflictsMessage(
  conflicts: readonly WpConflict[],
  isFiles: ReadonlyMap<string, boolean>,
): Error {
  const lines = conflicts.slice(0, 200).map((conflict) => {
    const what =
      conflict.actual === null
        ? 'deleted on the site since the plan'
        : conflict.expected === null
          ? 'already on the site'
          : 'changed on the site since the plan';
    return `${shownPath(isFiles, siteRef(conflict.item), conflict.path)}: ${what}`;
  });
  return wordPressError(
    'conflict',
    [`${plural(conflicts.length, 'file', 'files')} changed on the site.`, ...lines].join('\n'),
  );
}

export function refusalsMessage(
  refusals: readonly WpRefusal[],
  isFiles: ReadonlyMap<string, boolean>,
): Error {
  const lines = refusals
    .slice(0, 200)
    .map(
      (refusal) =>
        `${shownPath(isFiles, siteRef(refusal.item), refusal.path)}: ${REFUSAL_TEXT[refusal.reason] ?? cleanSiteText(refusal.reason, 60)}`,
    );
  const blocking = refusals.find((refusal) => !refusal.forceable);
  let code: WordPressErrorCode = 'conflict';
  if (blocking) {
    code = PATH_REASONS.has(blocking.reason)
      ? 'pathRejected'
      : blocking.reason === 'itemUnknown' || blocking.reason === 'itemProtected'
        ? blocking.reason
        : blocking.reason === 'tooLarge'
          ? 'tooLarge'
          : 'notDirect';
  }
  return wordPressError(
    code,
    [`The site refused ${plural(refusals.length, 'change', 'changes')}.`, ...lines].join('\n'),
  );
}

function localChanged(path: string): Error {
  return wordPressError(
    'localChanged',
    `${path} changed on this computer after the deploy was planned. Review the changes again.`,
  );
}

export async function runDeploy(input: WpDeployRunInput): Promise<DeployWordPressDeployResult> {
  const started = input.now();
  const isFiles = new Map(input.items.map((entry) => [wpItemKey(entry.item), entry.isFile]));

  // The ops, from the plan.
  const ops: WpDeployOp[] = [];
  const puts: PutOp[] = [];
  for (const change of input.changes) {
    const local = input.local.get(wpItemKey(change.item))?.[change.path];
    const mirror = wpMirrorPath(
      change.item,
      isFiles.get(wpItemKey(change.item)) ?? false,
      change.path,
    );
    const put = change.action === 'upload' || (change.action === 'conflict' && local);
    if (change.action === 'conflict' && !input.force) continue;
    if (put && local) {
      puts.push({
        index: ops.length,
        absolute: join(input.projectRoot, ...mirror.split('/')),
        mirror,
        op: {
          op: 'put',
          item: change.item,
          path: change.path,
          sha256: local.sha256,
          size: local.size,
          expected: change.expectedRemote,
        },
      });
      ops.push(puts[puts.length - 1].op);
    } else if (change.action === 'deleteRemote' || change.action === 'conflict') {
      ops.push({
        op: 'delete',
        item: change.item,
        path: change.path,
        expected: change.expectedRemote,
      });
    }
  }
  if (ops.length === 0) {
    throw wordPressError('badRequest', 'There is nothing to deploy. Review the changes again.');
  }
  const deletes = ops.filter((op) => op.op === 'delete').length;

  // The files must still be what the plan saw.
  input.report('hashing', 0, puts.length);
  for (const [done, put] of puts.entries()) {
    const info = await lstat(put.absolute).catch(() => null);
    if (!info?.isFile() || info.size !== put.op.size) throw localChanged(put.mirror);
    if ((await hashFile(put.absolute, info.size, info.mtimeMs)) !== put.op.sha256) {
      throw localChanged(put.mirror);
    }
    input.report('hashing', done + 1, puts.length);
  }
  for (const op of ops) {
    if (op.op !== 'delete') continue;
    const mirror = wpMirrorPath(op.item, isFiles.get(wpItemKey(op.item)) ?? false, op.path);
    if (await lstat(join(input.projectRoot, ...mirror.split('/'))).catch(() => null)) {
      throw localChanged(mirror);
    }
  }

  const baseline = await input.external();
  const items: WpDeployItem[] = input.items.map((entry) => ({
    kind: entry.item.kind,
    slug: entry.item.slug,
    ...(entry.create ? { create: true } : {}),
  }));
  input.report('upload', 0, puts.length, 0);
  const begin = (
    await input.client.call(
      WP_ROUTES.deployBegin,
      { label: input.label, items, ops, ...(input.force ? { force: true } : {}) },
      { signal: input.signal },
    )
  ).data;
  if (!begin.deployId) {
    if (Array.isArray(begin.conflicts) && begin.conflicts.length > 0) {
      throw conflictsMessage(begin.conflicts, isFiles);
    }
    throw refusalsMessage(Array.isArray(begin.refusals) ? begin.refusals : [], isFiles);
  }
  const deployId = cleanSiteText(begin.deployId, 64);
  await input.started(deployId);

  let state: WpDeployState = 'open';
  let ended = false;
  const end = async (final: WpDeployState) => {
    ended = true;
    await input.ended(deployId, final);
  };
  const result = (
    final: WpDeployState,
    health: WpHealthCheck[],
    reason?: WpRollbackReason,
  ): DeployWordPressDeployResult => ({
    deployId,
    state: final,
    ...(reason ? { reason } : {}),
    health,
    uploaded: puts.length,
    deleted: deletes,
    durationMs: input.now() - started,
  });

  try {
    await upload(input, deployId, puts, begin.limits ?? input.limits);

    // Commit: validated, then applied in time-boxed steps.
    input.report('validate', 0, ops.length);
    for (let call = 0; ; call++) {
      if (call >= MAX_COMMIT_CALLS) {
        throw wordPressError('timeout', 'The site kept applying the deploy without finishing.');
      }
      const commit = (
        await input.client.call(
          WP_ROUTES.deployCommit,
          { deployId, ...(input.force ? { force: true } : {}) },
          { signal: input.signal },
        )
      ).data;
      if (commit.syntaxErrors?.length) throw syntaxErrorMessage(commit.syntaxErrors, isFiles);
      if (commit.conflicts?.length) throw conflictsMessage(commit.conflicts, isFiles);
      if (commit.refusals?.length) throw refusalsMessage(commit.refusals, isFiles);
      state = commit.state;
      if (state === 'applied') break;
      if (state === 'rolledBack') {
        await end(state);
        return result(state, [], (commit as { reason?: WpRollbackReason }).reason);
      }
      if (state !== 'open' && state !== 'applying') {
        throw wordPressError('invalidState', `The site ended the deploy as ${state}.`);
      }
      input.report('apply', commit.progress?.done ?? 0, commit.progress?.total ?? ops.length);
    }
    input.report('apply', ops.length, ops.length);

    // Verify: the site's loopback checks, then this computer's own look at the home page.
    input.report('verify', 0, 1);
    const verify = (
      await input.client.call(WP_ROUTES.deployVerify, { deployId }, { signal: input.signal })
    ).data;
    const external = await input.external();
    const checks = Array.isArray(verify.checks) ? verify.checks.slice(0, 20) : [];
    const health = [
      ...checks.filter((check) => typeof check === 'object' && check !== null),
      external,
    ].map((check) => ({ ...check, detail: cleanSiteText(check.detail, 300) }));
    if (verify.state === 'rolledBack') {
      state = 'rolledBack';
      await end(state);
      return result(state, health, 'healthCheck');
    }
    const externalBroke = external.ok === false && baseline.ok !== false;
    if (verify.healthy === false || externalBroke) {
      input.report('rollback', 0, 1);
      const rolled = (await input.client.call(WP_ROUTES.deployRollback, { deployId })).data;
      state = rolled.state;
      await end(state);
      return result(state, health, rolled.reason ?? 'healthCheck');
    }

    input.report('finalize', 0, 1);
    let final: { state: WpDeployState; reason?: WpRollbackReason };
    try {
      final = (
        await input.client.call(WP_ROUTES.deployFinalize, { deployId }, { signal: input.signal })
      ).data;
    } catch (error) {
      // The site's guard can roll a deploy back between verify and finalize (its deadline, or a
      // fatal error on a page view), and the site then refuses the finalize. That is a rollback
      // with a reason, not a failure of this call.
      if (!(error instanceof WpRemoteError) || error.code !== 'invalidState') throw error;
      const { deploys } = (await input.client.call(WP_ROUTES.deployHistory, { limit: 20 })).data;
      const record = (Array.isArray(deploys) ? deploys : []).find(
        (deploy) => typeof deploy === 'object' && deploy !== null && deploy.deployId === deployId,
      );
      if (record?.state !== 'rolledBack') throw error;
      state = 'rolledBack';
      await end(state);
      return result(state, health, record.reason ?? 'notConfirmed');
    }
    state = final.state;
    await end(state);
    input.report('done', 1, 1);
    return result(state, health, final.reason);
  } catch (error) {
    if (ended) throw error;
    const outcome = await cleanUp(input, deployId, state, end);
    // A finalize whose reply was lost can still have finished: that deploy is done, not failed.
    if (outcome?.state === 'done') {
      input.report('done', 1, 1);
      return result('done', []);
    }
    // When the deployed code broke the site, the call that noticed it got an error page rather
    // than a reply. The site (or this clean-up) then put the old files back: that is the outcome
    // to report, with its reason, not the error page. A cancel stays a cancel.
    if (outcome?.state === 'rolledBack' && !input.signal?.aborted) {
      const siteBroke =
        error instanceof WpRemoteError &&
        (error.code === 'internal' ||
          (error.code === 'foreignResponse' && (error.status ?? 0) >= 500));
      const reason = outcome.reason;
      if (reason && SITE_ROLLBACK_REASONS.has(reason)) return result('rolledBack', [], reason);
      if (siteBroke) return result('rolledBack', [], 'healthCheck');
    }
    throw error;
  }
}

/** Rollbacks the site did because the deploy broke it, as opposed to one somebody asked for. */
const SITE_ROLLBACK_REASONS: ReadonlySet<WpRollbackReason> = new Set([
  'fatalError',
  'healthCheck',
  'notConfirmed',
]);

/**
 * After a failure or a cancel: abort an open deploy, roll back one that applied, unless the site
 * says it already finished (a finalize whose reply was lost). For a deploy that applied, the
 * rescue routes come first: the site's guard answers them before themes and plugins load, so they
 * work even when the deployed code fatals every other request. Returns how the deploy ended, or
 * null when the site could not be reached; its guard then rolls an unconfirmed deploy back on its
 * own, and the next contact checks.
 */
async function cleanUp(
  input: WpDeployRunInput,
  deployId: string,
  state: WpDeployState,
  end: (state: WpDeployState) => Promise<void>,
): Promise<{ state: WpDeployState; reason?: WpRollbackReason } | null> {
  try {
    if (state === 'open') {
      const aborted = (await input.client.call(WP_ROUTES.deployAbort, { deployId })).data;
      await end(aborted.state);
      return { state: aborted.state };
    }
    const rescued = await viaRescue(input, deployId);
    if (rescued) {
      await end(rescued.state);
      return rescued;
    }
    const { deploys } = (await input.client.call(WP_ROUTES.deployHistory, { limit: 20 })).data;
    const record = (Array.isArray(deploys) ? deploys : []).find(
      (deploy) => typeof deploy === 'object' && deploy !== null && deploy.deployId === deployId,
    );
    if (record?.state === 'done') {
      await end('done');
      return { state: 'done' };
    }
    input.report('rollback', 0, 1);
    const rolled = (await input.client.call(WP_ROUTES.deployRollback, { deployId })).data;
    await end(rolled.state);
    return { state: rolled.state, ...(rolled.reason ? { reason: rolled.reason } : {}) };
  } catch {
    return null;
  }
}

const TERMINAL: ReadonlySet<WpDeployState> = new Set(['done', 'rolledBack', 'aborted', 'expired']);

/** How the deploy ended according to the rescue routes, rolling it back there if it is still pending. */
async function viaRescue(
  input: WpDeployRunInput,
  deployId: string,
): Promise<{ state: WpDeployState; reason?: WpRollbackReason } | null> {
  try {
    const status = (await input.client.call(WP_ROUTES.rescueStatus, {})).data;
    const last = status.last;
    if (last && last.deployId === deployId && TERMINAL.has(last.state)) {
      return { state: last.state, ...(last.reason ? { reason: last.reason } : {}) };
    }
    if (status.pending?.deployId !== deployId) return null;
    input.report('rollback', 0, 1);
    const rolled = (await input.client.call(WP_ROUTES.rescueRollback, { deployId })).data;
    return { state: rolled.state, ...(rolled.reason ? { reason: rolled.reason } : {}) };
  } catch {
    return null;
  }
}

/**
 * A planned file, read once into memory (files are capped at 64 MiB) and checked against the
 * plan: it must still be a plain file, not a link, the very file that was looked at, and hold the
 * bytes the plan hashed. Chunks are cut from this buffer, so nothing is read from disk again.
 */
export async function readPlannedFile(put: {
  absolute: string;
  mirror: string;
  op: Pick<WpDeployOp, 'sha256' | 'size'>;
}): Promise<Buffer> {
  const before = await lstat(put.absolute).catch(() => null);
  if (!before?.isFile() || before.size !== put.op.size) throw localChanged(put.mirror);
  const handle = await open(put.absolute, 'r');
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) {
      throw localChanged(put.mirror);
    }
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(bytes, 0, before.size, 0);
    if (bytesRead !== before.size) throw localChanged(put.mirror);
    if (createHash('sha256').update(bytes).digest('hex') !== put.op.sha256) {
      throw localChanged(put.mirror);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function upload(
  input: WpDeployRunInput,
  deployId: string,
  puts: readonly PutOp[],
  limits: WpLimits,
): Promise<void> {
  const sizer = new WpBatchSizer(wpRequestCap(limits));
  const total = puts.reduce((sum, put) => sum + (put.op.size ?? 0), 0);
  let sent = 0;
  let filesDone = 0;
  let cursor = { put: 0, offset: 0 };
  /** The files of the batch being sent, by position in `puts`; dropped once they are done. */
  const loaded = new Map<number, Buffer>();
  const contents = async (position: number): Promise<Buffer> => {
    let bytes = loaded.get(position);
    if (!bytes) {
      bytes = await readPlannedFile(puts[position]);
      loaded.set(position, bytes);
    }
    return bytes;
  };

  while (cursor.put < puts.length) {
    if (input.signal?.aborted) throw input.signal.reason;
    const chunks: { op: number; offset: number; final: boolean }[] = [];
    const blobs: Uint8Array[] = [];
    let bytes = 0;
    let next = { ...cursor };
    while (next.put < puts.length && blobs.length < WP_MAX_FRAME_BLOBS) {
      const put = puts[next.put];
      const size = put.op.size ?? 0;
      const room = sizer.current - bytes;
      const left = size - next.offset;
      if (left > room && blobs.length > 0) break;
      const length = Math.min(left, room);
      const file = await contents(next.put);
      const final = next.offset + length === size;
      chunks.push({ op: put.index, offset: next.offset, final });
      blobs.push(file.subarray(next.offset, next.offset + length));
      bytes += length;
      next = final
        ? { put: next.put + 1, offset: 0 }
        : { put: next.put, offset: next.offset + length };
      if (!final) break;
    }
    let received: { op: number; nextOffset: number }[];
    try {
      const reply = await input.client.call(
        WP_ROUTES.deployUpload,
        { deployId, chunks },
        { signal: input.signal, blobs },
      );
      sizer.succeeded(reply.durationMs);
      received = Array.isArray(reply.data.received) ? reply.data.received : [];
    } catch (error) {
      if (error instanceof WpRemoteError && error.code === 'tooLarge') {
        sizer.tooLarge();
        continue;
      }
      throw error;
    }
    // The site must have every byte that went.
    const lastOffset = new Map<number, number>();
    for (const [index, chunk] of chunks.entries()) {
      lastOffset.set(chunk.op, chunk.offset + blobs[index].length);
      if (chunk.final) filesDone += 1;
    }
    for (const [op, offset] of lastOffset) {
      const got = received.find((entry) => entry.op === op);
      if (got && got.nextOffset !== offset) {
        const put = puts.find((entry) => entry.index === op) as PutOp;
        throw wordPressError(
          'internal',
          `The site lost part of ${put.mirror} on the way. Try again.`,
        );
      }
    }
    for (let position = cursor.put; position < next.put; position++) loaded.delete(position);
    sent += bytes;
    input.report('upload', filesDone, puts.length, Math.min(sent, total));
    cursor = next;
  }
}
