import type { RelayTask, RelayTaskStatus } from './types.js';

type OrderInput = Pick<RelayTask, 'id' | 'order' | 'depends'>;

export interface RelayOrder {
  /** Task ids in the order they can run, dependencies first. */
  ordered: string[];
  /** Groups of tasks that depend on each other in a loop, so none of them can ever start. */
  cycles: string[][];
  /** Tasks that wait, directly or not, on a cycle. */
  stuck: string[];
  /** Dependencies on ids no task has. They are treated as done so the rest can still run. */
  missing: { taskId: string; dependsOn: string }[];
}

function compareReady(a: OrderInput, b: OrderInput): number {
  const byOrder = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
  if (byOrder !== 0 && !Number.isNaN(byOrder)) return byOrder;
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

/** Strongly connected groups of more than one task, found among the tasks that never got ready. */
function findCycles(left: Map<string, OrderInput>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;

  const visit = (id: string): void => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);
    for (const dep of left.get(id)?.depends ?? []) {
      if (!left.has(dep)) continue;
      if (!index.has(dep)) {
        visit(dep);
        low.set(id, Math.min(low.get(id)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id)!, index.get(dep)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const group: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== id);
    if (group.length > 1) cycles.push(group.sort());
  };

  for (const id of [...left.keys()].sort()) if (!index.has(id)) visit(id);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Orders tasks so every task comes after what it depends on. Among the tasks that are ready
 * together, the lower `order` goes first, then the lower id.
 */
export function orderTasks(tasks: readonly OrderInput[]): RelayOrder {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const missing: RelayOrder['missing'] = [];
  const waitingOn = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    let count = 0;
    for (const dep of task.depends) {
      if (!byId.has(dep)) {
        missing.push({ taskId: task.id, dependsOn: dep });
        continue;
      }
      count += 1;
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
    }
    waitingOn.set(task.id, count);
  }

  const ready = tasks.filter((task) => waitingOn.get(task.id) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareReady);
    const task = ready.shift()!;
    ordered.push(task.id);
    for (const dependent of dependents.get(task.id) ?? []) {
      const remaining = waitingOn.get(dependent)! - 1;
      waitingOn.set(dependent, remaining);
      if (remaining === 0) ready.push(byId.get(dependent)!);
    }
  }

  const placed = new Set(ordered);
  const left = new Map(tasks.filter((task) => !placed.has(task.id)).map((task) => [task.id, task]));
  const cycles = findCycles(left);
  const inCycle = new Set(cycles.flat());
  const stuck = [...left.keys()].filter((id) => !inCycle.has(id)).sort();
  return { ordered, cycles, stuck, missing };
}

export interface RelayQueueOptions {
  /** Start at this task, skipping the ones before it in the order. */
  from?: string;
  /** Run only these tasks. A task named here runs whatever its status. */
  only?: readonly string[];
}

const SKIPPED_BY_DEFAULT: readonly RelayTaskStatus[] = ['done', 'blocked'];

/**
 * The tasks a relay runs, in order. Done and blocked tasks are left out unless named, since a
 * blocked task waits for the user's answer before it is worth another session.
 */
export function relayQueue(
  tasks: readonly Pick<RelayTask, 'id' | 'order' | 'depends' | 'status'>[],
  options: RelayQueueOptions = {},
): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  let ids = orderTasks(tasks).ordered;
  if (options.only) {
    const wanted = new Set(options.only);
    return ids.filter((id) => wanted.has(id));
  }
  if (options.from) {
    const start = ids.indexOf(options.from);
    if (start === -1) return [];
    ids = ids.slice(start);
  }
  return ids.filter(
    (id) => id === options.from || !SKIPPED_BY_DEFAULT.includes(status.get(id) ?? 'todo'),
  );
}

/** The dependencies of a task that are not done yet. Unknown ids do not hold a task back. */
export function unmetDependencies(
  task: Pick<RelayTask, 'depends'>,
  statusById: ReadonlyMap<string, RelayTaskStatus>,
): string[] {
  return task.depends.filter((dep) => statusById.has(dep) && statusById.get(dep) !== 'done');
}

/** The share of a budget an estimate may take before the board calls the task tight. */
export const TIGHT_ESTIMATE_SHARE = 0.6;

/**
 * How an estimate sits against a budget: comfortably inside, tight (little room left for tool
 * output and surprises), or over. Null when there is no estimate.
 */
export function budgetLevel(
  estimate: number | null,
  budget: number,
): 'ok' | 'tight' | 'over' | null {
  if (estimate === null) return null;
  if (estimate > budget) return 'over';
  if (estimate > budget * TIGHT_ESTIMATE_SHARE) return 'tight';
  return 'ok';
}
