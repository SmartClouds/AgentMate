import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  defaultWorktreePath,
  type GitWorktreeEntry,
  type Project,
  parseScopeId,
  uniquePath,
  type WorktreeInfo,
  type WorktreeRecord,
} from '@runova/core';
import type {
  CreateWorktreeInput,
  WorktreeDefaults,
  WorktreeMergePreflight,
  WorktreeMergeResult,
  WorktreeRemovePreflight,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  currentBranch,
  deleteBranch,
  detectDefaultBranch,
  gitOrNull,
  isGitRepo,
  listBranches,
  safeBranchName,
} from '../git/plumbing';
import {
  addWorktree,
  copyFiles,
  listCopyCandidates,
  listWorktrees,
  mergeBaseIntoWorktree,
  mergeIntoBase,
  mergePreflight,
  pruneWorktrees,
  removeWorktree,
  samePath,
  worktreeStatus,
} from '../git/worktrees';
import { broadcastToWindows } from '../ipc/send';
import { store } from '../store';

/**
 * The worktrees of each project: git's own list, joined with the records in worktrees.json that
 * give each one a stable id (and so a workspace of its own). Git is the source of truth. A record
 * git no longer knows is dropped, and a worktree made outside Runova is adopted.
 */

function newWorktreeId(): string {
  return `wt-${randomUUID().slice(0, 8)}`;
}

/** Record writes are read-modify-write, so two lists at once must not undo each other. */
let recordQueue: Promise<unknown> = Promise.resolve();

function withRecords<T>(
  fn: (records: WorktreeRecord[]) => Promise<{ records: WorktreeRecord[]; value: T }>,
): Promise<T> {
  const run = recordQueue.then(async () => {
    const before = await store.getWorktrees();
    const { records, value } = await fn(before);
    if (JSON.stringify(records) !== JSON.stringify(before)) await store.setWorktrees(records);
    return value;
  });
  recordQueue = run.catch(() => undefined);
  return run;
}

function notifyChanged(projectId: string): void {
  broadcastToWindows(IPC.worktrees.onChanged, projectId);
}

/** Worktrees hang off a project's main checkout, never off another worktree. */
async function requireProject(projectId: string): Promise<Project> {
  if (parseScopeId(projectId).worktreeId) {
    throw new Error('Worktrees are made from the project itself, not from one of its worktrees.');
  }
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project;
}

async function requireRecord(
  projectId: string,
  worktreeId: string,
): Promise<{ project: Project; record: WorktreeRecord }> {
  const project = await requireProject(projectId);
  const record = (await store.getWorktrees()).find(
    (w) => w.id === worktreeId && w.projectId === projectId,
  );
  if (!record) throw new Error('That worktree is no longer there.');
  return { project, record };
}

async function copyGlobsFor(project: Project): Promise<string[]> {
  return project.worktreeSetup.copyGlobs ?? (await store.getSettings()).worktrees.copyGlobs;
}

async function baseFor(project: Project, record: WorktreeRecord): Promise<string | null> {
  return record.baseBranch ?? (await detectDefaultBranch(project.folderPath));
}

/** The linked worktrees git lists for a checkout: everything but the checkout itself. */
function linkedEntries(project: Project, entries: GitWorktreeEntry[]): GitWorktreeEntry[] {
  return entries.filter(
    (entry, index) => index > 0 && !entry.bare && !samePath(entry.path, project.folderPath),
  );
}

async function withStatus(
  project: Project,
  record: WorktreeRecord,
  entry: GitWorktreeEntry,
): Promise<WorktreeInfo> {
  const missing = entry.prunable || !existsSync(record.path);
  const status = missing ? null : await worktreeStatus(record.path, await baseFor(project, record));
  return {
    ...record,
    missing,
    locked: entry.locked,
    ...(entry.lockReason ? { lockReason: entry.lockReason } : {}),
    status,
  };
}

export async function listProjectWorktrees(projectId: string): Promise<WorktreeInfo[]> {
  const project = await requireProject(projectId);
  const entries = await listWorktrees(project.folderPath).catch(() => null);
  if (!entries) return [];
  const linked = linkedEntries(project, entries);

  const pairs = await withRecords(async (all) => {
    const mine = all.filter((r) => r.projectId === projectId);
    const others = all.filter((r) => r.projectId !== projectId);
    let defaultBranch: string | null | undefined;
    const kept: { record: WorktreeRecord; entry: GitWorktreeEntry }[] = [];
    for (const entry of linked) {
      let record = mine.find((r) => samePath(r.path, entry.path));
      if (!record) {
        defaultBranch ??= await detectDefaultBranch(project.folderPath);
        record = {
          id: newWorktreeId(),
          projectId,
          path: entry.path,
          branch: entry.branch,
          baseBranch: defaultBranch,
          createdAt: new Date().toISOString(),
          createdByApp: false,
        };
      } else if (record.branch !== entry.branch && !entry.prunable) {
        // Someone switched branches inside the worktree.
        record = { ...record, branch: entry.branch };
      }
      kept.push({ record, entry });
    }
    return { records: [...others, ...kept.map((k) => k.record)], value: kept };
  });

  return Promise.all(pairs.map(({ record, entry }) => withStatus(project, record, entry)));
}

export async function worktreeDefaults(projectId: string): Promise<WorktreeDefaults> {
  const project = await requireProject(projectId);
  const copyGlobs = await copyGlobsFor(project);
  const setupCommand = project.worktreeSetup.command;
  if (!(await isGitRepo(project.folderPath))) {
    return {
      isRepo: false,
      defaultBranch: null,
      currentBranch: null,
      branches: [],
      copyGlobs,
      setupCommand,
    };
  }
  const [defaultBranch, current, branches] = await Promise.all([
    detectDefaultBranch(project.folderPath),
    currentBranch(project.folderPath),
    listBranches(project.folderPath),
  ]);
  return {
    isRepo: true,
    defaultBranch: defaultBranch ?? (current || null),
    currentBranch: current || null,
    branches,
    copyGlobs,
    setupCommand,
  };
}

export async function suggestWorktreePath(projectId: string, branch: string): Promise<string> {
  const project = await requireProject(projectId);
  const { baseDir } = (await store.getSettings()).worktrees;
  return uniquePath(defaultWorktreePath(project.folderPath, branch, baseDir), existsSync);
}

export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeInfo> {
  const project = await requireProject(input.projectId);
  if (!(await isGitRepo(project.folderPath))) {
    throw new Error(
      'This project is not a git repository yet. Initialize it on the Git tab first.',
    );
  }
  const defaultBranch =
    (await detectDefaultBranch(project.folderPath)) || (await currentBranch(project.folderPath));
  const base = input.mode === 'new' ? input.base || defaultBranch || null : defaultBranch || null;
  const path = input.path ?? (await suggestWorktreePath(project.id, input.branch));
  const entry = await addWorktree(project.folderPath, {
    path,
    branch: input.branch,
    mode: input.mode,
    base,
  });

  const record: WorktreeRecord = {
    id: newWorktreeId(),
    projectId: project.id,
    path: entry.path,
    branch: entry.branch,
    baseBranch: base,
    createdAt: new Date().toISOString(),
    createdByApp: true,
  };
  await withRecords(async (all) => ({
    records: [...all.filter((r) => !samePath(r.path, entry.path)), record],
    value: undefined,
  }));
  notifyChanged(project.id);
  return withStatus(project, record, entry);
}

export async function previewCopy(projectId: string, globs: string[] | null): Promise<string[]> {
  const project = await requireProject(projectId);
  return listCopyCandidates(project.folderPath, globs ?? (await copyGlobsFor(project)));
}

export async function copyIntoWorktree(
  projectId: string,
  worktreeId: string,
  files: string[],
): Promise<string[]> {
  const { project, record } = await requireRecord(projectId, worktreeId);
  return copyFiles(project.folderPath, record.path, files);
}

export async function removePreflight(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeRemovePreflight> {
  const { project, record } = await requireRecord(projectId, worktreeId);
  const base = await baseFor(project, record);
  const missing = !existsSync(record.path);
  const status = missing ? null : await worktreeStatus(record.path, base);

  let ahead = status?.ahead ?? 0;
  let merged = status?.merged ?? true;
  if (missing && record.branch && base) {
    // The folder is gone but the branch may not be: judge it from the main checkout.
    const count = await gitOrNull(project.folderPath, [
      'rev-list',
      '--count',
      `${safeBranchName(base)}..${safeBranchName(record.branch)}`,
    ]);
    ahead = Number(count?.trim() ?? 0) || 0;
    merged = ahead === 0;
  }
  return {
    branch: record.branch,
    baseBranch: base,
    missing,
    changes: status?.changes ?? 0,
    ahead,
    unpushed: status?.unpushed ?? null,
    merged,
  };
}

export async function removeProjectWorktree(input: {
  projectId: string;
  worktreeId: string;
  force: boolean;
  deleteBranch: boolean;
}): Promise<string> {
  const { project, record } = await requireRecord(input.projectId, input.worktreeId);
  const preflight = await removePreflight(project.id, record.id);
  await removeWorktree(project.folderPath, record.path, { force: input.force });
  await pruneWorktrees(project.folderPath).catch(() => undefined);
  await withRecords(async (all) => ({
    records: all.filter((r) => r.id !== record.id),
    value: undefined,
  }));

  const notes = [`Removed the worktree for ${record.branch ?? 'a detached HEAD'}.`];
  if (input.deleteBranch && record.branch) {
    try {
      await deleteBranch(project.folderPath, record.branch, {
        deleteRemote: false,
        force: input.force || preflight.merged,
      });
      notes.push(`Deleted branch '${record.branch}'.`);
    } catch (error) {
      notes.push(`Kept branch '${record.branch}': ${(error as Error).message}`);
    }
  }
  notifyChanged(project.id);
  return notes.join(' ');
}

async function mergeTarget(projectId: string, worktreeId: string) {
  const { project, record } = await requireRecord(projectId, worktreeId);
  const base = await baseFor(project, record);
  if (!base) throw new Error('This worktree has no base branch to merge into.');
  if (!record.branch) throw new Error('This worktree is on a detached HEAD, not a branch.');
  return { project, record, base, branch: record.branch };
}

export async function worktreeMergePreflight(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeMergePreflight> {
  const { project, record, base, branch } = await mergeTarget(projectId, worktreeId);
  return mergePreflight(project.folderPath, record.path, branch, base);
}

export async function mergeWorktree(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeMergeResult> {
  const { project, record, base, branch } = await mergeTarget(projectId, worktreeId);
  const check = await mergePreflight(project.folderPath, record.path, branch, base);
  if (!check.ok) throw new Error(`Not ready to merge: ${check.blocker.kind}.`);
  const result = await mergeIntoBase(project.folderPath, branch, base);
  notifyChanged(project.id);
  return result;
}

export async function mergeBaseIntoProjectWorktree(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeMergeResult> {
  const { project, record, base } = await mergeTarget(projectId, worktreeId);
  const result = await mergeBaseIntoWorktree(record.path, base);
  notifyChanged(project.id);
  return result;
}

export async function pruneProjectWorktrees(projectId: string): Promise<void> {
  const project = await requireProject(projectId);
  await pruneWorktrees(project.folderPath);
  // Listing again is what drops the records of the worktrees git just forgot.
  await listProjectWorktrees(projectId);
  notifyChanged(projectId);
}
