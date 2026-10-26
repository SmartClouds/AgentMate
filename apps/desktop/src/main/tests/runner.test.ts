import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { TestDiscovery, TestRunEvent } from '@runova/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

const { discoverWorkspaceTests } = await import('./discovery');
const { TestRunManager } = await import('./runner');
const { FAKE_GO, isAlive, seedWorkspace, shim, waitFor, write } = await import('./fakeRunners');

/**
 * The run manager against real child processes. Node scripts stand in for Vitest and Go so the
 * whole path runs for real: the command line through cmd.exe, report files in a temp folder,
 * streamed JSON events, cancel and timeout killing the process tree.
 */

const onWindows = process.platform === 'win32';
let root = '';
let binDir = '';
let argsLog = '';
let pidFile = '';
const savedPath = process.env.PATH;
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';

beforeAll(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'runova-fake-bin-'));
  await write(join(binDir, 'fake-go.js'), FAKE_GO);
  await shim(join(binDir, 'go'), join(binDir, 'fake-go.js'));
  process.env[pathKey] = `${binDir}${delimiter}${savedPath ?? ''}`;
});

afterAll(async () => {
  process.env[pathKey] = savedPath;
  await rm(binDir, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runova runs & '));
  argsLog = join(root, 'args.log');
  pidFile = join(root, 'grandchild.pid');
  process.env.FAKE_ARGS_LOG = argsLog;
  process.env.FAKE_PID_FILE = pidFile;
  delete process.env.FAKE_VITEST_MODE;
  await seedWorkspace(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

async function setup(options: { timeoutMs?: number } = {}) {
  const events: TestRunEvent[] = [];
  const discovery: TestDiscovery = await discoverWorkspaceTests(root);
  const manager = new TestRunManager({
    emit: (event) => events.push(event),
    timeoutMs: options.timeoutMs,
    outputFlushMs: 10,
  });
  return { events, discovery, manager };
}

const loggedArgs = (): string[][] =>
  existsSync(argsLog)
    ? readFileSync(argsLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

describe('TestRunManager', () => {
  it('runs a Vitest project, reads its report and matches results to discovered tests', async () => {
    const { events, discovery, manager } = await setup();
    const summary = manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }],
    });
    expect(summary.running).toBe(true);
    expect(() =>
      manager.start({ projectId: 'p1', folderPath: root, discovery, targets: [] }),
    ).toThrow(/already running/);
    await manager.whenIdle('p1');

    expect(events[0]).toMatchObject({
      type: 'started',
      queued: [
        'vitest:web::web/src/math.test.ts::math > adds',
        'vitest:web::web/src/math.test.ts::math > breaks',
      ],
    });
    expect(events.map((event) => event.type).filter((type, i, all) => type !== all[i - 1])).toEqual(
      ['started', 'output', 'results', 'done'],
    );
    const output = events
      .flatMap((event) => (event.type === 'output' ? [event.text] : []))
      .join('');
    expect(output).toContain('RUN  v0.0.0 fake');
    const results = events.flatMap((event) => (event.type === 'results' ? event.results : []));
    expect(results.map((result) => `${result.status} ${result.id}`)).toEqual([
      'passed vitest:web::web/src/math.test.ts::math > adds',
      'failed vitest:web::web/src/math.test.ts::math > breaks',
    ]);
    expect(results[1]).toMatchObject({ line: 3, message: 'AssertionError: expected 1 to be 2' });

    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: 'done',
      summary: { running: false, cancelled: false, passed: 1, failed: 1, skipped: 0, errors: [] },
    });
    if (done.type === 'done')
      expect(done.summary.commands[0]).toMatch(/vitest(\.cmd)? run --reporter=verbose/);

    expect(loggedArgs()[0].slice(0, 3)).toEqual(['run', '--reporter=verbose', '--reporter=json']);
    const snapshot = manager.lastRun('p1');
    expect(snapshot?.results).toHaveLength(2);
    expect(snapshot?.summary.failed).toBe(1);
    expect(snapshot?.output).toContain('FAIL src/math.test.ts');
  }, 60_000);

  it('passes a single picked test to the runner as a file and an exact name', async () => {
    const { discovery, manager } = await setup();
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [
        {
          testProjectId: 'vitest:web',
          tests: [{ file: 'web/src/math.test.ts', path: ['math', 'adds'] }],
        },
      ],
    });
    await manager.whenIdle('p1');
    expect(loggedArgs()[0].slice(4)).toEqual(['src/math.test.ts', '-t', '^(?:math(?: | > )adds)$']);
    // Vitest reports the tests its filter left out as skipped; those must not overwrite anything.
    expect(manager.lastRun('p1')?.results.map((result) => `${result.status} ${result.id}`)).toEqual(
      ['passed vitest:web::web/src/math.test.ts::math > adds'],
    );
  }, 60_000);

  it("keeps the app's NODE_ENV away from the test runner", async () => {
    // Jest and Vitest only default to "test" when NODE_ENV is unset.
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { discovery, manager } = await setup();
      manager.start({
        projectId: 'p1',
        folderPath: root,
        discovery,
        targets: [{ testProjectId: 'vitest:web' }],
      });
      await manager.whenIdle('p1');
      expect(manager.lastRun('p1')?.output).toContain('NODE_ENV=(unset)');
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  }, 60_000);

  it.skipIf(!onWindows)(
    'falls back to the whole file when a test name cannot pass through cmd.exe',
    async () => {
      await write(join(root, 'web', 'src', 'math.test.ts'), `it('says "hi"', () => {});\n`);
      const { discovery, manager } = await setup();
      manager.start({
        projectId: 'p1',
        folderPath: root,
        discovery,
        targets: [
          {
            testProjectId: 'vitest:web',
            tests: [{ file: 'web/src/math.test.ts', path: ['says "hi"'] }],
          },
        ],
      });
      await manager.whenIdle('p1');
      expect(loggedArgs()[0].slice(4)).toEqual(['src/math.test.ts']);
    },
    60_000,
  );

  it('streams Go results live, shows readable output, and runs every project when none is picked', async () => {
    const { events, discovery, manager } = await setup();
    manager.start({ projectId: 'p1', folderPath: root, discovery, targets: [] });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'results' && event.results.some((result) => result.path[0] === 'TestAdd'),
      ),
    );
    // TestAdd arrives while the fake go is still pausing before TestSub.
    expect(events.some((event) => event.type === 'done')).toBe(false);
    await manager.whenIdle('p1');

    const results = events.flatMap((event) => (event.type === 'results' ? event.results : []));
    expect(results.map((result) => `${result.status} ${result.id}`)).toEqual([
      'passed go:svc::svc/calc/calc_test.go::TestAdd',
      'failed go:svc::svc/calc/calc_test.go::TestSub',
      'passed vitest:web::web/src/math.test.ts::math > adds',
      'failed vitest:web::web/src/math.test.ts::math > breaks',
    ]);
    expect(results[1].message).toBe('calc_test.go:7: want 1');
    const output = events
      .flatMap((event) => (event.type === 'output' ? [event.text] : []))
      .join('');
    expect(output).toContain('=== RUN   TestAdd');
    expect(output).not.toContain('"Action"');
    const done = events[events.length - 1];
    expect(done.type === 'done' && done.summary.commands).toHaveLength(2);
    expect(done).toMatchObject({ summary: { passed: 2, failed: 2 } });
  }, 60_000);

  it('reports a run that crashed before writing any results', async () => {
    process.env.FAKE_VITEST_MODE = 'crash';
    const { events, discovery, manager } = await setup();
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }],
    });
    await manager.whenIdle('p1');
    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: 'done',
      summary: {
        passed: 0,
        failed: 0,
        errors: [
          {
            kind: 'noResults',
            testProjectId: 'vitest:web',
            message: expect.stringMatching(/without reporting/),
          },
        ],
      },
    });
    expect(done.type === 'done' && done.summary.errors[0].log).toContain(
      'SyntaxError: Unexpected token',
    );
  }, 60_000);

  const rspecOnPath = (() => {
    try {
      execFileSync(onWindows ? 'where' : 'which', ['rspec'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(rspecOnPath)(
    'says the runner is not installed when its command is missing',
    async () => {
      await write(join(root, '.rspec'), '--require spec_helper\n');
      await write(
        join(root, 'spec', 'user_spec.rb'),
        "describe 'User' do\n  it 'works' do\n  end\nend\n",
      );
      const { events, discovery, manager } = await setup();
      manager.start({
        projectId: 'p1',
        folderPath: root,
        discovery,
        targets: [{ testProjectId: 'rspec:' }],
      });
      await manager.whenIdle('p1');
      const done = events[events.length - 1];
      expect(done).toMatchObject({
        type: 'done',
        summary: { errors: [{ kind: 'notFound', message: expect.stringMatching(/RSpec/) }] },
      });
    },
    60_000,
  );

  it('cancels a run, kills its whole process tree and clears queued tests', async () => {
    process.env.FAKE_VITEST_MODE = 'slow';
    const { events, discovery, manager } = await setup();
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }, { testProjectId: 'go:svc' }],
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').length > 0);
    const grandchild = Number(readFileSync(pidFile, 'utf-8'));
    expect(manager.cancel('p1')).toBe(true);
    await manager.whenIdle('p1');
    await waitFor(() => !isAlive(grandchild));

    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: 'done',
      summary: { cancelled: true, running: false, errors: [] },
    });
    // Cancelling stops the whole run, so the Go project after it never starts.
    expect(done.type === 'done' && done.summary.commands).toHaveLength(1);
    expect(manager.cancel('p1')).toBe(false);
    expect(manager.lastRun('p1')?.summary.cancelled).toBe(true);
  }, 60_000);

  it('keeps the tests it picked in the snapshot, so a panel opening mid-run can show them', async () => {
    process.env.FAKE_VITEST_MODE = 'slow';
    const { discovery, manager } = await setup();
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }],
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').length > 0);
    const snapshot = manager.lastRun('p1');
    expect(snapshot?.summary.running).toBe(true);
    expect(snapshot?.queued).toEqual([
      'vitest:web::web/src/math.test.ts::math > adds',
      'vitest:web::web/src/math.test.ts::math > breaks',
    ]);
    manager.cancel('p1');
    await manager.whenIdle('p1');
    await waitFor(() => !isAlive(Number(readFileSync(pidFile, 'utf-8'))));
  }, 60_000);

  it('stops a run that goes quiet past the timeout and says so', async () => {
    process.env.FAKE_VITEST_MODE = 'slow';
    const { events, discovery, manager } = await setup({ timeoutMs: 2_000 });
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }],
    });
    await manager.whenIdle('p1');
    const grandchild = Number(readFileSync(pidFile, 'utf-8'));
    await waitFor(() => !isAlive(grandchild));
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      summary: {
        errors: [
          {
            kind: 'timedOut',
            testProjectId: 'vitest:web',
            message: expect.stringContaining('printed nothing for'),
          },
        ],
      },
    });
  }, 60_000);

  it('counts the timeout from the last output, so a long run that keeps reporting is not cut off', async () => {
    const discovery = await discoverWorkspaceTests(root);
    const asked: Array<boolean | undefined> = [];
    const manager = new TestRunManager({
      emit: () => undefined,
      spawn: async (options) => {
        asked.push(options.idle);
        return { code: 0, log: '', timedOut: false, cancelled: false, notFound: false };
      },
      outputFlushMs: 10,
    });
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [{ testProjectId: 'vitest:web' }],
    });
    await manager.whenIdle('p1');
    expect(asked).toEqual([true]);
  });

  it('describes the command a single test would run with', async () => {
    const { discovery, manager } = await setup();
    const command = manager.describeCommand(root, discovery, {
      testProjectId: 'go:svc',
      tests: [{ file: 'svc/calc/calc_test.go', path: ['TestSub'] }],
    });
    expect(command).toBe("go test -run '^(?:TestSub)$' ./calc");
    expect(manager.describeCommand(root, discovery, { testProjectId: 'nope:' })).toBeNull();
  });
});
