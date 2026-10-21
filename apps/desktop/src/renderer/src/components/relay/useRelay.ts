import type { Project } from '@agentmat/core';
import type {
  RelayBoard,
  RelayContextEvent,
  RelayRunView,
  RelayStartInput,
} from '@shared/relayTypes';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { queryKeys } from '@/lib/queryKeys';
import { launchPromptTab } from '@/lib/workspace/launch';
import { confirmDialog } from '@/stores/confirmStore';
import { choiceLabel, runArgsFor } from './relayView';

/** A relay that has finished or was cancelled no longer counts as the project's active one. */
function isLive(run: RelayRunView): boolean {
  return run.status === 'running' || run.status === 'paused' || run.status === 'waiting';
}

function applyRun(queryClient: QueryClient, run: RelayRunView): void {
  queryClient.setQueryData<RelayBoard>(queryKeys.relayBoard(run.projectId), (board) =>
    board ? { ...board, active: isLive(run) ? run : null } : board,
  );
}

/**
 * A project's board, kept live while something shows it: main watches the task folder only
 * between watch and unwatch, and says what changed on onChanged and onRun.
 */
export function useRelayBoard(projectId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.relayBoard(projectId ?? ''),
    queryFn: () => window.agentmat.relay.board(projectId as string),
    enabled: Boolean(projectId),
  });

  useEffect(() => {
    if (!projectId) return;
    void window.agentmat.relay.watch(projectId);
    const offChanged = window.agentmat.relay.onChanged((event) => {
      if (event.projectId !== projectId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      if (event.reason === 'files') {
        void queryClient.invalidateQueries({ queryKey: ['relay', 'task', projectId] });
      }
    });
    const offRun = window.agentmat.relay.onRun((run) => {
      if (run.projectId === projectId) applyRun(queryClient, run);
    });
    return () => {
      offChanged();
      offRun();
      void window.agentmat.relay.unwatch(projectId);
    };
  }, [projectId, queryClient]);

  return query;
}

interface ContextState {
  byTab: Record<string, RelayContextEvent>;
}

/** The latest context reading per leg tab, for the fuel ring and the status bar. */
export const useRelayContextStore = create<ContextState>(() => ({ byTab: {} }));

/** Feeds `relay.onContext` into the store. Safe to mount more than once: writes are idempotent. */
export function useRelayContextFeed(): void {
  useEffect(
    () =>
      window.agentmat.relay.onContext((event) =>
        useRelayContextStore.setState((state) => ({
          byTab: { ...state.byTab, [event.tabId]: event },
        })),
      ),
    [],
  );
}

export function useRelayContext(tabId: string | null | undefined): RelayContextEvent | null {
  return useRelayContextStore((state) => (tabId ? (state.byTab[tabId] ?? null) : null));
}

function failed(action: string) {
  return (error: unknown): void => {
    toast.error(`Could not ${action}`, {
      description: error instanceof Error ? error.message : String(error),
    });
  };
}

/** Starting and steering relays, with the questions and messages around each. */
export function useRelayActions() {
  const queryClient = useQueryClient();

  const start = useCallback(
    async (input: RelayStartInput): Promise<boolean> => {
      try {
        const result = await window.agentmat.relay.start(input);
        if (!result.ok) {
          toast.error('The relay did not start', { description: result.error });
          return false;
        }
        applyRun(queryClient, result.run);
        toast.success(
          result.run.status === 'waiting'
            ? `Relay scheduled. ${result.run.triggerText}.`
            : 'Relay started',
        );
        return true;
      } catch (error) {
        failed('start the relay')(error);
        return false;
      }
    },
    [queryClient],
  );

  const pause = useCallback(
    (run: RelayRunView) => window.agentmat.relay.pause(run.id).catch(failed('pause the relay')),
    [],
  );
  const resume = useCallback(
    (run: RelayRunView) => window.agentmat.relay.resume(run.id).catch(failed('resume the relay')),
    [],
  );
  const cancel = useCallback(async (run: RelayRunView) => {
    const ok = await confirmDialog({
      title: 'Stop this relay?',
      description:
        'No new session starts after this. A session that is running keeps its tab, and no task file changes.',
      confirmLabel: 'Stop relay',
      variant: 'destructive',
    });
    if (ok) await window.agentmat.relay.cancel(run.id).catch(failed('stop the relay'));
  }, []);
  const markDone = useCallback(
    (run: RelayRunView, taskId: string) =>
      window.agentmat.relay.markDone(run.id, taskId).catch(failed('mark the task done')),
    [],
  );

  return { start, pause, resume, cancel, markDone };
}

/**
 * One task in a new session, by hand: the prompt is pasted into the CLI and left for the user to
 * read and send, the way every other hand-off in the app works.
 */
export async function runTaskInNewSession(project: Project, taskId: string): Promise<boolean> {
  try {
    const run = await window.agentmat.relay.prepareRun(project.id, taskId);
    const tabId = launchPromptTab(project, {
      cliId: run.choice.cliId,
      prompt: run.prompt,
      runArgs: runArgsFor(run.choice, run.planFirst),
      runLabel: `${taskId} · ${choiceLabel(run.choice)}`,
    });
    return tabId !== null;
  } catch (error) {
    failed(`start ${taskId}`)(error);
    return false;
  }
}
