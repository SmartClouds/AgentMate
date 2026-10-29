import type { Project } from '@runova/core';
import type {
  GithubJobLogInput,
  GithubLogLine,
  GithubRunJob,
  GithubRunStep,
  GithubStepLog,
} from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('./FixStepDialog', () => ({
  FixStepDialog: ({
    open,
    target,
    failed,
  }: {
    open: boolean;
    target: { stepName: string };
    failed: boolean;
  }) =>
    open ? <div role="dialog">{`fix ${target.stepName}${failed ? ' (failed)' : ''}`}</div> : null,
}));

const { RunJobs, summarizeJobs } = await import('./RunJobs');

const NOW = Date.parse('2026-03-15T09:10:00Z');
const openExternal = vi.fn();

function step(overrides: Partial<GithubRunStep> & Pick<GithubRunStep, 'number' | 'name'>) {
  return {
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:00:02Z',
    ...overrides,
  } satisfies GithubRunStep;
}

function job(overrides: Partial<GithubRunJob> & Pick<GithubRunJob, 'id' | 'name'>): GithubRunJob {
  return {
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:04:35Z',
    htmlUrl: `https://github.com/acme/app/actions/runs/1/job/${overrides.id}`,
    runnerName: 'GitHub Actions 3',
    steps: [step({ number: 1, name: 'Set up job' }), step({ number: 2, name: 'Run build' })],
    ...overrides,
  };
}

const PASSED = job({ id: 1, name: 'build' });
const FAILED = job({
  id: 2,
  name: 'test',
  conclusion: 'failure',
  steps: [
    step({ number: 1, name: 'Set up job' }),
    step({
      number: 2,
      name: 'Run tests',
      conclusion: 'failure',
      completedAt: '2026-03-15T09:04:30Z',
    }),
    step({
      number: 3,
      name: 'Upload report',
      conclusion: 'skipped',
      startedAt: null,
      completedAt: null,
    }),
  ],
});

function renderJobs(jobs: GithubRunJob[]) {
  return renderWithProviders(<RunJobs jobs={jobs} now={NOW} />, {
    bridge: { 'shell.openExternal': openExternal },
  });
}

/** Steps are buttons too, so a job's toggle is matched by the name its label starts with. */

beforeEach(() => {
  vi.clearAllMocks();
});

/** The button that folds a job. Its name starts with the job's own name, then its outcome. */
function toggle(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}, `) });
}

describe('RunJobs', () => {
  it('lists each job with its outcome and how long it took', () => {
    renderJobs([PASSED, FAILED]);

    const build = toggle('build');
    expect(within(build).getByText('Passed')).toBeInTheDocument();
    expect(within(build).getByText('4m 35s')).toBeInTheDocument();
    const test = toggle('test');
    expect(within(test).getByText('Failed')).toBeInTheDocument();
  });

  it('opens the failed job on its steps and keeps the passed one folded', () => {
    renderJobs([PASSED, FAILED]);

    expect(toggle('build')).toHaveAttribute('aria-expanded', 'false');
    expect(toggle('test')).toHaveAttribute('aria-expanded', 'true');

    const steps = screen.getByRole('list', { name: 'test steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('list', { name: 'build steps' })).not.toBeInTheDocument();
  });

  it('shows each step in order with its number, outcome and duration', () => {
    renderJobs([FAILED, PASSED]);

    const [setUp, runTests, upload] = within(
      screen.getByRole('list', { name: 'test steps' }),
    ).getAllByRole('listitem');
    expect(setUp).toHaveTextContent('1');
    expect(setUp).toHaveTextContent('Set up job');
    expect(setUp).toHaveTextContent('2s');
    expect(within(runTests as HTMLElement).getByText('Failed')).toBeInTheDocument();
    expect(runTests).toHaveTextContent('4m 30s');
    // A skipped step never ran, so it has no time to show.
    expect(within(upload as HTMLElement).getByText('Skipped')).toBeInTheDocument();
    expect(upload).not.toHaveTextContent(/\ds$/);
  });

  it('marks the failed step so it stands out from the rest', () => {
    renderJobs([FAILED, PASSED]);
    const items = within(screen.getByRole('list', { name: 'test steps' })).getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('data-failed', 'true');
    expect(items[0]).not.toHaveAttribute('data-failed');
  });

  it('folds and unfolds a job on click', async () => {
    const { user } = renderJobs([PASSED, FAILED]);

    await user.click(toggle('build'));
    expect(screen.getByRole('list', { name: 'build steps' })).toBeInTheDocument();
    expect(toggle('build')).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle('build'));
    expect(screen.queryByRole('list', { name: 'build steps' })).not.toBeInTheDocument();
  });

  it('puts failed jobs first, then running and queued ones, and keeps GitHub’s order otherwise', () => {
    const queued = job({
      id: 8,
      name: 'queued-job',
      status: 'queued',
      conclusion: null,
      steps: [],
    });
    const running = job({ id: 9, name: 'running-job', status: 'in_progress', conclusion: null });
    const lateFailure = job({ id: 10, name: 'late-failure', conclusion: 'failure' });
    const timedOut = job({ id: 11, name: 'timed-out', conclusion: 'timed_out' });
    const passedA = job({ id: 12, name: 'passed-a' });
    const passedB = job({ id: 13, name: 'passed-b' });

    renderJobs([passedA, queued, passedB, running, lateFailure, timedOut]);

    const order = screen
      .getAllByRole('button', { name: /^(?!Open |Step ).*, / })
      .map((button) => button.getAttribute('aria-label')?.split(',')[0]);
    expect(order).toEqual([
      'late-failure',
      'timed-out',
      'running-job',
      'queued-job',
      'passed-a',
      'passed-b',
    ]);
  });

  it('opens a lone job even when it passed, since there is nothing else to look at', () => {
    renderJobs([PASSED]);
    expect(screen.getByRole('list', { name: 'build steps' })).toBeInTheDocument();
  });

  it('counts a running job up to now, and leaves a queued step without a time', () => {
    renderJobs([
      job({
        id: 3,
        name: 'deploy',
        status: 'in_progress',
        conclusion: null,
        startedAt: '2026-03-15T09:07:00Z',
        completedAt: null,
        steps: [
          step({ number: 1, name: 'Set up job' }),
          step({
            number: 2,
            name: 'Deploy',
            status: 'in_progress',
            conclusion: null,
            startedAt: '2026-03-15T09:08:30Z',
            completedAt: null,
          }),
          step({
            number: 3,
            name: 'Smoke test',
            status: 'queued',
            conclusion: null,
            startedAt: null,
            completedAt: null,
          }),
        ],
      }),
      PASSED,
    ]);

    // The running job starts open, and its clock runs to the "now" the list was given.
    const deploy = toggle('deploy');
    expect(within(deploy).getByText('Running')).toBeInTheDocument();
    expect(within(deploy).getByText('3m 0s')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'deploy steps' })).getAllByRole(
      'listitem',
    );
    expect(steps[1]).toHaveTextContent('1m 30s');
    expect(within(steps[2] as HTMLElement).getByText('Queued')).toBeInTheDocument();
    expect(steps[2]).not.toHaveTextContent(/\ds$/);
  });

  it('keeps a job the user folded folded when the jobs refresh', async () => {
    function Harness(): React.JSX.Element {
      const [jobs, setJobs] = useState([PASSED, FAILED]);
      return (
        <>
          <button type="button" onClick={() => setJobs([PASSED, { ...FAILED }])}>
            refresh
          </button>
          <RunJobs jobs={jobs} now={NOW} />
        </>
      );
    }
    const { user } = renderWithProviders(<Harness />, {
      bridge: { 'shell.openExternal': openExternal },
    });

    await user.click(toggle('test'));
    expect(screen.queryByRole('list', { name: 'test steps' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'refresh' }));

    expect(screen.queryByRole('list', { name: 'test steps' })).not.toBeInTheDocument();
  });

  it('opens a job on GitHub from its own link, without folding it', async () => {
    const { user } = renderJobs([PASSED, FAILED]);

    await user.click(screen.getByRole('button', { name: 'Open test on GitHub' }));

    expect(openExternal).toHaveBeenCalledWith(FAILED.htmlUrl);
    expect(toggle('test')).toHaveAttribute('aria-expanded', 'true');
  });

  it('has no link for a job GitHub gave no page for', () => {
    renderJobs([job({ id: 4, name: 'lint', htmlUrl: null })]);
    expect(screen.queryByRole('button', { name: 'Open lint on GitHub' })).not.toBeInTheDocument();
  });

  it('says a job has no steps when it has none', () => {
    renderJobs([job({ id: 5, name: 'empty', steps: [] })]);
    expect(screen.getByText('No steps yet.')).toBeInTheDocument();
  });
});

describe('summarizeJobs', () => {
  it('counts what failed, ran and passed, worst first', () => {
    const running = job({ id: 3, name: 'x', status: 'in_progress', conclusion: null });
    expect(summarizeJobs([PASSED, FAILED, running, PASSED])).toBe(
      '1 failed · 1 running · 2 passed',
    );
  });

  it('is plain about a single job and an empty list', () => {
    expect(summarizeJobs([PASSED])).toBe('1 passed');
    expect(summarizeJobs([])).toBe('');
  });

  it('counts skipped and cancelled jobs separately from failures', () => {
    const skipped = job({ id: 6, name: 's', conclusion: 'skipped' });
    const cancelled = job({ id: 7, name: 'c', conclusion: 'cancelled' });
    expect(summarizeJobs([skipped, cancelled])).toBe('1 cancelled · 1 skipped');
  });
});

describe('RunJobs step logs', () => {
  const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
  const RUN = { workflowName: 'CI', displayTitle: 'Add login', runNumber: 7, headBranch: 'main' };

  function lines(...items: [GithubLogLine['kind'], string][]): GithubLogLine[] {
    return items.map(([kind, text]) => ({ kind, text }));
  }

  function stepLog(number: number, items: GithubLogLine[]): GithubStepLog {
    return {
      number,
      lines: items,
      errors: items.filter((line) => line.kind === 'error').length,
      warnings: items.filter((line) => line.kind === 'warning').length,
    };
  }

  /** The logs GitHub would hand back, per job. */
  const LOGS: Record<number, GithubStepLog[]> = {
    1: [
      stepLog(1, lines(['plain', 'Current runner version: 2.320.0'])),
      stepLog(
        2,
        lines(
          ['group', 'Run pnpm build'],
          ['warning', 'Unused variable x'],
          ['warning', 'Unused variable y'],
          ['plain', 'built in 3s'],
        ),
      ),
    ],
    2: [
      stepLog(1, []),
      stepLog(
        2,
        lines(
          ['group', 'Run pnpm test'],
          ['command', '/usr/bin/pnpm test'],
          ['plain', 'login.test.ts'],
          ['error', 'expected 200, got 500'],
        ),
      ),
      stepLog(3, []),
    ],
  };

  function renderLogs(
    jobs: GithubRunJob[],
    {
      withProject = true,
      jobLog = async (input: GithubJobLogInput) => ({ ok: true, steps: LOGS[input.jobId] ?? [] }),
    }: { withProject?: boolean; jobLog?: (input: GithubJobLogInput) => Promise<unknown> } = {},
  ) {
    return renderWithProviders(
      <RunJobs
        jobs={jobs}
        now={NOW}
        repo="acme/app"
        project={withProject ? project : undefined}
        run={RUN}
      />,
      { bridge: { 'shell.openExternal': openExternal, 'pipelines.jobLog': jobLog } },
    );
  }

  function stepButton(name: string): HTMLElement {
    return screen.getByRole('button', { name: new RegExp(`^Step \\d+: ${name}, `) });
  }

  function logOf(name: string): HTMLElement {
    return screen.getByRole('region', { name: `${name} log` });
  }

  it('turns each step that ran into a disclosure, and leaves skipped or queued ones plain', () => {
    renderLogs([FAILED]);

    expect(stepButton('Set up job')).toHaveAttribute('aria-expanded', 'false');
    expect(stepButton('Run tests')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: /Upload report/ })).not.toBeInTheDocument();
  });

  it('opens the failed step on its log, with the error line marked', async () => {
    renderLogs([FAILED]);

    const log = logOf('Run tests');
    const error = await within(log).findByText('expected 200, got 500');
    expect(error.closest('[data-kind]')).toHaveAttribute('data-kind', 'error');
    expect(within(log).getByText('Run pnpm test').closest('[data-kind]')).toHaveAttribute(
      'data-kind',
      'group',
    );
    expect(within(log).getByText('1 error')).toBeInTheDocument();
  });

  it('reads the job log once and shows every step from it', async () => {
    const { user, bridge } = renderLogs([FAILED]);

    await within(logOf('Run tests')).findByText('expected 200, got 500');
    await user.click(stepButton('Set up job'));

    expect(
      await within(logOf('Set up job')).findByText('This step printed nothing.'),
    ).toBeVisible();
    expect(bridge.$fn('pipelines.jobLog')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('pipelines.jobLog')).toHaveBeenCalledWith({
      repo: 'acme/app',
      jobId: 2,
      steps: FAILED.steps.map(({ number, conclusion, startedAt, completedAt }) => ({
        number,
        conclusion,
        startedAt,
        completedAt,
      })),
    });
  });

  it('folds a step log away again', async () => {
    const { user } = renderLogs([FAILED]);

    await user.click(stepButton('Run tests'));

    expect(stepButton('Run tests')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Run tests log' })).not.toBeInTheDocument();
  });

  it('does not read the log of a job that stays folded', () => {
    const { bridge } = renderLogs([PASSED, FAILED]);
    expect(bridge.$fn('pipelines.jobLog')).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1 }),
    );
  });

  it('copies a step log as plain text', async () => {
    const { user } = renderLogs([FAILED]);
    const log = logOf('Run tests');
    await within(log).findByText('expected 200, got 500');

    await user.click(within(log).getByRole('button', { name: 'Copy Run tests log' }));

    expect(await navigator.clipboard.readText()).toBe(
      'Run pnpm test\n/usr/bin/pnpm test\nlogin.test.ts\nexpected 200, got 500',
    );
    expect(toast.success).toHaveBeenCalledWith('Run tests log copied.');
  });

  it('offers Fix with AI on a failed step and opens the fix for it', async () => {
    const { user } = renderLogs([FAILED]);
    const log = logOf('Run tests');
    await within(log).findByText('expected 200, got 500');

    await user.click(within(log).getByRole('button', { name: 'Fix with AI' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('fix Run tests (failed)');
  });

  it('counts warnings on the step row and offers to fix them', async () => {
    const { user } = renderLogs([PASSED]);

    // The lone job starts open, so its log is read and the counts show before any step is opened.
    expect(await within(stepButton('Run build')).findByLabelText('2 warnings')).toBeVisible();
    await user.click(stepButton('Run build'));
    const log = logOf('Run build');
    expect(within(log).getByText('2 warnings')).toBeInTheDocument();
    expect(within(log).getByText('Unused variable x').closest('[data-kind]')).toHaveAttribute(
      'data-kind',
      'warning',
    );

    await user.click(within(log).getByRole('button', { name: 'Fix with AI' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('fix Run build');
  });

  it('has nothing to fix on a clean step', async () => {
    const { user } = renderLogs([PASSED]);
    await user.click(stepButton('Set up job'));
    const log = logOf('Set up job');
    await within(log).findByText('Current runner version: 2.320.0');
    expect(within(log).queryByRole('button', { name: 'Fix with AI' })).not.toBeInTheDocument();
  });

  it('leaves Fix with AI out when there is no project to fix it in', async () => {
    renderLogs([FAILED], { withProject: false });
    const log = logOf('Run tests');
    await within(log).findByText('expected 200, got 500');
    expect(within(log).queryByRole('button', { name: 'Fix with AI' })).not.toBeInTheDocument();
    expect(within(log).getByRole('button', { name: 'Copy Run tests log' })).toBeInTheDocument();
  });

  it('opens the step itself on GitHub', async () => {
    const { user } = renderLogs([FAILED]);
    await user.click(
      within(logOf('Run tests')).getByRole('button', { name: 'Open Run tests on GitHub' }),
    );
    expect(openExternal).toHaveBeenCalledWith(`${FAILED.htmlUrl}#step:2:1`);
  });

  it('waits for a running job to finish, pointing at the live log on GitHub instead', async () => {
    const running = job({
      id: 3,
      name: 'deploy',
      status: 'in_progress',
      conclusion: null,
      completedAt: null,
      steps: [
        step({
          number: 1,
          name: 'Deploy',
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
      ],
    });
    const jobLog = vi.fn();
    const { user } = renderLogs([running], { jobLog });

    await user.click(stepButton('Deploy'));

    const log = logOf('Deploy');
    expect(within(log).getByText('The log is ready once the job finishes.')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Watch it live on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(`${running.htmlUrl}#step:1:1`);
    expect(jobLog).not.toHaveBeenCalled();
  });

  it('says when the log could not be read, and tries again on Retry', async () => {
    const jobLog = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 410: Gone' })
      .mockResolvedValue({ ok: true, steps: LOGS[2] });
    const { user } = renderLogs([FAILED], { jobLog });

    const log = logOf('Run tests');
    expect(await within(log).findByText('Could not load this log.')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Retry' }));

    expect(await within(logOf('Run tests')).findByText('expected 200, got 500')).toBeVisible();
    expect(jobLog).toHaveBeenCalledTimes(2);
  });

  it('keeps an opened step open when the jobs refresh', async () => {
    function Harness(): React.JSX.Element {
      const [jobs, setJobs] = useState([FAILED]);
      return (
        <>
          <button type="button" onClick={() => setJobs([{ ...FAILED }])}>
            refresh
          </button>
          <RunJobs jobs={jobs} now={NOW} repo="acme/app" project={project} run={RUN} />
        </>
      );
    }
    const { user } = renderWithProviders(<Harness />, {
      bridge: {
        'pipelines.jobLog': async (input: GithubJobLogInput) => ({
          ok: true,
          steps: LOGS[input.jobId],
        }),
      },
    });

    await user.click(stepButton('Set up job'));
    await user.click(screen.getByRole('button', { name: 'refresh' }));

    expect(stepButton('Set up job')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps steps as plain rows when it does not know the repo to read logs from', () => {
    renderJobs([FAILED]);
    expect(screen.queryByRole('button', { name: /^Step / })).not.toBeInTheDocument();
  });

  it('jumps to the first error from its count and highlights it', async () => {
    const { user } = renderLogs([FAILED]);
    const log = logOf('Run tests');
    const error = await within(log).findByText('expected 200, got 500');

    await user.click(within(log).getByRole('button', { name: '1 error' }));

    expect(error.closest('[data-kind]')).toHaveAttribute('data-current', 'true');
  });
});
