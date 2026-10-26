import { baseName, type Project, parseScopeId, type WorktreeInfo } from '@runova/core';

/**
 * A project as one workspace sees it. For a git worktree's workspace the id is the scope id and
 * the folder is the worktree's, so everything that takes a project (the panes, the git panel, the
 * launch helpers) works inside the worktree unchanged. Anything that edits or links to the project
 * itself uses `parentId`.
 */
export interface WorkspaceProject extends Project {
  parentId: string;
  worktree: WorktreeInfo | null;
}

export function asWorkspaceProject(
  project: Project,
  worktree: WorktreeInfo | null = null,
): WorkspaceProject {
  if (!worktree) return { ...project, parentId: project.id, worktree: null };
  return {
    ...project,
    id: `${project.id}~${worktree.id}`,
    folderPath: worktree.path,
    parentId: project.id,
    worktree,
  };
}

/** The workspace for a project id or scope id, or null until what it needs has loaded. */
export function resolveWorkspaceProject(
  projects: readonly Project[],
  worktreesByProject: Readonly<Record<string, readonly WorktreeInfo[] | undefined>>,
  scopeId: string | null,
): WorkspaceProject | null {
  if (!scopeId) return null;
  const { projectId, worktreeId } = parseScopeId(scopeId);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  if (!worktreeId) return asWorkspaceProject(project);
  const worktree = worktreesByProject[projectId]?.find((w) => w.id === worktreeId);
  return worktree ? asWorkspaceProject(project, worktree) : null;
}

/** What a worktree is called in the UI: its branch, or its folder while detached. */
export function worktreeLabel(worktree: Pick<WorktreeInfo, 'branch' | 'path'>): string {
  return worktree.branch ?? baseName(worktree.path);
}

/**
 * Two letters for a worktree's rail tile. The type prefix (`feat/`) is the same on most
 * branches, so the letters come from what follows it.
 */
export function worktreeInitials(label: string): string {
  const name = label.split('/').pop() ?? '';
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  const word = words[0] ?? '';
  if (!word) return '?';
  if (word.length === 1) return word.toUpperCase();
  return `${word[0]?.toUpperCase() ?? ''}${word[1] ?? ''}`;
}
