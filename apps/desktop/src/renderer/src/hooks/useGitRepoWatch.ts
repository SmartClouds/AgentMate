import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/** Two focus events in a row (a click that raises the window, then a field focus) mean one refresh. */
const FOCUS_THROTTLE_MS = 2000;

/**
 * Keeps a project's git queries in step with the repo on disk.
 *
 * Main watches `.git` and tells us when it moves, which covers commits, checkouts, merges
 * and pulls made in another app. Plain edits to a file don't touch `.git`, so a window
 * focus refreshes as well: the user has just come back from wherever they made them.
 */
export function useGitRepoWatch(projectId: string, isRepo: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    function refresh(): void {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitTags(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitFiles(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitBranchHistories(projectId) });
    }

    // Folders that aren't a repo yet have no `.git` to watch. Once one is initialized the
    // status query flips and this effect runs again.
    if (isRepo) void window.runova.git.watchRepo(projectId);
    const stopListening = window.runova.git.onRepoChanged((changedProjectId) => {
      if (changedProjectId === projectId) refresh();
    });

    let lastFocusRefresh = 0;
    function handleFocus(): void {
      const now = Date.now();
      if (now - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
      lastFocusRefresh = now;
      refresh();
    }
    window.addEventListener('focus', handleFocus);

    return () => {
      stopListening();
      window.removeEventListener('focus', handleFocus);
      if (isRepo) void window.runova.git.unwatchRepo(projectId);
    };
  }, [projectId, isRepo, queryClient]);
}
