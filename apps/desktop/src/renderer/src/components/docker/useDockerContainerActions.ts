import type { DockerContainer, DockerRemoveOptions } from '@shared/apiTypes';
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/stores/confirmStore';

type LifecycleAction = 'start' | 'stop' | 'restart';

const LIFECYCLE_VERB: Record<LifecycleAction, string> = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
const LIFECYCLE_PAST: Record<LifecycleAction, string> = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
};

function runLifecycleAction(
  id: string,
  action: LifecycleAction,
): ReturnType<typeof window.runova.docker.start> {
  if (action === 'start') return window.runova.docker.start(id);
  if (action === 'stop') return window.runova.docker.stop(id);
  return window.runova.docker.restart(id);
}

/**
 * Start/stop/restart/remove wiring shared by the machine-wide Docker page and a project's Docker
 * tab. Both call the same IPC methods and need the same pending/dialog state, so this is the one
 * place that logic lives rather than being copied twice. Pending state is a set, not a single id,
 * because a group action (e.g. "Stop all" for one compose project) puts several rows in flight at
 * once.
 */
export function useDockerContainerActions(queryKey: QueryKey): {
  pendingIds: Set<string>;
  removeTarget: DockerContainer | null;
  removing: boolean;
  openRemoveDialog: (container: DockerContainer) => void;
  closeRemoveDialog: () => void;
  start: (id: string) => void;
  /** Confirms before stopping: a running container may be serving something someone is using. */
  stop: (container: DockerContainer) => void;
  restart: (id: string) => void;
  /** Confirms before stopping every container passed in. */
  stopMany: (containers: DockerContainer[], groupLabel?: string) => void;
  confirmRemove: (options: DockerRemoveOptions) => void;
} {
  const queryClient = useQueryClient();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<DockerContainer | null>(null);

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey });
  }

  function addPending(ids: string[]): void {
    setPendingIds((prev) => new Set([...prev, ...ids]));
  }

  function removePending(ids: string[]): void {
    setPendingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  const lifecycleMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: LifecycleAction }) =>
      runLifecycleAction(id, action),
    onMutate: ({ id }) => addPending([id]),
    onSuccess: (result) => {
      if (!result.ok) toast.error(result.error ?? 'That action failed.');
    },
    onError: () => toast.error('That action failed.'),
    onSettled: (_result, _error, { id }) => {
      removePending([id]);
      invalidate();
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async ({ ids, action }: { ids: string[]; action: LifecycleAction }) =>
      Promise.all(ids.map((id) => runLifecycleAction(id, action))),
    onMutate: ({ ids }) => addPending(ids),
    onSuccess: (results, { action }) => {
      const failed = results.filter((result) => !result.ok).length;
      if (failed === 0) {
        toast.success(
          `${LIFECYCLE_PAST[action]} ${results.length} container${results.length === 1 ? '' : 's'}.`,
        );
      } else {
        toast.error(
          `${failed} of ${results.length} containers failed to ${LIFECYCLE_VERB[action]}.`,
        );
      }
    },
    onError: () => toast.error('That action failed.'),
    onSettled: (_result, _error, { ids }) => {
      removePending(ids);
      invalidate();
    },
  });

  const removeMutation = useMutation({
    mutationFn: ({ id, options }: { id: string; options: DockerRemoveOptions }) =>
      window.runova.docker.remove(id, options),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success('Container removed.');
        setRemoveTarget(null);
      } else {
        toast.error(result.error ?? 'Could not remove the container.');
      }
    },
    onError: () => toast.error('Could not remove the container.'),
    onSettled: () => invalidate(),
  });

  return {
    pendingIds:
      removeMutation.isPending && removeTarget
        ? new Set([...pendingIds, removeTarget.id])
        : pendingIds,
    removeTarget,
    removing: removeMutation.isPending,
    openRemoveDialog: (container) => setRemoveTarget(container),
    closeRemoveDialog: () => {
      if (!removeMutation.isPending) setRemoveTarget(null);
    },
    start: (id) => lifecycleMutation.mutate({ id, action: 'start' }),
    stop: (container) => {
      void confirmDialog({
        title: `Stop ${container.name}?`,
        description: 'You can start it again any time.',
        confirmLabel: 'Stop',
        variant: 'destructive',
      }).then((confirmed) => {
        if (confirmed) lifecycleMutation.mutate({ id: container.id, action: 'stop' });
      });
    },
    restart: (id) => lifecycleMutation.mutate({ id, action: 'restart' }),
    stopMany: (containers, groupLabel) => {
      if (containers.length === 0) return;
      void confirmDialog({
        title: groupLabel
          ? `Stop all ${containers.length} containers in ${groupLabel}?`
          : `Stop all ${containers.length} containers?`,
        description: 'You can start them again any time.',
        confirmLabel: 'Stop all',
        variant: 'destructive',
      }).then((confirmed) => {
        if (confirmed) bulkMutation.mutate({ ids: containers.map((c) => c.id), action: 'stop' });
      });
    },
    confirmRemove: (options) => {
      if (!removeTarget) return;
      removeMutation.mutate({ id: removeTarget.id, options });
    },
  };
}
