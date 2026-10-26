import type { ActivityResource, ResourceRef, ResourceStopResult } from '@runova/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { StopCircle } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

/** How many names the "stop all" confirm lists before it falls back to "and N more". */
const CONFIRM_ITEMS = 8;

export interface StopSummary {
  tone: 'success' | 'error' | 'info';
  message: string;
}

function reason(message: string | undefined): string {
  return message ? `: ${message}` : '.';
}

/** One line for the toast after a stop, whatever mix of results came back. */
export function summarizeStop(results: ResourceStopResult[]): StopSummary {
  const stopped = results.filter((one) => one.ok);
  const failed = results.filter((one) => !one.ok && !one.skipped);
  const active = results.filter((one) => one.skipped === 'active');
  const gone = results.filter((one) => one.skipped === 'gone');

  if (failed.length > 0) {
    const first = failed[0] as ResourceStopResult;
    if (stopped.length > 0) {
      return {
        tone: 'error',
        message: `Stopped ${stopped.length} of ${results.length}. ${first.name} did not stop${reason(first.message)}`,
      };
    }
    return {
      tone: 'error',
      message:
        failed.length === 1
          ? `Could not stop ${first.name}${reason(first.message)}`
          : `Could not stop ${failed.length} of them${reason(first.message)}`,
    };
  }

  if (stopped.length > 0) {
    const base =
      stopped.length === 1
        ? `Stopped ${(stopped[0] as ResourceStopResult).name}.`
        : `Stopped ${stopped.length} idle items.`;
    return {
      tone: 'success',
      message:
        active.length > 0
          ? `${base} ${active.length} became active again, so ${active.length === 1 ? 'it was' : 'they were'} left running.`
          : base,
    };
  }

  if (active.length > 0) {
    return {
      tone: 'info',
      message:
        active.length === 1
          ? `${(active[0] as ResourceStopResult).name} became active again, so it was left running.`
          : `${active.length} became active again, so they were left running.`,
    };
  }
  return {
    tone: 'info',
    message: gone.length > 1 ? 'None of them are running any more.' : 'It is not running any more.',
  };
}

function refOf(resource: ActivityResource): ResourceRef {
  return { kind: resource.kind, id: resource.id };
}

/**
 * Stop buttons for the idle list. A single row stops straight away (it is already flagged idle
 * and starting it again is easy), while "stop all" confirms first and tells the main process to
 * leave out anything that became busy while the dialog was open.
 */
export function useStopIdleResources(): {
  pendingKeys: Set<string>;
  stopOne: (resource: ActivityResource) => void;
  stopAll: (resources: ActivityResource[], idleMinutes: number) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: ({
      refs,
      onlyIfIdle,
    }: {
      refs: ResourceRef[];
      onlyIfIdle: boolean;
      keys: string[];
    }) => window.runova.resourceActivity.stop(refs, { onlyIfIdle }),
    meta: { silentLoading: true },
    onMutate: ({ keys }) => setPendingKeys((prev) => new Set([...prev, ...keys])),
    onSuccess: (outcome) => {
      // The answer already has the stopped ones removed, so the list updates without a refetch.
      queryClient.setQueryData(queryKeys.resourceActivity, outcome.snapshot);
      const summary = summarizeStop(outcome.results);
      if (summary.tone === 'success') toast.success(summary.message);
      else if (summary.tone === 'error') toast.error(summary.message);
      else toast.info(summary.message);
    },
    onError: () => toast.error('Could not stop that.'),
    onSettled: (_result, _error, { keys }) => {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
      // The Docker and Android pages and the status bar show the same things.
      void queryClient.invalidateQueries({ queryKey: queryKeys.dockerList });
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidSnapshot });
    },
  });

  function stopOne(resource: ActivityResource): void {
    mutation.mutate({ refs: [refOf(resource)], onlyIfIdle: false, keys: [resource.key] });
  }

  async function stopAll(resources: ActivityResource[], idleMinutes: number): Promise<void> {
    if (resources.length === 0) return;
    const confirmed = await confirmDialog({
      title: `Stop ${resources.length} idle ${resources.length === 1 ? 'item' : 'items'}?`,
      description: `They have been quiet for at least ${idleMinutes} min. Anything on this list can be started again whenever you need it.`,
      items: resources
        .slice(0, CONFIRM_ITEMS)
        .map((one) => ({ name: one.name, detail: one.detail ?? undefined })),
      moreCount: Math.max(0, resources.length - CONFIRM_ITEMS),
      icon: StopCircle,
      confirmLabel: 'Stop all',
      variant: 'destructive',
    });
    if (!confirmed) return;
    mutation.mutate({
      refs: resources.map(refOf),
      onlyIfIdle: true,
      keys: resources.map((one) => one.key),
    });
  }

  return { pendingKeys, stopOne, stopAll };
}
