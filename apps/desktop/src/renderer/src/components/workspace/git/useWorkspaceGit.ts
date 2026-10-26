import type { GitChangeEntry, Project } from '@runova/core';
import type { GitApplyLinesInput, GitDiscardResult, WorkspaceGitState } from '@shared/apiTypes';
import { isImagePath } from '@shared/imageFiles';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { projectFilePath, repoFileAbsolutePath } from '@/lib/git';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { announcePublishedBranch } from './pr/usePullRequest';

/**
 * The workspace changes panel's state for a project. While `watching`, main watches the
 * working tree and pushes every change, so this never polls.
 */
export function useWorkspaceGitState(projectId: string, watching: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.gitWorkspaceState(projectId),
    queryFn: () => window.runova.git.workspaceState(projectId),
    meta: { silentLoading: true },
    // Pushed updates keep it current; a refetch on its own would only duplicate them.
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    return window.runova.git.onWorkspaceState((id, state) => {
      if (id !== projectId) return;
      queryClient.setQueryData(queryKeys.gitWorkspaceState(projectId), state);
      // Open diffs and the project page's Git tab read the same tree.
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitFileDiffs(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
      // A file was added, removed or changed on disk; the explorer tree re-reads its open folders.
      void queryClient.invalidateQueries({ queryKey: ['workspace-explorer', projectId] });
    });
  }, [projectId, queryClient]);

  useEffect(() => {
    if (!watching) return;
    void window.runova.git.watchWorkingTree(projectId);
    return () => {
      void window.runova.git.unwatchWorkingTree(projectId);
    };
  }, [projectId, watching]);

  return query;
}

/**
 * Opens a changed file in a tab next to the terminals: an image in the viewer, anything else in
 * the editor. Another binary file, or one that sits in the repository but outside the project
 * folder (the app only reads inside projects), goes to its default app instead.
 */
export function openChangedFile(
  project: Project,
  projectPrefix: string,
  repoPath: string,
  binary?: boolean,
): void {
  const readable = !binary || isImagePath(repoPath);
  const inProject = readable ? projectFilePath(project.folderPath, projectPrefix, repoPath) : null;
  if (inProject) {
    useWorkspaceStore.getState().openFile(project.id, inProject, { pin: true });
    return;
  }
  void window.runova.shell.openPath(
    repoFileAbsolutePath(project.folderPath, projectPrefix, repoPath),
  );
}

/**
 * AI conflict runs still going, keyed by project and path, holding the id that stops each one.
 * Kept outside React so closing the panel or the diff tab doesn't lose track of a run.
 */
const useAiResolves = create<Record<string, string>>(() => ({}));

function aiResolveKey(projectId: string, path: string): string {
  return `${projectId}\n${path}`;
}

/** Whether an AI CLI is working on this conflicted file right now. */
export function useAiResolving(projectId: string, path: string): boolean {
  return useAiResolves((s) => aiResolveKey(projectId, path) in s);
}

/** The same for a whole list of rows, which can't each call a hook. */
export function useAiResolvingPaths(projectId: string): (path: string) => boolean {
  const runs = useAiResolves();
  return (path) => aiResolveKey(projectId, path) in runs;
}

function without(entries: GitChangeEntry[], paths: Set<string>): GitChangeEntry[] {
  return entries.filter((entry) => !paths.has(entry.path));
}

/** Moves rows between sections straight away; the state main pushes back settles the details. */
function optimistic(
  queryClient: QueryClient,
  projectId: string,
  change: (state: WorkspaceGitState) => WorkspaceGitState,
): void {
  queryClient.setQueryData<WorkspaceGitState>(queryKeys.gitWorkspaceState(projectId), (state) =>
    state ? change(state) : state,
  );
}

export interface GitActions {
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[], side: 'unstaged' | 'untracked') => Promise<void>;
  /** Stages, unstages or discards only some lines of one file. */
  applyLines: (input: Omit<GitApplyLinesInput, 'projectId'>) => Promise<void>;
  resolve: (path: string, pick: 'ours' | 'theirs') => Promise<void>;
  /** Has an AI CLI edit out the conflict markers, or stops it if it is already on that file. */
  resolveWithAi: (path: string) => Promise<void>;
  abort: () => Promise<void>;
  commit: (message: string, push: boolean) => Promise<boolean>;
  /** Stashes the working tree; `mode` picks the git flags, like VS Code's stash menu. */
  stash: (mode: 'all' | 'keep-staged', message?: string) => Promise<void>;
  /** Restores a stash but keeps it (`apply`) or drops it (`pop`). No ref means the newest. */
  stashRestore: (action: 'pop' | 'apply', ref?: string) => Promise<void>;
  /** Forgets a stash without restoring it. */
  stashDrop: (ref: string) => Promise<void>;
}

export function useGitActions(projectId: string): GitActions {
  const queryClient = useQueryClient();
  return useMemo<GitActions>(() => {
    const git = window.runova.git;
    const resync = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(projectId) });
    };
    const undoableToast = (result: GitDiscardResult, description?: string): void => {
      const token = result.undoToken;
      toast.success(result.message, {
        description,
        action: token
          ? {
              label: 'Undo',
              onClick: () => {
                void git.undoDiscard(projectId, token).then((undo) => {
                  if (!undo.ok) toast.error('Could not undo', { description: undo.message });
                });
              },
            }
          : undefined,
      });
    };

    return {
      stage: async (paths) => {
        const set = new Set(paths);
        optimistic(queryClient, projectId, (state) => {
          const moved = [...state.unstaged, ...state.untracked, ...state.conflicts]
            .filter(
              (entry) => set.has(entry.path) && !state.staged.some((s) => s.path === entry.path),
            )
            .map((entry) => ({
              path: entry.path,
              status:
                entry.status === '?'
                  ? ('A' as const)
                  : entry.status === 'U'
                    ? ('M' as const)
                    : entry.status,
              additions: entry.additions,
              deletions: entry.deletions,
            }));
          return {
            ...state,
            staged: [...state.staged, ...moved].sort((a, b) => a.path.localeCompare(b.path)),
            unstaged: without(state.unstaged, set),
            untracked: without(state.untracked, set),
            conflicts: without(state.conflicts, set),
          };
        });
        const result = await git.stage(projectId, paths);
        if (!result.ok) {
          toast.error('Could not stage', { description: result.message });
          resync();
        }
      },

      unstage: async (paths) => {
        const set = new Set(paths);
        optimistic(queryClient, projectId, (state) => {
          const leaving = state.staged.filter((entry) => set.has(entry.path));
          const toUntracked = leaving
            .filter((entry) => entry.status === 'A')
            .map((entry) => ({ path: entry.path, status: '?' as const }));
          const toUnstaged = leaving
            .filter(
              (entry) => entry.status !== 'A' && !state.unstaged.some((u) => u.path === entry.path),
            )
            .map((entry) => ({ ...entry, origPath: undefined }));
          const byPath = (a: GitChangeEntry, b: GitChangeEntry): number =>
            a.path.localeCompare(b.path);
          return {
            ...state,
            staged: without(state.staged, set),
            unstaged: [...state.unstaged, ...toUnstaged].sort(byPath),
            untracked: [...state.untracked, ...toUntracked].sort(byPath),
          };
        });
        const result = await git.unstage(projectId, paths);
        if (!result.ok) {
          toast.error('Could not unstage', { description: result.message });
          resync();
        }
      },

      discard: async (paths, side) => {
        const set = new Set(paths);
        optimistic(queryClient, projectId, (state) =>
          side === 'untracked'
            ? { ...state, untracked: without(state.untracked, set) }
            : { ...state, unstaged: without(state.unstaged, set) },
        );
        const result = await git.discard(projectId, paths, side);
        if (!result.ok) {
          toast.error('Could not discard', { description: result.message });
          resync();
          return;
        }
        undoableToast(result);
      },

      // No optimistic move: staging part of a file leaves it in both sections, and main pushes
      // the real state straight after.
      applyLines: async (input) => {
        const result = await git.applyLines({ ...input, projectId });
        if (!result.ok) {
          const title =
            input.action === 'stage'
              ? 'Could not stage those lines'
              : input.action === 'unstage'
                ? 'Could not unstage those lines'
                : 'Could not discard those lines';
          toast.error(title, { description: result.message });
          resync();
          return;
        }
        if (input.action === 'discard') undoableToast(result);
      },

      resolve: async (path, pick) => {
        const result = await git.resolveConflict(projectId, path, pick);
        if (result.ok) toast.success(result.message);
        else toast.error('Could not resolve the conflict', { description: result.message });
      },

      resolveWithAi: async (path) => {
        const key = aiResolveKey(projectId, path);
        const running = useAiResolves.getState()[key];
        if (running) {
          // Main puts the file back once the CLI is down; the run below settles the state.
          void git.cancelResolveConflictWithAi(running);
          return;
        }
        const requestId = crypto.randomUUID();
        useAiResolves.setState({ [key]: requestId });
        try {
          const result = await git.resolveConflictWithAi(projectId, path, requestId);
          if (result.cancelled) return;
          if (result.ok) undoableToast(result, result.summary);
          else toast.error('AI could not resolve the conflict', { description: result.message });
        } finally {
          useAiResolves.setState((s) => {
            if (s[key] !== requestId) return s;
            const { [key]: _done, ...rest } = s;
            return rest;
          }, true);
        }
      },

      abort: async () => {
        const result = await git.abortOperation(projectId);
        if (result.ok) toast.success(result.message);
        else toast.error('Could not abort', { description: result.message });
      },

      commit: async (message, push) => {
        const before = queryClient.getQueryData<WorkspaceGitState>(
          queryKeys.gitWorkspaceState(projectId),
        );
        const publishing = push && Boolean(before?.branch && !before.upstream);
        const result = await git.commitStaged(projectId, message, push);
        if (!result.ok) {
          toast.error(push ? 'Commit and push failed' : 'Commit failed', {
            description: result.message,
          });
          return false;
        }
        if (publishing) {
          announcePublishedBranch(
            queryClient,
            projectId,
            before?.branch,
            'Committed and published',
          );
          return true;
        }
        const firstLine = message.split('\n')[0];
        toast.success(push ? 'Committed and pushed' : 'Committed', { description: firstLine });
        return true;
      },

      stash: async (mode, message) => {
        const result = await git.stashPush({
          projectId,
          includeUntracked: mode === 'all',
          keepIndex: mode === 'keep-staged',
          message,
        });
        if (result.ok) {
          toast.success('Stashed the changes', { description: result.message });
          void queryClient.invalidateQueries({ queryKey: queryKeys.gitStashList(projectId) });
        } else {
          toast.error('Could not stash', { description: result.message });
        }
      },

      stashRestore: async (action, ref) => {
        const result =
          action === 'pop'
            ? await git.stashPop(projectId, ref)
            : await git.stashApply(projectId, ref);
        if (result.ok) {
          toast.success(result.message);
          void queryClient.invalidateQueries({ queryKey: queryKeys.gitStashList(projectId) });
        } else {
          toast.error(action === 'pop' ? 'Could not pop the stash' : 'Could not apply the stash', {
            description: result.message,
          });
        }
      },

      stashDrop: async (ref) => {
        const ok = ref;
        if (!ok) return;
        const result = await git.stashDrop(projectId, ref);
        if (result.ok) {
          toast.success(result.message);
          void queryClient.invalidateQueries({ queryKey: queryKeys.gitStashList(projectId) });
        } else {
          toast.error('Could not drop the stash', { description: result.message });
        }
      },
    };
  }, [projectId, queryClient]);
}
