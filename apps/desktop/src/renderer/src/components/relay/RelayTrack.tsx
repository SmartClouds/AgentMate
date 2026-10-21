import { budgetLevel, formatTokenCount, type Project } from '@agentmat/core';
import type { RelayBoard, RelayRunView } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Check,
  EllipsisVertical,
  FolderKanban,
  ListTodo,
  Play,
  Route,
  Sliders,
  TriangleAlert,
} from '@/components/icons';
import { EmptyState, LoadFailure } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { FuelRing } from './FuelRing';
import { RelayLiveStrip } from './RelayLiveStrip';
import { RelayRunSettings } from './RelayRunSettings';
import { RunRelayButton } from './RunRelayButton';
import {
  choiceFor,
  choiceLabel,
  columnSpec,
  epicHue,
  relaySummary,
  type TrackStation,
  trackStations,
} from './relayView';
import {
  runTaskInNewSession,
  useRelayActions,
  useRelayBoard,
  useRelayContext,
  useRelayContextFeed,
} from './useRelay';

/** Notches drawn on the rail above a station, one per earlier session, up to this many. */
const MAX_NOTCHES = 5;

function StationNode({
  station,
  run,
}: {
  station: TrackStation;
  run: RelayRunView | null;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const leg = run?.current?.taskId === station.task.id ? run.current : null;
  const context = useRelayContext(leg?.tabId);

  if (leg && (station.state === 'running' || station.state === 'waiting')) {
    const used = context?.tokens ?? leg.contextTokens;
    return (
      <span className="relative flex h-7 w-7 items-center justify-center">
        {station.state === 'running' && !reduceMotion ? (
          <span
            aria-hidden
            className="relay-station-glow absolute inset-0 rounded-full bg-primary/25 blur-[3px]"
          />
        ) : null}
        <FuelRing
          used={used}
          budget={leg.budget}
          guardAt={context?.guardAt ?? leg.guardAt}
          size={28}
        >
          <span
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              station.state === 'waiting'
                ? 'bg-amber-500'
                : 'bg-primary shadow-[0_0_10px_hsl(var(--primary))]',
            )}
          />
        </FuelRing>
      </span>
    );
  }
  if (station.state === 'done') {
    return (
      <span className="flex h-7 w-7 items-center justify-center">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Check aria-hidden className="h-2.5 w-2.5" />
        </span>
      </span>
    );
  }
  const tone = columnSpec(station.task.status).tone;
  return (
    <span className="flex h-7 w-7 items-center justify-center">
      <span
        aria-hidden
        className={cn(
          'h-3 w-3 rounded-full border-2 bg-background',
          station.state === 'queued' && 'border-primary',
        )}
        style={station.state === 'queued' ? undefined : { borderColor: `hsl(${tone})` }}
      />
    </span>
  );
}

const STATE_WORDS: Record<TrackStation['state'], string> = {
  done: 'Done',
  running: 'Running now',
  waiting: 'Waiting for you',
  queued: 'Up next in the relay',
  blocked: 'Blocked',
  idle: 'Not in a relay',
};

function Station({
  station,
  board,
  project,
  last,
}: {
  station: TrackStation;
  board: RelayBoard;
  project: Project;
  last: boolean;
}): React.JSX.Element {
  const { start } = useRelayActions();
  const openBoard = useRelayBoardStore((s) => s.open);
  const { task } = station;
  const run = board.active;
  const budget = task.budget ?? board.settings.options.defaultBudget;
  const level = budgetLevel(task.estimate, budget);
  const override = board.settings.overrides[task.id];
  const hue = epicHue(task.epic);
  const notches = Math.min(
    MAX_NOTCHES,
    Math.max(0, station.legs - (station.state === 'running' ? 1 : 0)),
  );
  const live = station.state === 'running' || station.state === 'waiting';

  return (
    <li
      aria-label={`${task.id} ${task.title}, ${STATE_WORDS[station.state]}`}
      data-state={station.state}
      className="group relative flex gap-2 pr-1"
    >
      {/* The rail: a line through every station, solid where the relay has already passed. */}
      <div className="relative flex w-7 shrink-0 justify-center">
        <span
          aria-hidden
          className={cn(
            'absolute top-0 w-px',
            last ? 'h-3.5' : 'h-full',
            station.state === 'done' ? 'bg-emerald-500/60' : 'bg-border',
          )}
        />
        {notches > 0 ? (
          <span
            aria-hidden
            className="absolute top-0 flex flex-col items-center gap-[3px] pt-[1px]"
          >
            {Array.from({ length: notches }, (_, index) => (
              <span key={index} className="h-px w-2 bg-foreground/35" />
            ))}
          </span>
        ) : null}
        <span className="relative z-10 mt-0">
          <StationNode station={station} run={run} />
        </span>
      </div>

      <div
        className={cn(
          'mb-1 min-w-0 flex-1 rounded-lg px-2 py-1 transition-colors',
          live ? 'bg-primary/[0.06]' : 'group-hover:bg-foreground/[0.04]',
        )}
      >
        <button
          type="button"
          onClick={() => openBoard(board.projectId, task.id)}
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
        >
          <span
            className="shrink-0 font-mono text-[10.5px] font-semibold tracking-tight text-muted-foreground"
            style={hue !== null ? { color: `hsl(${hue} 65% 55%)` } : undefined}
          >
            {task.id}
          </span>
          <span
            className={cn(
              'min-w-0 truncate text-[12.5px]',
              station.state === 'done' &&
                'text-muted-foreground line-through decoration-foreground/25',
            )}
          >
            {task.title}
          </span>
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span
            className={cn(
              station.state === 'waiting' && 'text-amber-600 dark:text-amber-400',
              station.state === 'blocked' && 'text-rose-600 dark:text-rose-400',
            )}
          >
            {STATE_WORDS[station.state]}
          </span>
          {task.estimate !== null ? (
            <SimpleTooltip
              label={
                level === 'over'
                  ? 'The planner thinks this needs more than one session.'
                  : level === 'tight'
                    ? 'Little room left in one session for surprises.'
                    : 'Fits one session comfortably.'
              }
            >
              <span
                className={cn(
                  'tabular-nums',
                  level === 'tight' && 'text-amber-600 dark:text-amber-400',
                  level === 'over' && 'text-rose-600 dark:text-rose-400',
                )}
              >
                ~{formatTokenCount(task.estimate)}
              </span>
            </SimpleTooltip>
          ) : null}
          {override ? (
            <span className="truncate">{choiceLabel(choiceFor(board.settings, task.id))}</span>
          ) : null}
          {task.issues.length > 0 ? (
            <SimpleTooltip label={task.issues.map((issue) => issue.message).join(' ')}>
              <TriangleAlert
                aria-label="This task file has problems"
                className="h-3 w-3 text-amber-500"
              />
            </SimpleTooltip>
          ) : null}
        </div>
        {(station.state === 'blocked' || station.state === 'waiting') && task.handoff?.next ? (
          <p className="mt-1 line-clamp-2 text-[11px] text-foreground/80">{task.handoff.next}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-start gap-0.5 pt-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <SimpleTooltip label="Run in a new session">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Run ${task.id} in a new session`}
            onClick={() => void runTaskInNewSession(project, task.id)}
          >
            <Play />
          </Button>
        </SimpleTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${task.id}`}>
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onSelect={() =>
                void start({ projectId: board.projectId, from: task.id, trigger: { kind: 'now' } })
              }
            >
              <Route /> Run the relay from here
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openBoard(board.projectId, task.id)}>
              <FolderKanban /> Open on the board
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function TrackSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading tasks" className="space-y-3 px-3 py-3">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-2.5">
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
        </div>
      ))}
    </div>
  );
}

/**
 * The workspace's Tasks tab: the project's Relay tasks as a track, top to bottom in run order.
 * Each task is a station; the one a session works on carries the baton and the fuel ring that
 * shows how much of its context budget is used.
 */
export function RelayTrack({ project }: { project: Project }): React.JSX.Element {
  useRelayContextFeed();
  const queryClient = useQueryClient();
  const query = useRelayBoard(project.id);
  const openBoard = useRelayBoardStore((s) => s.open);
  const [starting, setStarting] = useState(false);

  if (query.isPending) return <TrackSkeleton />;
  if (query.isError || !query.data) {
    return (
      <div className="p-3">
        <LoadFailure message="The tasks could not be read." retry={() => void query.refetch()} />
      </div>
    );
  }
  const board = query.data;

  if (!board.exists || board.tasks.length === 0) {
    const startBoard = async (): Promise<void> => {
      setStarting(true);
      try {
        await window.agentmat.relay.ensureGuide(project.id, board.docsFolder);
        await queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(project.id) });
        toast.success('Board started', {
          description: `${board.docsFolder}/tasks/RELAY.md explains the format to any agent.`,
        });
      } catch (error) {
        toast.error('Could not start the board', {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setStarting(false);
      }
    };
    return (
      <div className="p-3">
        <EmptyState
          size="sm"
          icon={ListTodo}
          title="No tasks yet"
          description={
            <div className="space-y-2">
              <p>
                Relay runs tasks one after another, each in a fresh agent session sized to fit its
                context budget. Every session leaves a handoff the next one starts from.
              </p>
              <p>
                Turn on "Split into Relay tasks" in Blueprint, or use "Split into tasks" in Build
                Prompt. Tasks are Markdown files in{' '}
                <span className="font-mono">{board.docsFolder}/tasks/</span>.
              </p>
            </div>
          }
          action={
            board.guidePresent ? undefined : (
              <Button
                type="button"
                variant="soft"
                size="sm"
                disabled={starting}
                onClick={() => void startBoard()}
              >
                <ListTodo /> Start a board
              </Button>
            )
          }
        />
      </div>
    );
  }

  const stations = trackStations(board);
  const summary = relaySummary(board);
  const run = board.active;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-2 px-3 pt-3 pb-2">
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
              Relay
            </p>
            <p className="text-[13px] font-semibold tabular-nums">
              {summary.done} of {summary.total} done
            </p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {summary.estimateLeft > 0
                ? `About ${formatTokenCount(summary.estimateLeft)} tokens of work left${summary.unestimated > 0 ? `, ${summary.unestimated} unsized` : ''}`
                : summary.done === summary.total
                  ? 'Every task is done.'
                  : 'No estimates yet.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <RelayRunSettings projectId={project.id} project={project} settings={board.settings}>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Run settings">
                <Sliders />
              </Button>
            </RelayRunSettings>
            <SimpleTooltip label="Open the board">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Open the board"
                onClick={() => openBoard(project.id)}
              >
                <FolderKanban />
              </Button>
            </SimpleTooltip>
          </div>
        </div>
        {run ? <RelayLiveStrip run={run} compact /> : <RunRelayButton board={board} />}
      </div>

      <ol aria-label="Relay track" className="px-2 pt-1 pb-3">
        {stations.map((station, index) => (
          <Station
            key={station.task.id}
            station={station}
            board={board}
            project={project}
            last={index === stations.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}
