import { formatTokenCount, type Project, type RelayTaskStatus } from '@agentmat/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { RelayBoard as Board } from '@shared/relayTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FolderKanban, Sliders, Wand2, X } from '@/components/icons';
import { CatalogCardShimmer, EmptyState, LoadFailure } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { RelayLiveStrip } from './RelayLiveStrip';
import { RelayRunSettings } from './RelayRunSettings';
import { CARD_DRAG_TYPE, type CardMove, RelayTaskCard } from './RelayTaskCard';
import { RelayTaskDetail } from './RelayTaskDetail';
import { ReviseWithAiDialog } from './ReviseWithAiDialog';
import { RunRelayButton } from './RunRelayButton';
import { boardColumns, epicHue, neighbourStatus, relaySummary, withColumnOrder } from './relayView';
import { useRelayActions, useRelayBoard, useRelayContextFeed } from './useRelay';

/** Moves cards: the status change and the new order, shown at once and then written to the files. */
function useBoardMoves(projectId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.relayBoard(projectId);

  return async function move(
    taskId: string,
    status: RelayTaskStatus,
    sequence: string[] | null,
  ): Promise<void> {
    const board = queryClient.getQueryData<Board>(key);
    const task = board?.tasks.find((entry) => entry.id === taskId);
    if (!board || !task) return;
    queryClient.setQueryData<Board>(key, {
      ...board,
      tasks: board.tasks.map((entry) => (entry.id === taskId ? { ...entry, status } : entry)),
      order: sequence ? withColumnOrder(board.order, sequence) : board.order,
    });
    try {
      if (task.status !== status) await window.agentmat.relay.setStatus(projectId, taskId, status);
      if (sequence) await window.agentmat.relay.reorder(projectId, sequence);
    } catch (error) {
      toast.error(`Could not move ${taskId}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function focusCard(taskId: string): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>(`[data-card="${taskId}"] button`)?.focus(),
  );
}

function BoardColumns({
  board,
  epic,
  selected,
  onSelect,
}: {
  board: Board;
  epic: string | null;
  selected: string | null;
  onSelect: (taskId: string) => void;
}): React.JSX.Element {
  const move = useBoardMoves(board.projectId);
  const [over, setOver] = useState<RelayTaskStatus | null>(null);
  const columns = boardColumns(board.tasks, board.order);
  const visible = (status: RelayTaskStatus) =>
    columns
      .find((column) => column.status === status)
      ?.tasks.filter((task) => epic === null || task.epic === epic) ?? [];

  function onCardMove(taskId: string, status: RelayTaskStatus, change: CardMove): void {
    if (change.kind === 'column') {
      const next = neighbourStatus(status, change.step);
      if (!next) return;
      void move(taskId, next, null);
      focusCard(taskId);
      return;
    }
    const ids = (columns.find((column) => column.status === status)?.tasks ?? []).map(
      (task) => task.id,
    );
    const from = ids.indexOf(taskId);
    const to = from + change.step;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void move(taskId, status, ids);
    focusCard(taskId);
  }

  function dropInto(status: RelayTaskStatus, taskId: string, beforeId: string | null): void {
    const ids = (columns.find((column) => column.status === status)?.tasks ?? [])
      .map((task) => task.id)
      .filter((id) => id !== taskId);
    const at = beforeId ? ids.indexOf(beforeId) : -1;
    ids.splice(at === -1 ? ids.length : at, 0, taskId);
    void move(taskId, status, beforeId ? ids : null);
  }

  return (
    <LayoutGroup>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
        {columns.map((column) => {
          const tasks = visible(column.status);
          return (
            <section
              key={column.status}
              aria-label={column.label}
              data-drop-target={over === column.status ? '' : undefined}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(CARD_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setOver(column.status);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setOver(null);
              }}
              onDrop={(event) => {
                const id = event.dataTransfer.getData(CARD_DRAG_TYPE);
                setOver(null);
                if (!id) return;
                event.preventDefault();
                dropInto(column.status, id, null);
              }}
              className={cn(
                'flex w-[17.5rem] min-w-[15rem] shrink-0 flex-col rounded-2xl border bg-foreground/[0.025] transition-colors',
                over === column.status ? 'border-primary/50 bg-primary/[0.05]' : 'border-border/50',
              )}
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: `hsl(${column.tone})`,
                    boxShadow: `0 0 10px hsl(${column.tone} / 0.7)`,
                  }}
                />
                <SimpleTooltip label={column.hint}>
                  <h3 className="text-[12px] font-semibold tracking-wide">{column.label}</h3>
                </SimpleTooltip>
                <span className="ml-auto rounded-full bg-foreground/[0.06] px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                  {tasks.length}
                </span>
              </header>
              <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {tasks.map((task) => (
                  <RelayTaskCard
                    key={task.id}
                    card={task}
                    settings={board.settings}
                    run={board.active}
                    selected={selected === task.id}
                    onOpen={() => onSelect(task.id)}
                    onMove={(change) => onCardMove(task.id, column.status, change)}
                    onDropBefore={(id) => dropInto(column.status, id, task.id)}
                  />
                ))}
                {tasks.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {column.hint}
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function BoardSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading the board" className="flex flex-1 gap-3">
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="w-[17.5rem] shrink-0 space-y-2 rounded-2xl border border-border/50 p-2"
        >
          <CatalogCardShimmer />
          {index < 2 ? <CatalogCardShimmer /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The glass board: a project's Relay tasks in five columns, live as sessions move them. Cards
 * drag between columns (or Alt+Arrow), and opening one shows its baton, sessions and spec.
 */
export function RelayBoard({
  projectId,
  focusTaskId,
}: {
  projectId: string;
  focusTaskId: string | null;
}): React.JSX.Element {
  const query = useRelayBoard(projectId);
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  const project: Project | null = projects.data?.find((entry) => entry.id === projectId) ?? null;
  const { markDone } = useRelayActions();
  const move = useBoardMoves(projectId);
  const [selected, setSelected] = useState<string | null>(focusTaskId);
  const [epic, setEpic] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);

  useEffect(() => setSelected(focusTaskId), [focusTaskId]);

  const board = query.data;
  const epics = useMemo(
    () =>
      [...new Set((board?.tasks ?? []).flatMap((task) => (task.epic ? [task.epic] : [])))].sort(),
    [board],
  );
  const summary = board ? relaySummary(board) : null;
  const selectedTask = board?.tasks.find((task) => task.id === selected) ? selected : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-primary uppercase">
            <FolderKanban aria-hidden className="h-3 w-3" /> Relay board
          </p>
          <DialogPrimitive.Title className="truncate text-lg font-semibold">
            {project?.name ?? 'Tasks'}
          </DialogPrimitive.Title>
          {summary ? (
            <DialogPrimitive.Description className="text-[12px] text-muted-foreground tabular-nums">
              {summary.done} of {summary.total} done
              {summary.estimateLeft > 0
                ? ` · about ${formatTokenCount(summary.estimateLeft)} tokens of work left`
                : ''}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">
              The project's Relay tasks
            </DialogPrimitive.Description>
          )}
        </div>

        {epics.length > 0 ? (
          <div
            role="group"
            aria-label="Filter by epic"
            className="flex flex-wrap items-center gap-1"
          >
            <button
              type="button"
              aria-pressed={epic === null}
              onClick={() => setEpic(null)}
              className={cn(
                'cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors',
                epic === null
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.05]',
              )}
            >
              All
            </button>
            {epics.map((name) => {
              const hue = epicHue(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={epic === name}
                  onClick={() => setEpic(epic === name ? null : name)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors',
                    epic === name
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/[0.05]',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: `hsl(${hue} 70% 55%)` }}
                  />
                  {name}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {board?.active ? (
            <div className="w-80">
              <RelayLiveStrip run={board.active} compact />
            </div>
          ) : board ? (
            <RunRelayButton board={board} />
          ) : null}
          {board ? (
            <RelayRunSettings projectId={projectId} project={project} settings={board.settings}>
              <Button type="button" variant="soft" size="sm">
                <Sliders /> Run settings
              </Button>
            </RelayRunSettings>
          ) : null}
          <SimpleTooltip label="Compare the tasks with the docs and propose changes">
            <Button type="button" variant="soft" size="sm" onClick={() => setRevising(true)}>
              <Wand2 /> Revise with AI
            </Button>
          </SimpleTooltip>
          <DialogPrimitive.Close asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close the board">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3">
        {query.isPending ? (
          <BoardSkeleton />
        ) : query.isError || !board ? (
          <div className="flex-1">
            <LoadFailure
              message="The board could not be read."
              retry={() => void query.refetch()}
            />
          </div>
        ) : board.tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={FolderKanban}
              title="No tasks on this board yet"
              description={
                <p>
                  Turn on "Split into Relay tasks" in Blueprint, use "Split into tasks" in Build
                  Prompt, or write task files in{' '}
                  <span className="font-mono">{board.docsFolder}/tasks/</span>.
                </p>
              }
            />
          </div>
        ) : (
          <BoardColumns board={board} epic={epic} selected={selectedTask} onSelect={setSelected} />
        )}
        {board && selectedTask ? (
          <RelayTaskDetail
            board={board}
            project={project}
            taskId={selectedTask}
            onClose={() => setSelected(null)}
            onSetStatus={(status) => void move(selectedTask, status, null)}
            onMarkDone={
              board.active?.current?.taskId === selectedTask
                ? () => board.active && void markDone(board.active, selectedTask)
                : undefined
            }
          />
        ) : null}
      </div>

      <ReviseWithAiDialog projectId={projectId} open={revising} onOpenChange={setRevising} />
    </div>
  );
}

/** The board's one home: a full-window glass overlay, mounted once, opened through the store. */
export function RelayBoardHost(): React.JSX.Element {
  useRelayContextFeed();
  const projectId = useRelayBoardStore((s) => s.projectId);
  const focusTaskId = useRelayBoardStore((s) => s.focusTaskId);
  const close = useRelayBoardStore((s) => s.close);
  return (
    <DialogPrimitive.Root open={projectId !== null} onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          // The board itself takes focus, not its first button, so that button's tooltip stays shut
          // and one Escape closes the board.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          tabIndex={-1}
          className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-[22px] border border-white/10 bg-popover/75 text-popover-foreground shadow-2xl shadow-black/30 backdrop-blur-2xl outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] dark:border-white/[0.07]"
        >
          {projectId ? <RelayBoard projectId={projectId} focusTaskId={focusTaskId} /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
