import { type Project, parseScopeId, type WorktreeInfo } from '@runova/core';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { resolveWorkspaceProject, type WorkspaceProject } from '@/lib/workspace/scope';

/**
 * Status is read fresh from git for every worktree, which is a handful of processes each, so
 * a list only goes stale on its own after a while. Main pushes the changes that matter.
 */
const WORKTREES_STALE_MS = 15_000;

/** A click that raises the window and then focuses a field are one return, so one refresh. */
const FOCUS_THROTTLE_MS = 2000;
/** Shared by every component showing a project's worktrees, so a focus refreshes each list once. */
const lastFocusRefresh = new Map<string, number>();

/**
 * A project's git worktrees, kept current: main says when it adds or removes one, a commit,
 * checkout or merge in any of them (the repo watcher) changes their ahead and behind counts, and
 * coming back to the window catches worktrees made or deleted from a terminal meanwhile.
 */
export function useWorktrees(projectId: string | null): UseQueryResult<WorktreeInfo[]> {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees(projectId) });
    };
    const stopChanged = window.runova.worktrees.onChanged((changed) => {
      if (changed === projectId) refresh();
    });
    const stopRepo = window.runova.git.onRepoChanged((changed) => {
      if (parseScopeId(changed).projectId === projectId) refresh();
    });
    const onFocus = (): void => {
      const now = Date.now();
      if (now - (lastFocusRefresh.get(projectId) ?? 0) < FOCUS_THROTTLE_MS) return;
      lastFocusRefresh.set(projectId, now);
      refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      stopChanged();
      stopRepo();
      window.removeEventListener('focus', onFocus);
    };
  }, [projectId, queryClient]);

  return useQuery({
    queryKey: queryKeys.worktrees(projectId ?? ''),
    queryFn: () => window.runova.worktrees.list(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: WORKTREES_STALE_MS,
  });
}

/**
 * The project a workspace works on, from a project id or a worktree's scope id. A worktree's
 * workspace waits for the worktree list, since that is where its folder comes from.
 */
export function useWorkspaceProject(scopeId: string | null): {
  project: WorkspaceProject | null;
  projects: Project[];
  isPending: boolean;
} {
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const scope = scopeId ? parseScopeId(scopeId) : null;
  const worktreesQuery = useWorktrees(scope?.worktreeId ? scope.projectId : null);
  const projects = projectsQuery.data ?? [];
  const worktrees = scope && worktreesQuery.data ? { [scope.projectId]: worktreesQuery.data } : {};
  return {
    project: resolveWorkspaceProject(projects, worktrees, scopeId),
    projects,
    isPending: projectsQuery.isPending || (Boolean(scope?.worktreeId) && worktreesQuery.isPending),
  };
}
