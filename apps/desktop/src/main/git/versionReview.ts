import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  applyLineEdits,
  type LineHunk,
  lineEditCount,
  lineHunkPreviews,
  lineHunksMatch,
  parseLineHunks,
  splitLinesKeepEnds,
} from '@agentmat/core';
import type { VersionFileChange, WriteVersionHunksInput } from '../../shared/apiTypes';
import { gitEnv } from './plumbing';

const GIT_TIMEOUT_MS = 60000;
/** A version bump is a line or two per file. Past this it is a lockfile nobody reads line by line. */
const MAX_DIFF_LINES = 400;
/** Past this many changed lines a file is reviewed whole; nobody picks through that many. */
const MAX_EDITS = 200;
/** SHA-1 or SHA-256 object ids, and nothing a command line could read as an option. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Runs git with optional stdin and hands back raw stdout. The helpers in plumbing.ts decode
 * to text and take no input, which is wrong for writing file bytes back and for feeding a
 * long path list that would not fit on a Windows command line.
 */
export function runGit(cwd: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      windowsHide: true,
      env: gitEnv(),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => {
      // git can exit before reading all of stdin; the exit code below is its real answer.
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(Buffer.concat(out));
        return;
      }
      const message = Buffer.concat(err).toString('utf8').trim();
      reject(new Error(message || `git ${args[0]} exited with code ${code}.`));
    });
    child.stdin.end(input ?? '');
  });
}

async function gitText(cwd: string, args: string[], input?: string): Promise<string> {
  return (await runGit(cwd, args, input)).toString('utf8');
}

/** Status paths are relative to the repository root, so everything here runs from there. */
export async function repoRoot(cwd: string): Promise<string> {
  return (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/**
 * One file's content, stored twice: `id` as git would commit it (line endings normalized),
 * which is what gets compared and diffed, and `rawId` as the exact bytes on disk, which is
 * what a revert writes back.
 */
interface FileVersion {
  id: string;
  rawId: string;
}

/** Path to content for every file that differs from HEAD; null for one missing from disk. */
export type TreeSnapshot = Map<string, FileVersion | null>;

/**
 * The content of every file that differs from HEAD. Files that match HEAD are left out, so
 * two snapshots only disagree about a path when its content really moved. Unlike line counts,
 * a blob id changes on any edit, including one made to a file that was already modified.
 *
 * The blobs are written into the object store (`hash-object -w`), which is what lets a
 * single file be put back to either side later without a copy of it anywhere else.
 */
export async function snapshotChangedFiles(root: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = new Map();
  const status = await gitText(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]).catch(() => '');

  const present: string[] = [];
  for (const entry of status.split('\0')) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    // --stdin-paths is line based, so a path with a newline in it can't be hashed that way.
    if (path.includes('\n')) continue;
    let stats: ReturnType<typeof lstatSync> | null = null;
    try {
      stats = lstatSync(resolve(root, path));
    } catch {
      stats = null;
    }
    if (!stats) snapshot.set(path, null);
    // A submodule shows up as a folder; its own repo is not something a bump should touch.
    else if (!stats.isDirectory()) present.push(path);
  }

  const ids = await hashFiles(root, present, false);
  const rawIds = await hashFiles(root, present, true);
  for (const [path, id] of ids) {
    const rawId = rawIds.get(path);
    if (rawId) snapshot.set(path, { id, rawId });
  }
  return snapshot;
}

async function hashFiles(
  root: string,
  paths: string[],
  raw: boolean,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (paths.length === 0) return ids;
  const args = raw ? ['hash-object', '-w', '--no-filters'] : ['hash-object', '-w'];
  try {
    const lines = (await gitText(root, [...args, '--stdin-paths'], paths.join('\n')))
      .split('\n')
      .map((line) => line.trim());
    paths.forEach((path, index) => {
      if (OBJECT_ID_PATTERN.test(lines[index] ?? '')) ids.set(path, lines[index]);
    });
    return ids;
  } catch {
    // One unreadable file fails the whole batch, so fall back to asking about each on its own.
    for (const path of paths) {
      const id = await gitText(root, [...args, '--', path])
        .then((out) => out.trim())
        .catch(() => '');
      if (OBJECT_ID_PATTERN.test(id)) ids.set(path, id);
    }
    return ids;
  }
}

/** Blob ids of paths as committed in HEAD; a path HEAD doesn't have is simply absent. */
async function readHeadIds(root: string, paths: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const usable = paths.filter((path) => !path.includes('\n'));
  if (usable.length === 0) return ids;
  const out = await gitText(
    root,
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    usable.map((path) => `HEAD:${path}`).join('\n'),
  ).catch(() => '');
  const lines = out.split('\n');
  usable.forEach((path, index) => {
    const [id, type] = (lines[index] ?? '').trim().split(' ');
    if (type === 'blob' && OBJECT_ID_PATTERN.test(id)) ids.set(path, id);
  });
  return ids;
}

async function diffBlobs(
  root: string,
  beforeId: string | null,
  afterId: string | null,
): Promise<
  Pick<VersionFileChange, 'additions' | 'deletions' | 'diff' | 'diffTruncated' | 'binary'>
> {
  // An empty file stands in for the side that didn't exist when diffing an add or a delete.
  const empty =
    beforeId && afterId
      ? ''
      : (await gitText(root, ['hash-object', '-w', '--stdin'], '').catch(() => '')).trim();
  const raw = await gitText(root, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    beforeId ?? empty,
    afterId ?? empty,
  ]).catch(() => '');

  const lines = raw.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) {
    return { additions: 0, deletions: 0, diff: '', binary: /^Binary files /m.test(raw) };
  }

  const body = lines.slice(firstHunk);
  if (body[body.length - 1] === '') body.pop();
  let additions = 0;
  let deletions = 0;
  for (const line of body) {
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  const truncated = body.length > MAX_DIFF_LINES;
  return {
    additions,
    deletions,
    diff: (truncated ? body.slice(0, MAX_DIFF_LINES) : body).join('\n'),
    diffTruncated: truncated || undefined,
  };
}

/**
 * Every file whose content differs between two snapshots, with the edit between them. A path
 * only one snapshot lists is compared against HEAD for the other side, since that is what
 * "not listed" means.
 */
/**
 * The file as it sits on disk for one side of the run: the raw copy when there is one, or
 * what a checkout would write when that side matched HEAD.
 */
async function readWorkingCopy(
  root: string,
  path: string,
  id: string,
  rawId: string | null,
): Promise<Buffer> {
  return rawId
    ? runGit(root, ['cat-file', 'blob', rawId])
    : runGit(root, ['cat-file', '--filters', `--path=${path}`, id]);
}

export interface SplitFile {
  before: string[];
  after: string[];
  hunks: LineHunk[];
}

/**
 * Both sides of a modified file cut into zero-context hunks, or null when that can't be done
 * safely. The hunks come from git's diff of the committed form, and are only trusted once
 * rebuilding the on-disk bytes from them gives back both sides exactly, so a filter that
 * changes line counts falls back to reviewing the file whole.
 *
 * Lines are decoded as latin1, which maps every byte to one character and back, so whatever
 * the file's encoding the rebuilt bytes are the original ones.
 */
export async function splitFile(
  root: string,
  path: string,
  sides: Pick<VersionFileChange, 'beforeId' | 'afterId' | 'beforeRawId' | 'afterRawId'>,
): Promise<SplitFile | null> {
  const { beforeId, afterId } = sides;
  if (!beforeId || !afterId) return null;
  const diff = await gitText(root, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-U0',
    beforeId,
    afterId,
  ]).catch(() => '');
  const hunks = parseLineHunks(diff);
  if (hunks.length === 0) return null;
  try {
    const [beforeBytes, afterBytes] = await Promise.all([
      readWorkingCopy(root, path, beforeId, sides.beforeRawId),
      readWorkingCopy(root, path, afterId, sides.afterRawId),
    ]);
    const before = splitLinesKeepEnds(beforeBytes.toString('latin1'));
    const after = splitLinesKeepEnds(afterBytes.toString('latin1'));
    return lineHunksMatch(before, after, hunks) ? { before, after, hunks } : null;
  } catch {
    return null;
  }
}

async function hunkPreviews(
  root: string,
  change: VersionFileChange,
): Promise<VersionFileChange['hunks']> {
  if (change.kind !== 'modified' || change.binary || change.diffTruncated || !change.diff) {
    return undefined;
  }
  const split = await splitFile(root, change.path, change);
  if (!split) return undefined;
  const editCount = split.hunks.reduce((sum, hunk) => sum + lineEditCount(hunk), 0);
  if (editCount < 2 || editCount > MAX_EDITS) return undefined;
  const text = (line: string): string => Buffer.from(line, 'latin1').toString('utf8');
  return lineHunkPreviews(split.before, split.after, split.hunks).map((preview, index) => ({
    header: split.hunks[index].header,
    oldLine: preview.oldLine,
    newLine: preview.newLine,
    lead: preview.lead.map(text),
    edits: preview.edits.map(({ removed, added }) => ({
      removed: removed === undefined ? undefined : text(removed),
      added: added === undefined ? undefined : text(added),
    })),
    trail: preview.trail.map(text),
  }));
}

export async function compareSnapshots(
  root: string,
  before: TreeSnapshot,
  after: TreeSnapshot,
): Promise<VersionFileChange[]> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const oneSided = paths.filter((path) => !before.has(path) || !after.has(path));
  const headIds = await readHeadIds(root, oneSided);

  // A path the snapshot doesn't list matches HEAD, and has no raw copy: a checkout recreates it.
  function side(snapshot: TreeSnapshot, path: string): { id: string | null; rawId: string | null } {
    if (!snapshot.has(path)) return { id: headIds.get(path) ?? null, rawId: null };
    const version = snapshot.get(path);
    return { id: version?.id ?? null, rawId: version?.rawId ?? null };
  }

  const changes: VersionFileChange[] = [];
  for (const path of paths) {
    const { id: beforeId, rawId: beforeRawId } = side(before, path);
    const { id: afterId, rawId: afterRawId } = side(after, path);
    if (beforeId === afterId) continue;

    const change: VersionFileChange = {
      path,
      kind: beforeId === null ? 'added' : afterId === null ? 'deleted' : 'modified',
      beforeId,
      afterId,
      beforeRawId,
      afterRawId,
      ...(await diffBlobs(root, beforeId, afterId)),
      hadLocalEdits: before.has(path) || undefined,
    };
    change.hunks = await hunkPreviews(root, change);
    changes.push(change);
  }
  return changes;
}

/**
 * Puts one file back to a recorded version. It refuses when the file no longer holds `fromId`,
 * so an edit made after the run (by the user or anything else) is never silently thrown away.
 */
/**
 * Checks a path and the versions named for it before anything is written, and that the file
 * still holds `fromId`. Returns the file's absolute path.
 */
async function guardFile(
  root: string,
  path: string,
  fromId: string | null,
  ids: (string | null | undefined)[],
): Promise<string> {
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (!path || isAbsolute(path) || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('That path is outside the repository.');
  }
  for (const id of [fromId, ...ids]) {
    if (id != null && !OBJECT_ID_PATTERN.test(id)) throw new Error('Unknown file version.');
  }

  let exists = true;
  try {
    exists = !lstatSync(absolute).isDirectory();
  } catch {
    exists = false;
  }
  const currentId = exists ? (await gitText(root, ['hash-object', '--', path])).trim() : null;
  if (currentId !== fromId) {
    throw new Error(`${path} changed again after the run, so it was left as it is.`);
  }
  return absolute;
}

export async function swapFileVersion(
  root: string,
  path: string,
  fromId: string | null,
  toId: string | null,
  toRawId?: string | null,
): Promise<void> {
  const absolute = await guardFile(root, path, fromId, [toId, toRawId]);

  if (toId === null) {
    await rm(absolute, { force: true });
    return;
  }
  // The raw copy is the file byte for byte, line endings and all. Without one, --filters
  // applies the same line-ending and smudge rules a checkout would.
  const content = toRawId
    ? await runGit(root, ['cat-file', 'blob', toRawId])
    : await runGit(root, ['cat-file', '--filters', `--path=${path}`, toId]);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/**
 * Rewrites a modified file with the run's line edits applied, except the ones in `revertEdits`.
 * Like swapFileVersion it refuses when the file no longer holds `fromId`. Returns the blob id
 * the file ends up with, which the next write to it has to name as `fromId`.
 */
export async function writeFileHunks(
  root: string,
  input: Omit<WriteVersionHunksInput, 'projectId'>,
): Promise<string> {
  const { path, fromId } = input;
  const absolute = await guardFile(root, path, fromId, [
    input.beforeId,
    input.afterId,
    input.beforeRawId,
    input.afterRawId,
  ]);
  const split = await splitFile(root, path, input);
  if (!split) throw new Error(`${path} can no longer be split into separate changes.`);
  const editCount = split.hunks.reduce((sum, hunk) => sum + lineEditCount(hunk), 0);
  const revert = new Set(input.revertEdits);
  for (const index of revert) {
    if (!Number.isInteger(index) || index < 0 || index >= editCount) {
      throw new Error('Unknown change in that file.');
    }
  }

  const content = applyLineEdits(split.before, split.after, split.hunks, revert);
  await writeFile(absolute, Buffer.from(content, 'latin1'));
  return (await gitText(root, ['hash-object', '--', path])).trim();
}
