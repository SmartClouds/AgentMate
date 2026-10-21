import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { FolderKanban, ListTodo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { useRelayBoardStore } from '@/stores/relayBoardStore';

/**
 * Once the Product Manager agent has written Relay task files, the Blueprint tab says so and
 * opens the board. Watching the folder while the tab is open makes it appear the moment the
 * agent writes the first task.
 */
export function BlueprintRelayBanner({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element | null {
  const boardQuery = useQuery({
    queryKey: queryKeys.relayBoard(projectId),
    queryFn: () => window.agentmat.relay.board(projectId),
    meta: { silentLoading: true },
  });

  useEffect(() => {
    void Promise.resolve(window.agentmat.relay.watch(projectId)).catch(() => undefined);
    return () => {
      void Promise.resolve(window.agentmat.relay.unwatch(projectId)).catch(() => undefined);
    };
  }, [projectId]);

  const tasks = boardQuery.data?.tasks ?? [];
  if (tasks.length === 0) return null;
  const done = tasks.filter((task) => task.status === 'done').length;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[calc(var(--radius)+2px)] bg-primary/[0.07] px-4 py-2.5 ring-1 ring-primary/25 ring-inset">
      <ListTodo aria-hidden className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Tasks ready</p>
        <p className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} on the Relay board, {done} done.
        </p>
      </div>
      <Button
        type="button"
        variant="tint"
        size="sm"
        onClick={() => useRelayBoardStore.getState().open(projectId)}
      >
        <FolderKanban /> Open board
      </Button>
    </div>
  );
}
