// @vitest-environment jsdom
import {
  buildTestTree,
  type Project,
  type TestDiscovery,
  type TestProject,
  type TestResult,
  type TestRunEvent,
  type TestRunSnapshot,
  type TestRunSummary,
} from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTestsStore } from '@/stores/testsStore';

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: vi.fn(() => 'tab-1'),
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze: vi.fn(),
  }),
  RunRecommendationPanel: () => null,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { TestsSection, TestsTabActions, useTestsFailedCount } = await import('./TestsSection');

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
const vitest: TestProject = { id: 'vitest:', framework: 'vitest', root: '', label: 'Vitest' };
const go: TestProject = {
  id: 'go:svc',
  framework: 'go',
  root: 'svc',
  label: 'Go · svc',
  meta: { module: 'x' },
};

const discovery: TestDiscovery = {
  projects: [vitest, go],
  tree: buildTestTree([vitest, go], {
    'src/math.test.ts':
      "describe('math', () => {\n  it('adds', () => {});\n  it('breaks', () => {});\n});\n",
    'src/strings.test.ts': "it('trims', () => {});\n",
    'svc/calc_test.go': 'package calc\n\nfunc TestAdd(t *testing.T) {}\n',
  }),
  truncated: false,
};

const ids = {
  adds: 'vitest:::src/math.test.ts::math > adds',
  breaks: 'vitest:::src/math.test.ts::math > breaks',
  trims: 'vitest:::src/strings.test.ts::trims',
};

const summary = (patch: Partial<TestRunSummary> = {}): TestRunSummary => ({
  runId: 'r1',
  projectId: 'p1',
  startedAt: 10,
  running: true,
  cancelled: false,
  passed: 0,
  failed: 0,
  skipped: 0,
  commands: ['pnpm exec vitest run'],
  errors: [],
  ...patch,
});

let emit: (event: TestRunEvent) => void = () => undefined;
const api = {
  discover: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  lastRun: vi.fn(),
  command: vi.fn(),
  onRunEvent: vi.fn((callback: (event: TestRunEvent) => void) => {
    emit = callback;
    return () => undefined;
  }),
};
const writeText = vi.fn((_text: string) => Promise.resolve());

function FailedCount(): React.JSX.Element {
  return <span data-testid="failed-count">{useTestsFailedCount('p1')}</span>;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <TestsTabActions project={project} />
          <FailedCount />
          <TestsSection project={project} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function send(event: TestRunEvent): void {
  act(() => emit(event));
}

function startRun(queued: string[] = [ids.adds, ids.breaks, ids.trims]): void {
  send({ type: 'started', runId: 'r1', projectId: 'p1', summary: summary(), queued });
}

function finishWithFailure(): void {
  send({
    type: 'results',
    runId: 'r1',
    projectId: 'p1',
    results: [
      {
        id: ids.adds,
        testProjectId: 'vitest:',
        file: 'src/math.test.ts',
        path: ['math', 'adds'],
        line: 2,
        status: 'passed',
        durationMs: 4,
      },
      {
        id: ids.breaks,
        testProjectId: 'vitest:',
        file: 'src/math.test.ts',
        path: ['math', 'breaks'],
        line: 3,
        status: 'failed',
        message: 'AssertionError: expected 1 to be 2',
        stack: '    at src/math.test.ts:3:9',
      },
      {
        id: ids.trims,
        testProjectId: 'vitest:',
        file: 'src/strings.test.ts',
        path: ['trims'],
        line: 1,
        status: 'skipped',
      },
    ],
  });
  send({
    type: 'done',
    runId: 'r1',
    projectId: 'p1',
    summary: summary({ running: false, passed: 1, failed: 1, skipped: 1 }),
  });
}

const row = (name: string): HTMLElement => {
  const label = screen.getByText(name, { selector: '[data-test-name]' });
  const element = label.closest('[role="treeitem"]');
  if (!element) throw new Error(`no row for ${name}`);
  return element as HTMLElement;
};

beforeEach(() => {
  useTestsStore.setState({ runs: {} });
  for (const fn of Object.values(api)) if ('mockReset' in fn) fn.mockReset();
  api.onRunEvent.mockImplementation((callback) => {
    emit = callback;
    return () => undefined;
  });
  api.discover.mockResolvedValue(discovery);
  api.lastRun.mockResolvedValue(null);
  api.run.mockResolvedValue(summary());
  api.cancel.mockResolvedValue(true);
  api.command.mockResolvedValue("pnpm exec vitest run src/math.test.ts -t '^(?:math breaks)$'");
  writeText.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  Object.assign(window, { runova: { tests: api, shell: { openPath: vi.fn() } } });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => cleanup());

describe('TestsSection', () => {
  it('shimmers while it looks for tests, then shows projects, files, suites and tests', async () => {
    let resolve: (value: TestDiscovery) => void = () => undefined;
    api.discover.mockReturnValue(new Promise((done) => (resolve = done)));
    renderSection();
    expect(screen.getByLabelText('Finding tests')).toBeTruthy();
    await act(async () => resolve(discovery));

    expect(await screen.findByText('Vitest', { selector: '[data-test-name]' })).toBeTruthy();
    for (const name of [
      'src/math.test.ts',
      'math',
      'adds',
      'breaks',
      'src/strings.test.ts',
      'trims',
      'Go · svc',
      'calc_test.go',
      'TestAdd',
    ]) {
      expect(screen.getByText(name, { selector: '[data-test-name]' })).toBeTruthy();
    }
    expect(screen.queryByLabelText('Finding tests')).toBeNull();
  });

  it('says so when a project has no tests, and looks again on refresh', async () => {
    api.discover.mockResolvedValue({ projects: [], tree: [], truncated: false });
    renderSection();
    expect(await screen.findByText('No tests found')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  });

  it('shows a retry when discovery fails', async () => {
    api.discover.mockRejectedValueOnce(new Error('EACCES'));
    renderSection();
    expect(await screen.findByText('Could not read the tests')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('adds', { selector: '[data-test-name]' })).toBeTruthy();
  });

  it('runs everything, a whole file, or a single test', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });

    fireEvent.click(screen.getByRole('button', { name: 'Run all tests' }));
    await waitFor(() => expect(api.run).toHaveBeenLastCalledWith('p1', []));

    fireEvent.click(
      within(row('src/math.test.ts')).getByRole('button', { name: 'Run src/math.test.ts' }),
    );
    await waitFor(() =>
      expect(api.run).toHaveBeenLastCalledWith('p1', [
        { testProjectId: 'vitest:', files: ['src/math.test.ts'] },
      ]),
    );

    fireEvent.click(within(row('breaks')).getByRole('button', { name: 'Run breaks' }));
    await waitFor(() =>
      expect(api.run).toHaveBeenLastCalledWith('p1', [
        {
          testProjectId: 'vitest:',
          tests: [{ file: 'src/math.test.ts', path: ['math', 'breaks'] }],
        },
      ]),
    );

    fireEvent.click(within(row('Go · svc')).getByRole('button', { name: 'Run Go · svc' }));
    await waitFor(() =>
      expect(api.run).toHaveBeenLastCalledWith('p1', [{ testProjectId: 'go:svc' }]),
    );
  });

  it('shows a failed run with a toast when the run cannot start', async () => {
    api.run.mockRejectedValueOnce(new Error('Tests are already running for this project.'));
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    fireEvent.click(screen.getByRole('button', { name: 'Run all tests' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not run tests', {
        description: 'Tests are already running for this project.',
      }),
    );
  });

  it('follows a run live: running, then results, failures opened with their error, and a failed count', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    expect(within(row('adds')).getByLabelText('Running')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop tests' })).toBeTruthy();
    expect(screen.getByText(/Running 3 tests/)).toBeTruthy();

    finishWithFailure();
    expect(within(row('adds')).getByLabelText('Passed')).toBeTruthy();
    expect(within(row('breaks')).getByLabelText('Failed')).toBeTruthy();
    expect(within(row('trims')).getByLabelText('Skipped')).toBeTruthy();
    expect(within(row('src/math.test.ts')).getByLabelText('Failed')).toBeTruthy();
    expect(screen.getByText('AssertionError: expected 1 to be 2')).toBeTruthy();
    expect(screen.getByTestId('failed-count').textContent).toBe('1');
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText('1 passed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop tests' })).toBeNull();
  });

  it('still shows the run going after the tab is closed and opened again', async () => {
    const view = renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    expect(screen.getByText(/Running 3 tests/)).toBeTruthy();

    // The run carries on in the background while another tab is open, and one test finishes.
    api.lastRun.mockResolvedValue({
      summary: summary(),
      results: [
        {
          id: ids.adds,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'adds'],
          status: 'passed',
          durationMs: 4,
        },
      ],
      output: '$ pnpm exec vitest run',
      queued: [ids.adds, ids.breaks, ids.trims],
    } satisfies TestRunSnapshot);
    view.unmount();
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });

    // Coming back must not leave the tests still going looking as if they had never run.
    await waitFor(() => expect(within(row('adds')).getByLabelText('Passed')).toBeTruthy());
    expect(within(row('breaks')).getByLabelText('Running')).toBeTruthy();
    expect(within(row('trims')).getByLabelText('Running')).toBeTruthy();
    expect(screen.getByText(/Running 2 tests/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop tests' })).toBeTruthy();
  });

  it('counts the run up while it goes and stops the clock when it is over', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      send({
        type: 'started',
        runId: 'r1',
        projectId: 'p1',
        summary: summary({ startedAt: 100_000 }),
        queued: [ids.adds],
      });
      expect(screen.getByLabelText('Elapsed time').textContent).toBe('0:00');

      act(() => vi.advanceTimersByTime(65_000));
      expect(screen.getByLabelText('Elapsed time').textContent).toBe('1:05');

      send({
        type: 'done',
        runId: 'r1',
        projectId: 'p1',
        summary: summary({ startedAt: 100_000, running: false, finishedAt: 190_000 }),
      });
      act(() => vi.advanceTimersByTime(210_000));
      expect(screen.getByLabelText('Elapsed time').textContent).toBe('1:30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a run that is going', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    fireEvent.click(screen.getByRole('button', { name: 'Stop tests' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('p1'));
  });

  it('filters to failures and by name', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();

    fireEvent.click(screen.getByRole('radio', { name: /Failed/ }));
    expect(screen.queryByText('adds', { selector: '[data-test-name]' })).toBeNull();
    expect(screen.queryByText('trims', { selector: '[data-test-name]' })).toBeNull();
    expect(screen.getByText('breaks', { selector: '[data-test-name]' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter tests' }), {
      target: { value: 'trim' },
    });
    expect(screen.getByText('trims', { selector: '[data-test-name]' })).toBeTruthy();
    expect(screen.queryByText('adds', { selector: '[data-test-name]' })).toBeNull();
  });

  it('copies an issue with the command that reruns the test', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    fireEvent.click(screen.getByRole('button', { name: 'Copy issue' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(api.command).toHaveBeenCalledWith('p1', {
      testProjectId: 'vitest:',
      tests: [{ file: 'src/math.test.ts', path: ['math', 'breaks'] }],
    });
    const text = writeText.mock.calls[0][0];
    expect(text).toContain('Failing test: math > breaks');
    expect(text).toContain('File: src/math.test.ts:3');
    expect(text).toContain("Run it: pnpm exec vitest run src/math.test.ts -t '^(?:math breaks)$'");
    expect(text).toContain('AssertionError: expected 1 to be 2');
    expect(toast.success).toHaveBeenCalledWith('Issue copied');
  });

  it('says so when the clipboard refuses the copy', async () => {
    writeText.mockRejectedValueOnce(new Error('Document is not focused'));
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    fireEvent.click(screen.getByRole('button', { name: 'Copy issue' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not copy the issue', {
        description: 'Document is not focused',
      }),
    );
  });

  it('opens Fix with AI with a prompt about the failing test', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'math > breaks failure' })).getByRole('button', {
        name: 'Fix with AI',
      }),
    );
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toContain(
      'A test is failing in this repository: math > breaks (src/math.test.ts:3, Vitest).',
    );
    expect(prompt.value).toContain('AssertionError: expected 1 to be 2');
  });

  it('offers to fix every failure at once when several failed', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    expect(screen.queryByRole('button', { name: 'Fix all failures with AI' })).toBeNull();
    send({
      type: 'started',
      runId: 'r2',
      projectId: 'p1',
      summary: summary({ runId: 'r2' }),
      queued: [],
    });
    send({
      type: 'results',
      runId: 'r2',
      projectId: 'p1',
      results: [
        {
          id: ids.adds,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'adds'],
          status: 'failed',
          message: 'first',
        },
        {
          id: ids.breaks,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'breaks'],
          status: 'failed',
          message: 'second',
        },
      ],
    });
    send({
      type: 'done',
      runId: 'r2',
      projectId: 'p1',
      summary: summary({ runId: 'r2', running: false, failed: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fix all failures with AI' }));
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toContain('2 tests are failing in this repository:');
  });

  it('keeps the run counts and the run buttons on separate rows, with short labels', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    send({
      type: 'started',
      runId: 'r2',
      projectId: 'p1',
      summary: summary({ runId: 'r2' }),
      queued: [],
    });
    send({ type: 'output', runId: 'r2', projectId: 'p1', text: '$ pnpm exec vitest run\n' });
    send({
      type: 'results',
      runId: 'r2',
      projectId: 'p1',
      results: [
        {
          id: ids.adds,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'adds'],
          status: 'failed',
          message: 'one',
        },
        {
          id: ids.breaks,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'breaks'],
          status: 'failed',
          message: 'two',
        },
      ],
    });
    send({
      type: 'done',
      runId: 'r2',
      projectId: 'p1',
      summary: summary({ runId: 'r2', running: false, failed: 2 }),
    });

    const actions = screen.getByRole('group', { name: 'Test run actions' });
    const counts = screen.getByRole('group', { name: 'Test run counts' });
    for (const name of ['Run failed tests', 'Fix all failures with AI', 'Show output']) {
      expect(within(actions).getByRole('button', { name })).toBeTruthy();
      expect(within(counts).queryByRole('button', { name })).toBeNull();
    }
    expect(within(counts).getByText('2 failed')).toBeTruthy();
    expect(actions.textContent).not.toContain('failed tests');
    // Short visible text so nothing wraps in a narrow panel; the full name stays for screen readers.
    expect(within(actions).getByRole('button', { name: 'Run failed tests' }).textContent).toBe(
      'Run failed',
    );
    expect(
      within(actions).getByRole('button', { name: 'Fix all failures with AI' }).textContent,
    ).toBe('Fix all with AI');
    expect(within(actions).getByRole('button', { name: 'Show output' }).textContent).toBe('Output');
  });

  it('reruns only the failed tests', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    finishWithFailure();
    fireEvent.click(screen.getByRole('button', { name: 'Run failed tests' }));
    await waitFor(() =>
      expect(api.run).toHaveBeenLastCalledWith('p1', [
        {
          testProjectId: 'vitest:',
          tests: [{ file: 'src/math.test.ts', path: ['math', 'breaks'] }],
        },
      ]),
    );
  });

  it('explains a run that could not finish, with its output and a fix', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    send({ type: 'started', runId: 'r1', projectId: 'p1', summary: summary(), queued: [] });
    send({
      type: 'done',
      runId: 'r1',
      projectId: 'p1',
      summary: summary({
        running: false,
        errors: [
          {
            kind: 'noResults',
            testProjectId: 'go:svc',
            command: 'go test -json ./...',
            message: 'The Go run ended without reporting any results (exit code 1).',
            log: 'calc.go:3:1: syntax error',
          },
        ],
      }),
    });
    const card = screen.getByRole('group', { name: 'Go · svc could not run' });
    expect(
      within(card).getByText('The Go run ended without reporting any results (exit code 1).'),
    ).toBeTruthy();
    expect(within(card).getByText(/calc.go:3:1: syntax error/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Copy output' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('go test -json ./...')),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Fix with AI' }));
    const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
    expect(prompt.value).toContain('The Go tests in this repository could not run to completion.');
  });

  it('counts projects that could not run as failures next to failed tests', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    startRun();
    send({
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [
        {
          id: ids.breaks,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'breaks'],
          status: 'failed',
          message: 'AssertionError: expected 1 to be 2',
        },
        {
          id: ids.adds,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'adds'],
          status: 'passed',
        },
      ],
    });
    send({
      type: 'done',
      runId: 'r1',
      projectId: 'p1',
      summary: summary({
        running: false,
        errors: [
          {
            kind: 'noResults',
            testProjectId: 'go:svc',
            command: 'go test -json ./...',
            message: 'The Go run ended without reporting any results (exit code 1).',
            log: '',
          },
          {
            kind: 'timedOut',
            testProjectId: 'dotnet:srv',
            command: 'dotnet test',
            message: 'The .NET run took longer than 30 minutes and was stopped.',
            log: '',
          },
        ],
      }),
    });

    const counts = screen.getByRole('group', { name: 'Test run counts' });
    expect(within(counts).getByText('3 failed')).toBeTruthy();
    expect(screen.getByTestId('failed-count').textContent).toBe('3');
    expect(screen.getByRole('radio', { name: /Failed\s*3/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /Failed\s*3/ }));
    expect(screen.getByRole('group', { name: 'Go · svc could not run' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'dotnet:srv could not run' })).toBeTruthy();
    expect(screen.getByText('breaks', { selector: '[data-test-name]' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /Passed/ }));
    expect(screen.queryByRole('group', { name: 'Go · svc could not run' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'dotnet:srv could not run' })).toBeNull();
  });

  describe('when test projects could not run', () => {
    const goError = {
      kind: 'noResults',
      testProjectId: 'go:svc',
      command: 'go test -json ./...',
      message: 'The Go run ended without reporting any results (exit code 1).',
      log: '',
    } as const;
    const dotnetError = {
      kind: 'timedOut',
      testProjectId: 'dotnet:srv',
      command: 'dotnet test',
      message: 'The .NET run took longer than 30 minutes and was stopped.',
      log: '',
    } as const;
    const breaks: TestResult = {
      id: ids.breaks,
      testProjectId: 'vitest:',
      file: 'src/math.test.ts',
      path: ['math', 'breaks'],
      status: 'failed',
      message: 'AssertionError: expected 1 to be 2',
    };

    function finishWith(errors: TestRunSummary['errors'], failed: TestResult[] = []): void {
      startRun();
      if (failed.length > 0) {
        send({ type: 'results', runId: 'r1', projectId: 'p1', results: [...failed] });
      }
      send({
        type: 'done',
        runId: 'r1',
        projectId: 'p1',
        summary: summary({ running: false, errors }),
      });
    }

    it('offers to run them again and to fix them all, with no failed test at all', async () => {
      renderSection();
      await screen.findByText('adds', { selector: '[data-test-name]' });
      finishWith([goError, dotnetError]);

      const actions = screen.getByRole('group', { name: 'Test run actions' });
      fireEvent.click(within(actions).getByRole('button', { name: 'Run failed tests' }));
      await waitFor(() =>
        expect(api.run).toHaveBeenLastCalledWith('p1', [
          { testProjectId: 'go:svc' },
          { testProjectId: 'dotnet:srv' },
        ]),
      );

      fireEvent.click(within(actions).getByRole('button', { name: 'Fix all failures with AI' }));
      const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
      expect(prompt.value).toContain('could not run to completion');
      expect(prompt.value).toContain('Command: go test -json ./...');
      expect(prompt.value).toContain('Command: dotnet test');
      expect(screen.getByText('Fix 2 failures with AI')).toBeTruthy();
      expect(screen.getByText('Go · svc, dotnet:srv')).toBeTruthy();
    });

    it('reruns the failed tests and the projects that could not run together', async () => {
      renderSection();
      await screen.findByText('adds', { selector: '[data-test-name]' });
      finishWith([goError, dotnetError], [breaks]);

      fireEvent.click(screen.getByRole('button', { name: 'Run failed tests' }));
      await waitFor(() =>
        expect(api.run).toHaveBeenLastCalledWith('p1', [
          {
            testProjectId: 'vitest:',
            tests: [{ file: 'src/math.test.ts', path: ['math', 'breaks'] }],
          },
          { testProjectId: 'go:svc' },
          { testProjectId: 'dotnet:srv' },
        ]),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Fix all failures with AI' }));
      const prompt = (await screen.findByLabelText('Fix prompt')) as HTMLTextAreaElement;
      expect(prompt.value).toContain('A test is failing in this repository: math > breaks');
      expect(prompt.value).toContain('Some test runs could not finish:');
      expect(prompt.value).toContain('Command: dotnet test');
    });

    it('reruns a project that failed tests and then broke as a whole, once', async () => {
      renderSection();
      await screen.findByText('adds', { selector: '[data-test-name]' });
      finishWith([{ ...goError, testProjectId: 'vitest:' }], [breaks]);

      fireEvent.click(screen.getByRole('button', { name: 'Run failed tests' }));
      await waitFor(() =>
        expect(api.run).toHaveBeenLastCalledWith('p1', [{ testProjectId: 'vitest:' }]),
      );
    });

    it('lets a single one be run again, but leaves "Fix all" to cases with several', async () => {
      renderSection();
      await screen.findByText('adds', { selector: '[data-test-name]' });
      finishWith([goError]);

      expect(screen.getByRole('button', { name: 'Run failed tests' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Fix all failures with AI' })).toBeNull();
    });

    it('leaves a missing runner out of "Fix all", as its card has no fix either', async () => {
      renderSection();
      await screen.findByText('adds', { selector: '[data-test-name]' });
      finishWith([{ ...goError, kind: 'notFound' }, dotnetError]);

      expect(screen.getByRole('button', { name: 'Run failed tests' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Fix all failures with AI' })).toBeNull();
    });
  });

  it('points at installing the runner when it is missing, without a fix button', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    send({ type: 'started', runId: 'r1', projectId: 'p1', summary: summary(), queued: [] });
    send({
      type: 'done',
      runId: 'r1',
      projectId: 'p1',
      summary: summary({
        running: false,
        errors: [
          {
            kind: 'notFound',
            testProjectId: 'go:svc',
            command: 'go test -json ./...',
            message:
              'Could not start Go. Check that it is installed and on your PATH, then run the tests again.',
            log: "'go' is not recognized as an internal or external command",
          },
        ],
      }),
    });
    const card = screen.getByRole('group', { name: 'Go · svc could not run' });
    expect(within(card).getByText(/Check that it is installed/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Fix with AI' })).toBeNull();
  });

  it('picks up the last run kept by the app when it opens', async () => {
    const snapshot: TestRunSnapshot = {
      summary: summary({ running: false, failed: 1 }),
      results: [
        {
          id: ids.breaks,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'breaks'],
          status: 'failed',
          message: 'from before',
        },
      ],
      output: '$ pnpm exec vitest run\nFAIL',
      queued: [],
    };
    api.lastRun.mockResolvedValue(snapshot);
    renderSection();
    await waitFor(() => expect(within(row('breaks')).getByLabelText('Failed')).toBeTruthy());
    expect(screen.getByText('from before')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByLabelText('Test output').textContent).toContain('FAIL');
  });

  it('shows results the discovery did not know about, like a parameter case', async () => {
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    send({ type: 'started', runId: 'r1', projectId: 'p1', summary: summary(), queued: [] });
    send({
      type: 'results',
      runId: 'r1',
      projectId: 'p1',
      results: [
        {
          id: `${ids.adds} > case 2`,
          testProjectId: 'vitest:',
          file: 'src/math.test.ts',
          path: ['math', 'adds', 'case 2'],
          status: 'failed',
          message: 'bad case',
        },
      ],
    });
    // Results reach the panel in short batches, not one render per event.
    await waitFor(() => expect(within(row('case 2')).getByLabelText('Failed')).toBeTruthy());
  });

  it('opens a test file in the editor', async () => {
    const openFile = vi.fn();
    const { useWorkspaceStore } = await import('@/stores/workspaceStore');
    useWorkspaceStore.setState({ openFile } as never);
    renderSection();
    await screen.findByText('adds', { selector: '[data-test-name]' });
    fireEvent.click(
      within(row('src/math.test.ts')).getByRole('button', { name: 'Open src/math.test.ts' }),
    );
    expect(openFile).toHaveBeenCalledWith('p1', 'C:\\work\\app\\src\\math.test.ts', { pin: true });
  });
});
