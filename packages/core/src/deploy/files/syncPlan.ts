import { detectUniformShift, judgeRemote } from './drift.js';
import { syncPathFolder, validateSyncPath } from './pathPolicy.js';
import type {
  BaseEntry,
  LocalChange,
  LocalFileEntry,
  PlannedChange,
  RemoteObservation,
  RemoteVerdict,
  SyncPlan,
  SyncPlanInput,
} from './types.js';

/**
 * Three-way comparison between this computer, the last deploy (the base) and the server, for one
 * FTP or SFTP site (E23). Pure: the walker hands it a local map that is already filtered (ignore
 * rules), the plan step hands it what the server listed, and this decides what each path needs.
 * Paths that fail validateSyncPath are dropped from every input first, so a denied file can never
 * be uploaded, deleted or counted, whichever side it came from.
 *
 * Only paths here or in the base are planned. A file that is only on the server (someone else's,
 * or one the deploy never sent) is never in `changes`, so it is never overwritten or deleted.
 *
 * The local side differs from the base as `added`, `modified` (hash differs) or `deleted`. The
 * server side is judged by judgeRemote (drift.ts). Then:
 * - added: `upload` when the server has no such file (or its folder was not listed); a
 *   conflict `existsOnServer` when it has one, or `adopt` when adopting by size and the sizes
 *   match (the file is taken as sent and goes into the base without travelling).
 * - modified: `upload` when the server is unchanged, or only judged by size or not read (then
 *   marked unverified); a conflict `changedOnServer` or `deletedOnServer` otherwise.
 * - deleted: `deleteRemote` when the server is unchanged or judged by size; a conflict
 *   `changedOnServer` when it changed; nothing to send when it is already gone, the path only
 *   leaves the base (`dropFromBase`).
 * - unchanged: nothing to send. A change on the server is reported in `serverOnlyDrift`, a file
 *   gone from the server in `missingOnServer`; neither is ever acted on by default.
 *
 * Deletes are the one place a missing listing matters: a file is deleted only when its folder was
 * listed (see the deleted case in decide). With `remote` null the plan is the live list of local
 * changes: every change is an `upload` or `deleteRemote`, judged `unknown` and unverified, and
 * the real plan lists the server before anything is sent.
 *
 * Clock shift: when every file that changed on the server only in time moved by the same whole
 * number of hours (detectUniformShift), it is the server's clock or time zone, not an edit. Those
 * files count as unchanged and `clockShiftHours` says by how much.
 *
 * Byte comparison only on this computer (sha256); the server is compared by size and time.
 */
export function planFileSync(input: SyncPlanInput): SyncPlan {
  const local = validOnly(input.local);
  const base = validOnly(input.base);
  const remote = input.remote;
  const entries = remote ? validOnly(remote.entries) : {};
  const paths = [...new Set([...Object.keys(local), ...Object.keys(base)])].sort(compare);

  // First pass: judge the server side, and find a clock shift among the files that changed there
  // in time only.
  const verdicts = new Map<string, RemoteVerdict>();
  const timeOnly: { path: string; base: RemoteObservation; current: RemoteObservation }[] = [];
  if (remote) {
    for (const path of paths) {
      const entry = base[path];
      const current = entries[path];
      const verdict = judgeRemote(entry, current, remote.listedDirs.has(syncPathFolder(path)));
      verdicts.set(path, verdict);
      if (verdict === 'changed' && entry?.remote && current && entry.remote.size === current.size) {
        timeOnly.push({ path, base: entry.remote, current });
      }
    }
  }
  const clockShiftHours = detectUniformShift(timeOnly);
  if (clockShiftHours !== null) {
    for (const pair of timeOnly) verdicts.set(pair.path, 'unchanged');
  }

  // Second pass: decide each path.
  const changes: PlannedChange[] = [];
  const dropFromBase: string[] = [];
  const serverOnlyDrift: string[] = [];
  const missingOnServer: string[] = [];
  for (const path of paths) {
    const here = local[path];
    const entry = base[path];
    const change = localChange(entry, here);
    const verdict = verdicts.get(path) ?? 'unknown';
    if (change === null) {
      if (verdict === 'changed') serverOnlyDrift.push(path);
      else if (verdict === 'missing') missingOnServer.push(path);
      continue;
    }
    const decision = remote
      ? decide(change, verdict, here, entries[path], input.adopt)
      : blind(change);
    if (decision === 'dropFromBase') {
      dropFromBase.push(path);
      continue;
    }
    if (decision === null) continue;
    const { action, conflict } = decision;
    changes.push({
      path,
      local: change,
      remote: verdict,
      action,
      conflict,
      size: action === 'upload' || action === 'conflict' ? (here?.size ?? 0) : 0,
      unverified: verdict === 'sizeOnly' || verdict === 'unknown' || action === 'adopt',
      server: entries[path] ?? null,
      base: entry?.remote ?? null,
    });
  }

  let uploadBytes = 0;
  let deleteCount = 0;
  for (const change of changes) {
    if (change.action === 'upload') uploadBytes += change.size;
    if (change.action === 'deleteRemote') deleteCount += 1;
  }
  return {
    changes,
    conflicts: changes.filter((change) => change.action === 'conflict'),
    uploadBytes,
    deleteCount,
    dropFromBase,
    serverOnlyDrift,
    missingOnServer,
    firstDeploy: firstDeployOf(local, base, remote ? entries : null),
    clockShiftHours,
  };
}

type Decision = Pick<PlannedChange, 'action' | 'conflict'> | 'dropFromBase' | null;

const UPLOAD: Decision = { action: 'upload', conflict: null };
const DELETE: Decision = { action: 'deleteRemote', conflict: null };

/** The decision table, for a plan that read the server. */
function decide(
  change: LocalChange,
  verdict: RemoteVerdict,
  here: LocalFileEntry | undefined,
  current: RemoteObservation | undefined,
  adopt: SyncPlanInput['adopt'],
): Decision {
  if (change === 'added') {
    if (verdict !== 'untracked') return UPLOAD;
    if (adopt === 'bySize' && here && current && here.size === current.size) {
      return { action: 'adopt', conflict: null };
    }
    return { action: 'conflict', conflict: 'existsOnServer' };
  }
  if (change === 'modified') {
    if (verdict === 'changed') return { action: 'conflict', conflict: 'changedOnServer' };
    if (verdict === 'missing') return { action: 'conflict', conflict: 'deletedOnServer' };
    return UPLOAD;
  }
  // Deleted here. A delete needs the folder listed and the file seen as the last deploy left
  // it. When the folder was not listed (`unknown`) nothing is planned this time, not even a
  // drop from the base, and the next plan that lists the folder decides.
  if (verdict === 'unchanged' || verdict === 'sizeOnly') return DELETE;
  if (verdict === 'changed') return { action: 'conflict', conflict: 'changedOnServer' };
  if (verdict === 'missing') return 'dropFromBase';
  return null;
}

/** With the server not read, every local change is planned as is; the real plan judges it. */
function blind(change: LocalChange): Decision {
  return change === 'deleted' ? DELETE : UPLOAD;
}

/**
 * An empty base over a server folder that already holds files: how many of them this deploy
 * would write over, and how many of those have the local size. Reported whenever the server
 * holds anything, so `existing` can be 0 (the folder only has files this site does not send).
 */
function firstDeployOf(
  local: Record<string, LocalFileEntry>,
  base: Record<string, BaseEntry>,
  entries: Record<string, RemoteObservation> | null,
): SyncPlan['firstDeploy'] {
  if (!entries || Object.keys(base).length > 0) return null;
  const onServer = Object.entries(entries);
  if (onServer.length === 0) return null;
  let existing = 0;
  let sameSize = 0;
  for (const [path, current] of onServer) {
    const here = local[path];
    if (!here) continue;
    existing += 1;
    if (here.size === current.size) sameSize += 1;
  }
  return { existing, sameSize };
}

function localChange(
  base: BaseEntry | undefined,
  here: LocalFileEntry | undefined,
): LocalChange | null {
  if (!base) return here ? 'added' : null;
  if (!here) return 'deleted';
  return here.sha256 === base.sha256 ? null : 'modified';
}

function validOnly<T>(map: Readonly<Record<string, T>>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [path, value] of Object.entries(map)) {
    if (validateSyncPath(path).ok) kept[path] = value;
  }
  return kept;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
