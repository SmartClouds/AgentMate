import {
  type AwaitReason,
  type EffortLevel,
  getCliDefinition,
  type LegPhase,
  launchPickArgs,
  launchPickLabel,
  type RelayRunChoice,
  type RelayTaskStatus,
  relayPlanArgs,
} from '@runova/core';
import type { RelayBoard, RelayProjectSettings, RelayTaskCard } from '@shared/relayTypes';

/**
 * Words, colors and groupings the Relay views share. Kept out of the components so the rules
 * (which column a task sits in, what a station on the track shows) are tested on their own.
 */

export interface BoardColumnSpec {
  status: RelayTaskStatus;
  label: string;
  /** What the column means, for its tooltip and an empty column. */
  hint: string;
  /** The column's accent, an HSL triple that reads in light and dark. */
  tone: string;
}

export const BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  { status: 'todo', label: 'To do', hint: 'Waiting for a session.', tone: '220 9% 55%' },
  {
    status: 'in-progress',
    label: 'In progress',
    hint: 'A session is working on these, or one stopped partway.',
    tone: '199 89% 52%',
  },
  {
    status: 'testing',
    label: 'Testing',
    hint: 'Done by the agent, but its tests fail.',
    tone: '38 92% 52%',
  },
  { status: 'done', label: 'Done', hint: 'Finished, tests passing.', tone: '152 60% 44%' },
  {
    status: 'blocked',
    label: 'Blocked',
    hint: 'The agent needs your answer. Its handoff has the question.',
    tone: '350 80% 58%',
  },
];

export function columnSpec(status: RelayTaskStatus): BoardColumnSpec {
  return BOARD_COLUMNS.find((column) => column.status === status) ?? BOARD_COLUMNS[0];
}

/** Tasks per column, each column in run order; tasks the order leaves out (a cycle) come last. */
export function boardColumns(
  tasks: readonly RelayTaskCard[],
  order: readonly string[],
): (BoardColumnSpec & { tasks: RelayTaskCard[] })[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const sorted = [...tasks].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  return BOARD_COLUMNS.map((column) => ({
    ...column,
    tasks: sorted.filter((task) => task.status === column.status),
  }));
}

/** The column to the left or right, for Alt+Arrow, or null past either end. */
export function neighbourStatus(status: RelayTaskStatus, step: -1 | 1): RelayTaskStatus | null {
  const index = BOARD_COLUMNS.findIndex((column) => column.status === status);
  return BOARD_COLUMNS[index + step]?.status ?? null;
}

/** A steady hue per epic, so its cards share a stripe. Null for a task with no epic. */
export function epicHue(epic: string | null): number | null {
  if (!epic) return null;
  let hash = 0;
  for (const char of epic) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // Golden-angle steps spread consecutive epics (E01, E02) far apart on the wheel.
  return Math.round((hash * 137.508) % 360);
}

/** A task's run choice: the project's defaults with the task's own override on top. */
export function choiceFor(settings: RelayProjectSettings, taskId: string): RelayRunChoice {
  const { planFirst: _planFirst, ...override } = settings.overrides[taskId] ?? {};
  return { ...settings.defaults, ...override };
}

export function planFirstFor(settings: RelayProjectSettings, taskId: string): boolean {
  return settings.overrides[taskId]?.planFirst ?? settings.options.planFirst;
}

export function cliName(cliId: string): string {
  return getCliDefinition(cliId)?.name ?? cliId;
}

/** "Opus 5.5 · High", the CLI's name when no model is set, or "Auto" when it is sized per task. */
export function choiceLabel(choice: RelayRunChoice): string {
  if (choice.autoSize) return 'Auto';
  if (!choice.model) return cliName(choice.cliId);
  return (
    launchPickLabel(choice.cliId, {
      model: choice.model,
      effort: (choice.effort ?? undefined) as EffortLevel | undefined,
    }) ?? choice.model
  );
}

/** The flags a single "Run in new session" starts the CLI with. */
export function runArgsFor(choice: RelayRunChoice, planFirst: boolean): string[] {
  const pick = choice.model
    ? launchPickArgs(choice.cliId, {
        model: choice.model,
        effort: (choice.effort ?? undefined) as EffortLevel | undefined,
      })
    : [];
  const plan = planFirst ? (relayPlanArgs(choice.cliId) ?? []) : [];
  return [...pick, ...plan];
}

export type StationState = 'done' | 'running' | 'waiting' | 'queued' | 'blocked' | 'idle';

export interface TrackStation {
  task: RelayTaskCard;
  state: StationState;
  /** Sessions run on the task so far, drawn as notches. */
  legs: number;
}

/** The relay track, top to bottom in run order: what each station shows. */
export function trackStations(board: RelayBoard): TrackStation[] {
  const tasks = [...board.tasks].sort(
    (a, b) =>
      byOrderIndex(board.order, a.id) - byOrderIndex(board.order, b.id) ||
      a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  const active = board.active;
  const live =
    active && (active.status === 'running' || active.status === 'paused') ? active : null;
  const queued = new Set(live?.queue ?? (active?.status === 'waiting' ? active.queue : []));
  return tasks.map((task) => {
    let state: StationState = 'idle';
    if (task.status === 'done') state = 'done';
    else if (live?.current?.taskId === task.id) {
      state = live.current.phase === 'awaiting-user' ? 'waiting' : 'running';
    } else if (task.status === 'blocked') state = 'blocked';
    else if (queued.has(task.id)) state = 'queued';
    return { task, state, legs: task.legCount };
  });
}

function byOrderIndex(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export interface RelaySummary {
  done: number;
  total: number;
  /** Planner estimates of the tasks not done yet, added up. */
  estimateLeft: number;
  /** Tasks not done that have no estimate, so the total is a floor. */
  unestimated: number;
}

export function relaySummary(board: RelayBoard): RelaySummary {
  let done = 0;
  let estimateLeft = 0;
  let unestimated = 0;
  for (const task of board.tasks) {
    if (task.status === 'done') {
      done += 1;
      continue;
    }
    if (task.estimate === null) unestimated += 1;
    else estimateLeft += task.estimate;
  }
  return { done, total: board.tasks.length, estimateLeft, unestimated };
}

const AWAIT_LABELS: Record<AwaitReason, string> = {
  'needs-input': 'Waiting for you',
  question: 'Asked you a question',
  'plan-review': 'Plan ready for review',
  'stale-handoff': 'Stopped without a handoff',
  'bad-handoff': 'Handoff unreadable',
  'no-progress': 'Not moving',
  'leg-cap': 'Out of sessions',
  'not-started': 'Not started yet',
};

const PHASE_LABELS: Record<LegPhase, string> = {
  sizing: 'Choosing a model',
  launching: 'Starting',
  planning: 'Planning',
  executing: 'Working',
  finishing: 'Finishing',
  'awaiting-user': 'Waiting for you',
  interrupted: 'Interrupted',
  failed: 'Failed',
  done: 'Done',
};

export function legPhaseLabel(
  phase: LegPhase,
  awaiting: { reason: AwaitReason; message: string } | null,
): string {
  if (phase === 'awaiting-user' && awaiting) return AWAIT_LABELS[awaiting.reason];
  return PHASE_LABELS[phase];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The board's order after one column was rearranged: the column's tasks take the places they
 * held, in their new sequence, and every other task keeps its place. A task new to the order
 * (moved in from a cycle) lands where the column's first task is.
 */
export function withColumnOrder(order: readonly string[], column: readonly string[]): string[] {
  const inColumn = new Set(column);
  const known = new Set(order);
  const queue = [...column];
  const result: string[] = [];
  for (const id of order) {
    if (!inColumn.has(id)) {
      result.push(id);
      continue;
    }
    while (queue.length > 0 && !known.has(queue[0])) result.push(queue.shift() as string);
    if (queue.length > 0) result.push(queue.shift() as string);
  }
  return [...result, ...queue];
}
