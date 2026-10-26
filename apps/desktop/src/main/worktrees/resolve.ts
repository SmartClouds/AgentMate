import { type Project, parseScopeId, type WorktreeRecord } from '@runova/core';
import { store } from '../store';

/**
 * A project as a workspace sees it. For a worktree's workspace the id is the scope id and the
 * folder is the worktree's, so the git, explorer and agent handlers, which only ever read
 * `folderPath`, work inside the worktree without knowing it is one.
 */
export interface ScopedProject extends Project {
  /** The real project's id, for anything that edits the project itself. */
  parentId: string;
  /** Set when this is a worktree's workspace. */
  worktree: WorktreeRecord | null;
}

export async function findProjectScope(id: string): Promise<ScopedProject | null> {
  const { projectId, worktreeId } = parseScopeId(id);
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) return null;
  if (!worktreeId) return { ...project, parentId: project.id, worktree: null };

  const worktree = (await store.getWorktrees()).find(
    (w) => w.id === worktreeId && w.projectId === projectId,
  );
  if (!worktree) return null;
  return { ...project, id, folderPath: worktree.path, parentId: project.id, worktree };
}

/** Every worktree folder Runova knows about, so the file system guard lets them through. */
export async function knownWorktreePaths(): Promise<string[]> {
  return (await store.getWorktrees()).map((w) => w.path);
}

/** How notifications name a workspace: "App", or "App (feat-auth)" for one of its worktrees. */
export async function scopeDisplayName(id: string): Promise<string | null> {
  const project = await findProjectScope(id);
  if (!project) return null;
  const branch = project.worktree?.branch;
  return project.worktree ? `${project.name} (${branch ?? 'detached'})` : project.name;
}
