import type { TestResult, TestRunEvent, TestRunSnapshot, TestRunSummary } from '@runova/core';
import { create } from 'zustand';

/**
 * The Tests panel's view of each project's latest run, fed by the events main broadcasts. Not
 * persisted: main keeps the last run, and the panel hydrates from it when it opens.
 */

const MAX_OUTPUT_CHARS = 200_000;

export interface ProjectTestRun {
  summary: TestRunSummary | null;
  results: Record<string, TestResult>;
  output: string;
  /** What queued tests showed before this run, so a cancel can put it back. */
  previous?: Record<string, TestResult>;
}

/** A test that is waiting on the run, keeping whatever the panel already knows about it. */
function queuedResult(id: string, old: TestResult | undefined): TestResult {
  return old
    ? { ...old, status: 'queued', message: undefined, stack: undefined, durationMs: undefined }
    : { id, testProjectId: id.split('::')[0], path: [], status: 'queued' };
}

export function applyRunEvent(
  run: ProjectTestRun | undefined,
  event: TestRunEvent,
): ProjectTestRun {
  const current: ProjectTestRun = run ?? { summary: null, results: {}, output: '' };
  if (event.type === 'started') {
    const results = { ...current.results };
    const previous: Record<string, TestResult> = {};
    for (const id of event.queued) {
      const old = results[id];
      if (old) previous[id] = old;
      results[id] = queuedResult(id, old);
    }
    return { summary: event.summary, results, output: '', previous };
  }
  if (current.summary?.runId !== event.runId) return current;
  switch (event.type) {
    case 'output':
      return { ...current, output: (current.output + event.text).slice(-MAX_OUTPUT_CHARS) };
    case 'results': {
      const results = { ...current.results };
      for (const result of event.results) results[result.id] = result;
      return { ...current, results };
    }
    case 'done': {
      const results = { ...current.results };
      for (const [id, result] of Object.entries(results)) {
        if (result.status !== 'queued' && result.status !== 'running') continue;
        const before = current.previous?.[id];
        if (before) results[id] = before;
        else delete results[id];
      }
      return { summary: event.summary, results, output: current.output };
    }
  }
}

function sameResult(a: TestResult, b: TestResult): boolean {
  return (
    a.status === b.status &&
    a.durationMs === b.durationMs &&
    a.message === b.message &&
    a.stack === b.stack &&
    a.line === b.line &&
    a.file === b.file &&
    a.testProjectId === b.testProjectId &&
    a.path.length === b.path.length &&
    a.path.every((segment, index) => segment === b.path[index])
  );
}

export function failedResults(run: ProjectTestRun | undefined): TestResult[] {
  return run ? Object.values(run.results).filter((result) => result.status === 'failed') : [];
}

/**
 * Failed tests and files plus the test projects that could not run, for every failed count. A test
 * project that never ran (a missing tool, a crash, a timeout, zero tests reported) has no results
 * of its own and only exists as a run error, but it is a failure all the same.
 */
export function failedCount(run: ProjectTestRun | undefined): number {
  return failedResults(run).length + (run?.summary?.errors.length ?? 0);
}

/**
 * Folds the output and results events of each run into one of each, so a burst costs one copy of
 * the results map and one trim of the output instead of one per event. A runner that streams
 * reports alternates the two, output then result for every test, so merging only neighbours of
 * the same type merged nothing, and a big suite kept the window busy for seconds.
 *
 * Output and results touch different parts of a run, so gathering each at its first position is
 * safe. A start or finish of the same project is never crossed.
 */
export function coalesceEvents(events: TestRunEvent[]): TestRunEvent[] {
  const out: TestRunEvent[] = [];
  const texts = new Map<number, string[]>();
  const results = new Map<number, TestResult[]>();
  /** Where each project's merged output and results sit in `out`, until its run starts or ends. */
  const open = new Map<string, number>();

  for (const event of events) {
    if (event.type === 'started' || event.type === 'done') {
      for (const key of [...open.keys()]) {
        if (key.startsWith(`${event.projectId}\n`)) open.delete(key);
      }
      out.push(event);
      continue;
    }
    const key = `${event.projectId}\n${event.runId}\n${event.type}`;
    const at = open.get(key);
    if (at === undefined) {
      open.set(key, out.length);
      if (event.type === 'output') texts.set(out.length, [event.text]);
      else results.set(out.length, [...event.results]);
      out.push(event);
    } else if (event.type === 'output') {
      texts.get(at)?.push(event.text);
    } else {
      const list = results.get(at);
      for (const result of event.results) list?.push(result);
    }
  }

  return out.map((event, index) => {
    if (event.type === 'output') {
      const parts = texts.get(index);
      return parts && parts.length > 1 ? { ...event, text: parts.join('') } : event;
    }
    if (event.type === 'results') {
      const list = results.get(index);
      return list && list.length !== event.results.length ? { ...event, results: list } : event;
    }
    return event;
  });
}

interface TestsState {
  runs: Record<string, ProjectTestRun>;
  applyEvent: (event: TestRunEvent) => void;
  applyEvents: (events: TestRunEvent[]) => void;
  hydrate: (projectId: string, snapshot: TestRunSnapshot) => void;
}

export const useTestsStore = create<TestsState>((set) => ({
  runs: {},
  applyEvent: (event) =>
    set((state) => ({
      runs: { ...state.runs, [event.projectId]: applyRunEvent(state.runs[event.projectId], event) },
    })),
  applyEvents: (events) =>
    set((state) => {
      const runs = { ...state.runs };
      for (const event of coalesceEvents(events)) {
        runs[event.projectId] = applyRunEvent(runs[event.projectId], event);
      }
      return { runs };
    }),
  hydrate: (projectId, snapshot) =>
    set((state) => {
      const current = state.runs[projectId];
      const live = current?.summary;
      if (
        live &&
        (live.running || live.startedAt >= snapshot.summary.startedAt) &&
        live.runId !== snapshot.summary.runId
      ) {
        return state;
      }
      // The panel hydrates each time it opens, switching back to a project included. Results the
      // window already has keep their objects, so their rows are not all drawn over again.
      const results: Record<string, TestResult> = Object.fromEntries(
        snapshot.results.map((result) => {
          const known = current?.results[result.id];
          return [result.id, known && sameResult(known, result) ? known : result];
        }),
      );
      // A snapshot only carries what the runner has reported. Without this, reopening the panel
      // during a run would leave every test still waiting looking as if it had never run.
      if (snapshot.summary.running) {
        for (const id of snapshot.queued) {
          if (results[id]) continue;
          const old = current?.results[id];
          results[id] =
            old?.status === 'running' || old?.status === 'queued' ? old : queuedResult(id, old);
        }
      }
      const sameRun = live?.runId === snapshot.summary.runId;
      return {
        runs: {
          ...state.runs,
          [projectId]: {
            summary: snapshot.summary,
            results,
            output: snapshot.output,
            // Keep what the tests showed before this run so a cancel can still put it back.
            ...(sameRun && current?.previous ? { previous: current.previous } : {}),
          },
        },
      };
    }),
}));

let subscribed = false;

/** How long events are held before they reach the store; a large run sends them by the hundred. */
const EVENT_FLUSH_MS = 150;
let queued: TestRunEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushEvents(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queued.length === 0) return;
  const batch = queued;
  queued = [];
  useTestsStore.getState().applyEvents(batch);
}

function queueEvent(event: TestRunEvent): void {
  queued.push(event);
  // Start and end land at once so the buttons and counts never lag behind the run.
  if (event.type === 'started' || event.type === 'done') {
    flushEvents();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flushEvents, EVENT_FLUSH_MS);
}

/** Starts listening for run events once for the whole window. */
export function ensureTestRunSubscription(): void {
  if (subscribed || !window.runova?.tests) return;
  subscribed = true;
  window.runova.tests.onRunEvent(queueEvent);
}
