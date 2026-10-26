// @vitest-environment jsdom
import {
  buildTestTree,
  type Project,
  type TestDiscovery,
  type TestProject,
  type TestRunSummary,
} from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTestsStore } from '@/stores/testsStore';

/**
 * How much of the Tests tab redraws while a run reports in. Results arrive several times a second
 * and a big suite has thousands of rows; redrawing all of them for each batch, and again for every
 * tick of the run's clock, kept the window too busy to switch projects.
 *
 * Every row with a file has an "Open" button with a tooltip, so counting those tooltips as they
 * render counts the rows drawn.
 */

const drawn = vi.hoisted(() => ({ rows: 0 }));

vi.mock('@/components/ui/tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/tooltip')>();
  function CountingTooltip(props: Parameters<typeof actual.SimpleTooltip>[0]) {
    if (typeof props.label === 'string' && props.label.startsWith('Open ')) drawn.rows += 1;
    return <actual.SimpleTooltip {...props} />;
  }
  return { ...actual, SimpleTooltip: CountingTooltip };
});
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: vi.fn(() => 'tab-1'),
  projectCliId: () => 'claude-code',
}));

const { TestsSection } = await import('./TestsSection');

const FILES = 30;
const TESTS_PER_FILE = 3;
/** A file row, a suite row and a row per test for every file: all of them have a file. */
const ROWS_WITH_A_FILE = FILES * (2 + TESTS_PER_FILE);

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
const vitest: TestProject = { id: 'vitest:', framework: 'vitest', root: '', label: 'Vitest' };
const sources: Record<string, string> = {};
const ids: string[] = [];
for (let f = 0; f < FILES; f += 1) {
  const tests = Array.from({ length: TESTS_PER_FILE }, (_, t) => `  it('t${t}', () => {});`);
  sources[`src/f${f}.test.ts`] = `describe('suite', () => {\n${tests.join('\n')}\n});\n`;
  for (let t = 0; t < TESTS_PER_FILE; t += 1) ids.push(`vitest:::src/f${f}.test.ts::suite > t${t}`);
}
const discovery: TestDiscovery = {
  projects: [vitest],
  tree: buildTestTree([vitest], sources),
  truncated: false,
};

const summary: TestRunSummary = {
  runId: 'r1',
  projectId: 'p1',
  startedAt: Date.now(),
  running: true,
  cancelled: false,
  passed: 0,
  failed: 0,
  skipped: 0,
  commands: [],
  errors: [],
};

beforeEach(() => {
  drawn.rows = 0;
  useTestsStore.setState({ runs: {} });
  window.runova = {
    ...window.runova,
    tests: {
      discover: vi.fn(async () => discovery),
      run: vi.fn(),
      cancel: vi.fn(),
      lastRun: vi.fn(async () => null),
      command: vi.fn(),
      onRunEvent: vi.fn(() => () => undefined),
    },
  } as typeof window.runova;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function renderWithRunStarted(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <TestsSection project={project} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('tree');
  act(() =>
    useTestsStore
      .getState()
      .applyEvents([{ type: 'started', runId: 'r1', projectId: 'p1', summary, queued: ids }]),
  );
  // Every row shows, the ones past the first screenful included.
  expect(screen.getAllByRole('treeitem')).toHaveLength(1 + ROWS_WITH_A_FILE);
}

describe('TestsSection while a run reports in', () => {
  it('redraws only the rows whose result changed', async () => {
    await renderWithRunStarted();
    drawn.rows = 0;

    act(() =>
      useTestsStore.getState().applyEvents([
        { type: 'output', runId: 'r1', projectId: 'p1', text: 'a line of output\n' },
        {
          type: 'results',
          runId: 'r1',
          projectId: 'p1',
          results: [
            {
              id: ids[0],
              testProjectId: 'vitest:',
              file: 'src/f0.test.ts',
              path: ['suite', 't0'],
              status: 'passed',
            },
          ],
        },
      ]),
    );

    expect(screen.getAllByRole('treeitem')[3]).toHaveTextContent('t0');
    // The test itself. Its suite, file and project are still running the other tests.
    expect(drawn.rows).toBe(1);
  });

  it('ticks the run clock without redrawing the tree', async () => {
    await renderWithRunStarted();
    // The first run's clock ticks on real timers, so finish it and time the next one.
    act(() =>
      useTestsStore.getState().applyEvents([
        {
          type: 'done',
          runId: 'r1',
          projectId: 'p1',
          summary: { ...summary, running: false, finishedAt: summary.startedAt + 500 },
        },
      ]),
    );
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    act(() =>
      useTestsStore.getState().applyEvents([
        {
          type: 'started',
          runId: 'r2',
          projectId: 'p1',
          summary: { ...summary, runId: 'r2', startedAt: summary.startedAt + 1_000 },
          queued: ids,
        },
      ]),
    );
    drawn.rows = 0;

    act(() => vi.advanceTimersByTime(3_000));

    expect(screen.getByLabelText('Elapsed time')).toBeInTheDocument();
    expect(drawn.rows).toBe(0);
  });
});
