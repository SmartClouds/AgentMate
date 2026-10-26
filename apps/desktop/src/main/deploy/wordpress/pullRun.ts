import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type WpFileMap,
  type WpItemRef,
  type WpLimits,
  type WpPlannedChange,
  wpItemKey,
  wpMirrorPath,
} from '@runova/core';
import type { DeployWordPressPhase } from '../../../shared/deployWordPressTypes';
import { wordPressError } from '../../../shared/wordpressErrors';
import type { WpClient } from './client';
import { hashFile } from './localManifest';
import type { WpLocalWriter } from './localWriter';
import { readRemoteFiles } from './remote';

/**
 * Applies a pull plan to the project folder (E19, E21): downloads what changed on the site,
 * deletes what the site deleted, and settles each conflict the way the user chose. Taking the
 * site's copy first saves this computer's copy under `.runova/wordpress/conflicts/`, which is
 * on the hard deny list, so it can never be deployed. Before anything is written, every file it
 * will replace or delete is checked to still be what the plan saw.
 */

export type WpResolution = 'keepLocal' | 'takeRemote';

export interface WpPullItemState {
  item: WpItemRef;
  isFile: boolean;
  /** As the plan saw them. */
  local: WpFileMap;
  remote: WpFileMap;
  base: WpFileMap;
}

export interface WpPullRunInput {
  client: WpClient;
  writer: WpLocalWriter;
  projectRoot: string;
  changes: readonly WpPlannedChange[];
  items: ReadonlyMap<string, WpPullItemState>;
  resolutions: Readonly<Record<string, WpResolution>>;
  limits: Pick<WpLimits, 'maxResponseBytes' | 'maxPathsPerRead'>;
  signal?: AbortSignal;
  report: (phase: DeployWordPressPhase, done: number, total: number, bytes?: number) => void;
  /** Milliseconds, for the conflict copy folder's name. */
  now: () => number;
}

export interface WpPullRunResult {
  downloaded: number;
  deletedLocal: number;
  conflictCopies: string[];
  /** Each item's base after the pull, by wpItemKey. */
  bases: Map<string, WpFileMap>;
}

export function resolutionKey(item: WpItemRef, path: string): string {
  return `${wpItemKey(item)}/${path}`;
}

function changedError(path: string): Error {
  return wordPressError(
    'localChanged',
    `${path} changed on this computer after the pull was planned. Review the changes again.`,
  );
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

export async function runPull(input: WpPullRunInput): Promise<WpPullRunResult> {
  const { changes, items, resolutions, writer } = input;
  type Step = { change: WpPlannedChange; state: WpPullItemState; mirror: string; copy: boolean };
  const downloads: Step[] = [];
  const deletes: Step[] = [];

  for (const change of changes) {
    const state = items.get(wpItemKey(change.item));
    if (!state) continue;
    const mirror = wpMirrorPath(change.item, state.isFile, change.path);
    const takeRemote =
      change.action === 'conflict' &&
      resolutions[resolutionKey(change.item, change.path)] === 'takeRemote';
    if (change.action === 'download' || (takeRemote && change.remote !== 'deleted')) {
      downloads.push({ change, state, mirror, copy: takeRemote });
    } else if (change.action === 'deleteLocal' || (takeRemote && change.remote === 'deleted')) {
      deletes.push({ change, state, mirror, copy: takeRemote });
    }
  }

  // Nothing is written until everything it would replace is as the plan saw it.
  input.report('hashing', 0, downloads.length + deletes.length);
  for (const step of [...downloads, ...deletes]) {
    const seen = step.state.local[step.change.path];
    const absolute = join(input.projectRoot, ...step.mirror.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (!seen) {
      if (info) throw changedError(step.mirror);
      continue;
    }
    if (!info?.isFile() || info.size !== seen.size) throw changedError(step.mirror);
    if ((await hashFile(absolute, info.size, info.mtimeMs)) !== seen.sha256) {
      throw changedError(step.mirror);
    }
  }

  const conflictRoot = `.runova/wordpress/conflicts/${stamp(input.now())}`;
  const conflictCopies: string[] = [];
  const keepCopy = async (step: Step) => {
    if (!step.copy || !step.state.local[step.change.path]) return;
    const bytes = await readFile(join(input.projectRoot, ...step.mirror.split('/')));
    const copy = `${conflictRoot}/${step.mirror}`;
    await writer.writeFile(copy, bytes);
    conflictCopies.push(copy);
  };

  /** What each touched path holds now, by item key then path; null for deleted. */
  const after = new Map<string, Map<string, { sha256: string; size: number } | null>>();
  const record = (
    item: WpItemRef,
    path: string,
    entry: { sha256: string; size: number } | null,
  ) => {
    const key = wpItemKey(item);
    if (!after.has(key)) after.set(key, new Map());
    after.get(key)?.set(path, entry);
  };

  const total = downloads.length + deletes.length;
  let done = 0;
  let bytes = 0;
  let downloaded = 0;
  input.report('download', 0, total, 0);
  const byItem = new Map<string, Step[]>();
  for (const step of downloads) {
    const key = wpItemKey(step.change.item);
    byItem.set(key, [...(byItem.get(key) ?? []), step]);
  }
  for (const steps of byItem.values()) {
    const item = steps[0].change.item;
    const byPath = new Map(steps.map((step) => [step.change.path, step]));
    await readRemoteFiles(
      input.client,
      item,
      steps.map((step) => ({
        path: step.change.path,
        size: step.change.size,
        sha256: step.state.remote[step.change.path]?.sha256 ?? '',
      })),
      {
        limits: input.limits,
        isFile: steps[0].state.isFile,
        signal: input.signal,
        onBytes: (count) => {
          bytes += count;
          input.report('download', done, total, bytes);
        },
        onFile: async (path, content, sha256) => {
          const step = byPath.get(path);
          if (!step) return;
          await keepCopy(step);
          await writer.writeFile(step.mirror, content);
          record(item, path, { sha256, size: content.length });
          downloaded += 1;
          done += 1;
          input.report('write', done, total, bytes);
        },
      },
    );
  }
  let deletedLocal = 0;
  for (const step of deletes) {
    if (input.signal?.aborted) throw input.signal.reason;
    await keepCopy(step);
    if (await writer.deleteFile(step.mirror)) deletedLocal += 1;
    record(step.change.item, step.change.path, null);
    done += 1;
    input.report('write', done, total, bytes);
  }

  // The new base: what both sides now agree on, plus what the user chose to keep.
  const bases = new Map<string, WpFileMap>();
  for (const [key, state] of items) {
    const touched = after.get(key) ?? new Map();
    const next: WpFileMap = { ...state.base };
    const paths = new Set([
      ...Object.keys(state.local),
      ...Object.keys(state.remote),
      ...Object.keys(state.base),
    ]);
    for (const path of paths) {
      const local = touched.has(path) ? touched.get(path) : state.local[path];
      const remote = state.remote[path];
      const keepLocal = resolutions[resolutionKey(state.item, path)] === 'keepLocal';
      if (local && remote && local.sha256 === remote.sha256) next[path] = remote;
      else if (!local && !remote) delete next[path];
      else if (touched.has(path) && local) next[path] = local;
      else if (keepLocal) {
        if (remote) next[path] = remote;
        else delete next[path];
      }
    }
    bases.set(key, next);
  }
  return {
    downloaded,
    deletedLocal,
    conflictCopies,
    bases,
  };
}
