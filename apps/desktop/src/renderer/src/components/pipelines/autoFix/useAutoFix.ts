import type { AutoFixSession, AutoFixStartInput } from '@shared/ciAutoFixTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const NO_SESSIONS: AutoFixSession[] = [];

/** Every auto-fix session, newest first. Main pushes each change, so nothing polls. */
export function useAutoFixSessions(): { sessions: AutoFixSession[]; loaded: boolean } {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.autoFixSessions,
    queryFn: () => window.runova.ciAutoFix.list(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentLoading: true },
  });

  useEffect(
    () =>
      window.runova.ciAutoFix.onChanged((sessions) => {
        queryClient.setQueryData(queryKeys.autoFixSessions, sessions);
      }),
    [queryClient],
  );

  return { sessions: query.data ?? NO_SESSIONS, loaded: query.isFetched };
}

export interface AutoFixActions {
  /** Resolves true once auto-fix is on, false when it could not start (the reason is toasted). */
  start: (input: AutoFixStartInput) => Promise<boolean>;
  stop: (id: string) => Promise<void>;
  commitNow: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

export function useAutoFixActions(): AutoFixActions {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.autoFixSessions });

  return {
    async start(input) {
      const result = await window.runova.ciAutoFix.start(input);
      if (!result.ok) {
        toast.error('Auto-fix could not start', { description: result.error });
        return false;
      }
      void refresh();
      toast.success(`Auto-fix is on for ${result.session.workflowName}`, {
        description: `If the run fails, an agent fixes it and Runova pushes the fix to ${result.session.branch}.`,
      });
      return true;
    },
    async stop(id) {
      await window.runova.ciAutoFix.stop(id);
      void refresh();
      toast('Auto-fix stopped', {
        description: 'The agent tab stays open. Nothing more is committed or pushed.',
      });
    },
    async commitNow(id) {
      await window.runova.ciAutoFix.commitNow(id);
      void refresh();
    },
    async retry(id) {
      await window.runova.ciAutoFix.retry(id);
      void refresh();
    },
    async dismiss(id) {
      await window.runova.ciAutoFix.dismiss(id);
      void refresh();
    },
  };
}

/**
 * Shows each attempt's agent as a tab of its project's workspace. Main starts the session itself,
 * so the fix runs whatever the user is looking at; the tab only attaches to it. Mounted once, in
 * the workspace host, which lives as long as the window.
 */
export function useAutoFixTabs(): void {
  useEffect(
    () =>
      window.runova.ciAutoFix.onTab((event) => {
        useWorkspaceStore.getState().addRelayLegTab(event.projectId, {
          id: event.tabId,
          title: event.title,
          cliId: event.cliId,
          cwd: event.cwd,
          runLabel: event.runLabel,
        });
      }),
    [],
  );
}
