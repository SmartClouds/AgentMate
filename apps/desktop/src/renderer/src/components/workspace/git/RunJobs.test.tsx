import type { GithubRunJob, GithubRunStep } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RunJobs, summarizeJobs } from './RunJobs';

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

beforeEach(() => {
  vi.clearAllMocks();
});

/** The button that folds a job. Its name starts with the outcome, unlike the "Open ... on GitHub" link. */
function toggle(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^(?!Open ).*\\b${name}\\b`) });
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
      .getAllByRole('button', { name: /^(?!Open ).*, / })
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
