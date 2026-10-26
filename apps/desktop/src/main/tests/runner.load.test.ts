import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTestTree,
  type TestDiscovery,
  type TestProject,
  type TestResult,
  type TestRunEvent,
} from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnStreamingOptions, SpawnStreamingResult } from '../process/spawnStreaming';

vi.mock('../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

const { OutputTail, TestRunManager } = await import('./runner');

/**
 * The run manager under the load of a big suite. A few thousand tests that log as they go used to
 * keep the main process busy for seconds (it trimmed the whole kept output on every line) and sent
 * two messages to the window per test, which stalled every click in the app while tests ran. The
 * runner here is a stand-in that pushes output the way a pipe does, in 64 KB chunks with a turn
 * of the event loop between them, so the time spent handling each chunk can be measured.
 */

const vitest: TestProject = { id: 'vitest:', framework: 'vitest', root: '', label: 'Vitest' };

function bigSuite(files: number, testsPerFile: number): TestDiscovery {
  const sources: Record<string, string> = {};
  for (let f = 0; f < files; f += 1) {
    const tests = Array.from({ length: testsPerFile }, (_, t) => `  it('t${t}', () => {});`);
    sources[`src/f${f}.test.ts`] = `describe('suite', () => {\n${tests.join('\n')}\n});\n`;
  }
  return { projects: [vitest], tree: buildTestTree([vitest], sources), truncated: false };
}

interface FakeRun {
  lines: string[];
  report?: unknown;
}

/**
 * A runner that streams `lines` like a pipe and writes `report` where Vitest would. Records how
 * long the manager takes over each chunk, which is how long a click waits behind it.
 */
function fakeSpawn(run: FakeRun, chunkTimes: number[]) {
  return async (options: SpawnStreamingOptions): Promise<SpawnStreamingResult> => {
    let i = 0;
    while (i < run.lines.length) {
      const started = performance.now();
      let bytes = 0;
      while (i < run.lines.length && bytes < 65_536) {
        bytes += run.lines[i].length + 1;
        options.onLine?.(run.lines[i]);
        i += 1;
      }
      chunkTimes.push(performance.now() - started);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const out = options.args.find((arg) => arg.startsWith('--outputFile.json='));
    if (out && run.report) {
      await writeFile(out.slice('--outputFile.json='.length), JSON.stringify(run.report));
    }
    return { code: 0, log: '', timedOut: false, cancelled: false, notFound: false };
  };
}

/**
 * What keeping the output the old way costs on this machine, right now: trimming the whole kept
 * tail on every line. Timing against this rather than a fixed number of milliseconds keeps the
 * check fair on a slow machine, or with other test files competing for the CPU.
 */
function trimEveryLineMs(lines: string[]): number {
  let tail = '';
  const started = performance.now();
  for (const line of lines)
    tail = `${tail}${line}
`.slice(-200_000);
  const elapsed = performance.now() - started;
  expect(tail.length).toBe(200_000);
  return elapsed;
}

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runova-runner-load-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('OutputTail', () => {
  it('keeps exactly the last characters of everything appended', () => {
    const tail = new OutputTail(10);
    expect(tail.isEmpty).toBe(true);
    expect(tail.toString()).toBe('');
    let all = '';
    for (let i = 0; i < 100; i += 1) {
      const piece = `${i},`;
      tail.append(piece);
      all += piece;
      expect(tail.toString()).toBe(all.slice(-10));
    }
    expect(tail.isEmpty).toBe(false);
  });

  it('keeps a piece longer than the cap cut down to its end', () => {
    const tail = new OutputTail(5);
    tail.append('abcdefghij');
    expect(tail.toString()).toBe('fghij');
    tail.append('');
    expect(tail.toString()).toBe('fghij');
  });
});

describe('TestRunManager under a big suite', () => {
  it('keeps the main process free and sends the window a handful of events', async () => {
    const FILES = 150;
    const TESTS = 8;
    const LOG_LINES = 10;
    const discovery = bigSuite(FILES, TESTS);
    const lines: string[] = [];
    const assertions: Record<string, unknown[]> = {};
    for (let f = 0; f < FILES; f += 1) {
      const file = `src/f${f}.test.ts`;
      for (let t = 0; t < TESTS; t += 1) {
        lines.push(`stdout | ${file} > suite > t${t}`);
        for (let n = 0; n < LOG_LINES; n += 1) {
          lines.push(`  a log line the test printed ${n} ${'x'.repeat(60)}`);
        }
        lines.push(` ✓ ${file} > suite > t${t} 3ms`);
        (assertions[file] ??= []).push({
          ancestorTitles: ['suite'],
          title: `t${t}`,
          status: 'passed',
          duration: 3,
          failureMessages: [],
        });
      }
    }
    const report = {
      testResults: Object.entries(assertions).map(([file, assertionResults]) => ({
        name: join(root, file),
        status: 'passed',
        message: '',
        assertionResults,
      })),
    };
    const chunkTimes: number[] = [];
    const events: TestRunEvent[] = [];
    const manager = new TestRunManager({
      emit: (event) => events.push(event),
      spawn: fakeSpawn({ lines, report }, chunkTimes),
    });

    manager.start({ projectId: 'p1', folderPath: root, discovery, targets: [] });
    await manager.whenIdle('p1');

    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done', summary: { passed: FILES * TESTS, failed: 0 } });
    const streamed = events.flatMap((event) => (event.type === 'results' ? event.results : []));
    expect(new Set(streamed.map((result) => result.id)).size).toBe(FILES * TESTS);

    // Per test, this used to be one output event and one results event: 2,400 for this run. Now
    // it is two per 80 ms flush, so a slow machine gets a few more, not thousands.
    const traffic = events.filter((event) => event.type === 'output' || event.type === 'results');
    expect(traffic.length).toBeLessThan(500);

    // The kept output is capped, and is the end of what the runner printed.
    const output = manager.lastRun('p1')?.output ?? '';
    expect(output.length).toBeLessThanOrEqual(200_000);
    expect(output.endsWith(`${lines[lines.length - 1]}\n`)).toBe(true);

    // About 14,000 lines. Handling them used to cost at least the trim on every line (60 to 100 ms
    // per chunk on a fast machine, during which no click in the window went anywhere). Now it is
    // around a tenth of that.
    const busy = chunkTimes.reduce((sum, ms) => sum + ms, 0);
    const oldWay = trimEveryLineMs(lines);
    expect(
      busy,
      `ms spent on the output, against ${Math.round(oldWay)} ms the old way`,
    ).toBeLessThan(oldWay / 2);
  }, 60_000);

  it('only keeps skipped results that sit under a picked test', async () => {
    const discovery: TestDiscovery = {
      projects: [vitest],
      tree: buildTestTree([vitest], {
        'src/math.test.ts':
          "describe('math', () => {\n  it('adds', () => {});\n  it('breaks', () => {});\n});\n",
      }),
      truncated: false,
    };
    const assertion = (path: string[], status: string) => ({
      ancestorTitles: path.slice(0, -1),
      title: path[path.length - 1],
      status,
      duration: 1,
      failureMessages: [],
    });
    const report = {
      testResults: [
        {
          name: join(root, 'src/math.test.ts'),
          status: 'passed',
          message: '',
          assertionResults: [
            assertion(['math', 'adds'], 'passed'),
            // A parameter case of the picked test, and a test the name filter left out.
            assertion(['math', 'adds', 'case 1'], 'skipped'),
            assertion(['math', 'breaks'], 'skipped'),
          ],
        },
      ],
    };
    const events: TestRunEvent[] = [];
    const manager = new TestRunManager({
      emit: (event) => events.push(event),
      spawn: fakeSpawn({ lines: [], report }, []),
    });
    manager.start({
      projectId: 'p1',
      folderPath: root,
      discovery,
      targets: [
        { testProjectId: 'vitest:', tests: [{ file: 'src/math.test.ts', path: ['math', 'adds'] }] },
      ],
    });
    await manager.whenIdle('p1');

    const results: TestResult[] = events.flatMap((event) =>
      event.type === 'results' ? event.results : [],
    );
    expect(results.map((result) => `${result.status} ${result.path.join(' > ')}`)).toEqual([
      'passed math > adds',
      'skipped math > adds > case 1',
    ]);
  });
});
