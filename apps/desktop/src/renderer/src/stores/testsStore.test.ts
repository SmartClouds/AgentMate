import type { TestResult, TestRunEvent, TestRunSummary } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  coalesceEvents,
  failedCount,
  failedResults,
  type ProjectTestRun,
  useTestsStore,
} from './testsStore';

const summary = (patch: Partial<TestRunSummary> = {}): TestRunSummary => ({
  runId: 'r1',
  projectId: 'p1',
  startedAt: 1,
  running: true,
  cancelled: false,
  passed: 0,
  failed: 0,
  skipped: 0,
  commands: [],
  errors: [],
  ...patch,
});

const result = (id: string, status: TestResult['status'], path = [id]): TestResult => ({
  id,
  testProjectId: 'vitest:',
  file: 'a.test.ts',
  path,
  status,
});

describe('applyRunEvent', () => {
  it('queues picked tests on start, keeps older results for the rest and clears the output', () => {
    const before: ProjectTestRun = {
      summary: summary({ runId: 'r0', running: false }),
      results: { a: result('a', 'failed'), b: result('b', 'passed') },
      output: 'old output',
    };
    const next = applyRunEvent(before, {
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: ['a'],
    });
    expect(next.summary?.runId).toBe('r1');
    expect(next.results.a.status).toBe('queued');
    expect(next.results.b.status).toBe('passed');
    expect(next.output).toBe('');
  });

  it('appends output and results, and caps the output', () => {
    let run = applyRunEvent(undefined, {
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: [],
    });
    run = applyRunEvent(run, { type: 'output', runId: 'r1', projectId: 'p1', text: 'line 1\n' });
    run = applyRunEvent(run, {
      type: 'output',
      runId: 'r1',
      projectId: 'p1',
      text: 'x'.repeat(300_000),
    });
    expect(run.output.length).toBeLessThanOrEqual(200_000);
    run = applyRunEvent(run, {
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [result('a', 'failed')],
    });
    expect(run.results.a.status).toBe('failed');
  });

  it('ignores events from an older run', () => {
    const run = applyRunEvent(undefined, {
      type: 'started',
      runId: 'r2',
      projectId: 'p1',
      summary: summary({ runId: 'r2' }),
      queued: [],
    });
    const stale: TestRunEvent = {
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [result('a', 'passed')],
    };
    expect(applyRunEvent(run, stale)).toBe(run);
  });

  it('drops tests still queued when the run ends, and brings back what they showed before', () => {
    let run: ProjectTestRun = {
      summary: summary({ runId: 'r0', running: false }),
      results: { a: result('a', 'failed'), c: result('c', 'passed') },
      output: '',
    };
    run = applyRunEvent(run, {
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: ['a', 'b', 'c'],
    });
    run = applyRunEvent(run, {
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [result('c', 'failed')],
    });
    run = applyRunEvent(run, {
      type: 'done',
      runId: 'r1',
      projectId: 'p1',
      summary: summary({ running: false, cancelled: true }),
    });
    expect(run.summary?.running).toBe(false);
    expect(run.results.a.status).toBe('failed');
    expect(run.results.b).toBeUndefined();
    expect(run.results.c.status).toBe('failed');
  });
});

describe('failedCount', () => {
  const error = (testProjectId: string): TestRunSummary['errors'][number] => ({
    kind: 'noResults',
    testProjectId,
    command: 'dotnet test',
    message: 'The .NET run ended without reporting any results (exit code 5).',
    log: '',
  });

  it('counts failed results and the test projects that could not run', () => {
    const run: ProjectTestRun = {
      summary: summary({
        running: false,
        errors: [error('dotnet:a'), error('dotnet:b'), error('phpunit:')],
      }),
      results: { a: result('a', 'failed'), b: result('b', 'passed') },
      output: '',
    };
    expect(failedCount(run)).toBe(4);
  });

  it('is zero without a run', () => {
    expect(failedCount(undefined)).toBe(0);
    expect(failedCount({ summary: null, results: {}, output: '' })).toBe(0);
  });
});

describe('useTestsStore', () => {
  beforeEach(() => useTestsStore.setState({ runs: {} }));

  it('routes events to their project and hydrates a snapshot', () => {
    const store = useTestsStore.getState();
    store.hydrate('p2', {
      summary: summary({ projectId: 'p2', running: false, failed: 1 }),
      results: [result('x', 'failed')],
      output: 'o',
      queued: [],
    });
    store.applyEvent({
      type: 'started',
      runId: 'r9',
      projectId: 'p1',
      summary: summary({ runId: 'r9' }),
      queued: [],
    });
    const { runs } = useTestsStore.getState();
    expect(runs.p2.results.x.status).toBe('failed');
    expect(runs.p1.summary?.runId).toBe('r9');
    expect(failedResults(runs.p2).map((entry) => entry.id)).toEqual(['x']);
  });

  it('does not let a stale snapshot overwrite a run that is already live', () => {
    const store = useTestsStore.getState();
    store.applyEvent({
      type: 'started',
      runId: 'r9',
      projectId: 'p1',
      summary: summary({ runId: 'r9' }),
      queued: [],
    });
    store.hydrate('p1', {
      summary: summary({ runId: 'r8', running: false }),
      results: [],
      output: '',
      queued: [],
    });
    expect(useTestsStore.getState().runs.p1.summary?.runId).toBe('r9');
  });

  it('keeps the tests that are still waiting when a live run is hydrated again', () => {
    const store = useTestsStore.getState();
    store.applyEvent({
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: ['a', 'b'],
    });
    // The panel closed and opened again mid-run: main only knows about the results so far.
    store.hydrate('p1', {
      summary: summary(),
      results: [result('a', 'passed')],
      output: 'o',
      queued: ['a', 'b'],
    });
    const run = useTestsStore.getState().runs.p1;
    expect(run.results.a.status).toBe('passed');
    expect(run.results.b.status).toBe('queued');
    expect(run.output).toBe('o');
  });

  it('keeps what a waiting test showed before, so a cancel after hydrating puts it back', () => {
    const store = useTestsStore.getState();
    store.hydrate('p1', {
      summary: summary({ runId: 'r0', running: false }),
      results: [result('b', 'failed')],
      output: '',
      queued: [],
    });
    store.applyEvent({
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: ['a', 'b'],
    });
    store.hydrate('p1', { summary: summary(), results: [], output: '', queued: ['a', 'b'] });
    store.applyEvent({
      type: 'done',
      runId: 'r1',
      projectId: 'p1',
      summary: summary({ running: false, cancelled: true }),
    });
    const run = useTestsStore.getState().runs.p1;
    expect(run.results.a).toBeUndefined();
    expect(run.results.b.status).toBe('failed');
  });

  it('leaves a finished run alone, queued ids and all', () => {
    const store = useTestsStore.getState();
    store.hydrate('p1', {
      summary: summary({ running: false, passed: 1 }),
      results: [result('a', 'passed')],
      output: '',
      queued: ['a', 'b'],
    });
    const run = useTestsStore.getState().runs.p1;
    expect(run.results.b).toBeUndefined();
    expect(Object.keys(run.results)).toEqual(['a']);
  });

  it('keeps the result objects it already has when a live run is hydrated again', () => {
    const store = useTestsStore.getState();
    store.applyEvent({
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: summary(),
      queued: ['a', 'b'],
    });
    store.applyEvent({
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [result('a', 'passed'), result('b', 'failed')],
    });
    const before = useTestsStore.getState().runs.p1.results;
    // Switching back to the project hydrates from main, which sends copies of the same results.
    store.hydrate('p1', {
      summary: summary(),
      results: [
        { ...result('a', 'passed'), path: ['a'] },
        { ...result('b', 'failed'), message: 'now with a message' },
      ],
      output: '',
      queued: ['a', 'b'],
    });
    const after = useTestsStore.getState().runs.p1.results;
    // Rows are memoized on their result, so an unchanged one must stay the same object.
    expect(after.a).toBe(before.a);
    expect(after.b).not.toBe(before.b);
    expect(after.b.message).toBe('now with a message');
  });
});

describe('coalesceEvents', () => {
  const result = (id: string) => ({
    id,
    testProjectId: 'p',
    path: [id],
    status: 'passed' as const,
  });

  it('folds neighbouring results and output of one run into single events', () => {
    const events = coalesceEvents([
      { type: 'results', runId: 'r', projectId: 'a', results: [result('1')] },
      { type: 'results', runId: 'r', projectId: 'a', results: [result('2')] },
      { type: 'output', runId: 'r', projectId: 'a', text: 'x' },
      { type: 'output', runId: 'r', projectId: 'a', text: 'y' },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'results' });
    expect((events[0] as { results: unknown[] }).results).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'output', text: 'xy' });
  });

  it('folds the alternating output and results of a streaming run into one of each', () => {
    // A streaming runner sends output, then that test's result, test after test.
    const stream: TestRunEvent[] = [];
    for (let i = 0; i < 500; i += 1) {
      stream.push({ type: 'output', runId: 'r', projectId: 'a', text: `line ${i}\n` });
      stream.push({ type: 'results', runId: 'r', projectId: 'a', results: [result(String(i))] });
    }
    const events = coalesceEvents(stream);
    expect(events.map((event) => event.type)).toEqual(['output', 'results']);
    const [output, results] = events as [
      Extract<TestRunEvent, { type: 'output' }>,
      Extract<TestRunEvent, { type: 'results' }>,
    ];
    expect(output.text.startsWith('line 0\nline 1\n')).toBe(true);
    expect(output.text.endsWith('line 499\n')).toBe(true);
    // A later result for the same test still lands after an earlier one.
    expect(results.results.map((entry) => entry.id)).toEqual(
      Array.from({ length: 500 }, (_, i) => String(i)),
    );
  });

  it('never folds across the start or end of a run, and keeps projects apart', () => {
    const started = (runId: string): TestRunEvent => ({
      type: 'started',
      runId,
      projectId: 'a',
      summary: {
        runId,
        projectId: 'a',
        startedAt: 1,
        running: true,
        cancelled: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        commands: [],
        errors: [],
      },
      queued: [],
    });
    const events = coalesceEvents([
      { type: 'output', runId: 'r1', projectId: 'a', text: 'a1 ' },
      { type: 'output', runId: 'r1', projectId: 'b', text: 'b1 ' },
      started('r2'),
      { type: 'output', runId: 'r2', projectId: 'a', text: 'a2 ' },
      { type: 'output', runId: 'r1', projectId: 'b', text: 'b2 ' },
      { type: 'output', runId: 'r2', projectId: 'a', text: 'a3 ' },
    ]);
    expect(
      events.map((event) =>
        event.type === 'output' ? `${event.projectId}:${event.text.trim()}` : event.type,
      ),
    ).toEqual(['a:a1', 'b:b1 b2', 'started', 'a:a2 a3']);
  });

  it('takes a big run event by event without holding up the window', () => {
    const store = useTestsStore.getState();
    const ids = Array.from({ length: 3_000 }, (_, i) => `t${i}`);
    store.applyEvent({
      type: 'started',
      runId: 'r1',
      projectId: 'p1',
      summary: {
        runId: 'r1',
        projectId: 'p1',
        startedAt: 1,
        running: true,
        cancelled: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        commands: [],
        errors: [],
      },
      queued: ids,
    });
    const stream: TestRunEvent[] = ids.flatMap((id) => [
      { type: 'output', runId: 'r1', projectId: 'p1', text: 'a log line\n'.repeat(6) },
      { type: 'results', runId: 'r1', projectId: 'p1', results: [result(id)] },
    ]);
    const started = performance.now();
    // What arrives in about 20 of the store's 150 ms batches during a run of that size.
    for (let at = 0; at < stream.length; at += 300) {
      store.applyEvents(stream.slice(at, at + 300));
    }
    const elapsed = performance.now() - started;
    expect(Object.values(useTestsStore.getState().runs.p1.results)).toHaveLength(3_000);
    // Copying every result and trimming the output once per event took about 6 seconds here.
    expect(elapsed, 'time spent applying the events (ms)').toBeLessThan(750);
  });
});
