import type { Project } from '@runova/core';
import type {
  GithubRunAnnotation,
  GithubRunJob,
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
} from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RunDetails } from './RunDetails';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
vi.mock('./FixStepDialog', () => ({
  FixStepDialog: ({
    open,
    project,
    target,
  }: {
    open: boolean;
    project: Project;
    target: Record<string, unknown>;
  }) =>
    open ? (
      <div role="dialog" aria-label="Fix step">
        {JSON.stringify({ project: project.id, ...target })}
      </div>
    ) : null,
}));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;

const workflow: GithubWorkflowInfo = {
  id: 1,
  name: 'CD',
  path: '.github/workflows/cd.yml',
  state: 'active',
  htmlUrl: 'https://github.com/acme/app/actions/workflows/cd.yml',
  badgeUrl: '',
  dispatchable: false,
  dispatchInputs: [],
};

const hoursAgo = (hours: number, extraSeconds = 0) =>
  new Date(Date.now() - hours * 3_600_000 + extraSeconds * 1000).toISOString();

const FAILED_RUN: GithubWorkflowRunInfo = {
  id: 100,
  workflowId: 1,
  name: 'CD',
  displayTitle: 'fix(desktop): stop click-swallow timer',
  runNumber: 7,
  headBranch: 'master',
  status: 'completed',
  conclusion: 'failure',
  htmlUrl: 'https://github.com/acme/app/actions/runs/100',
  createdAt: hoursAgo(3),
  updatedAt: hoursAgo(3, 252),
  event: 'push',
  actor: 'octo',
  headSha: 'abc1234def5678',
  runAttempt: 2,
};

const PASSED_RUN: GithubWorkflowRunInfo = {
  ...FAILED_RUN,
  id: 101,
  conclusion: 'success',
  runAttempt: 1,
};

const LIVE_RUN: GithubWorkflowRunInfo = {
  ...FAILED_RUN,
  id: 102,
  status: 'in_progress',
  conclusion: null,
  runAttempt: 1,
  updatedAt: hoursAgo(3),
};

function job(overrides: Partial<GithubRunJob> = {}): GithubRunJob {
  return {
    id: 11,
    name: 'deploy',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:04:35Z',
    htmlUrl: 'https://github.com/acme/app/actions/runs/100/job/11',
    runnerName: null,
    steps: [
      {
        number: 1,
        name: 'Run deploy',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-03-15T09:00:00Z',
        completedAt: '2026-03-15T09:04:30Z',
      },
    ],
    ...overrides,
  };
}

const annotation: GithubRunAnnotation = {
  level: 'warning',
  jobName: 'deploy',
  path: '.github',
  startLine: null,
  endLine: null,
  title: 'Deprecated',
  message: 'node 18 is old',
};

const openExternal = vi.fn();
const runDetails = vi.fn();
const runAnnotations = vi.fn();
const runError = vi.fn();

function renderDetails(run: GithubWorkflowRunInfo | null) {
  return renderWithProviders(
    <RunDetails project={project} repo="acme/app" workflow={workflow} run={run} />,
    {
      bridge: {
        'shell.openExternal': openExternal,
        'pipelines.runDetails': runDetails,
        'pipelines.runAnnotations': runAnnotations,
        'pipelines.runError': runError,
        'pipelines.cancelRun': { ok: true },
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runDetails.mockResolvedValue({ ok: true, jobs: [job()] });
  runAnnotations.mockResolvedValue({
    ok: true,
    annotations: [],
    counts: { failure: 0, warning: 0, notice: 0 },
  });
  runError.mockResolvedValue({ ok: true, text: 'Job: deploy\n  Step: Run deploy (failure)' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RunDetails header', () => {
  it('names the pipeline, the commit and how the run ended', async () => {
    renderDetails(FAILED_RUN);

    const pane = screen.getByRole('region', { name: 'CD details' });
    expect(within(pane).getByRole('heading', { name: 'CD' })).toBeInTheDocument();
    expect(within(pane).getByText('fix(desktop): stop click-swallow timer')).toBeInTheDocument();
    expect(within(pane).getByText('Failed')).toBeInTheDocument();
  });

  it('lists the branch, run number, attempt, trigger, author and commit', () => {
    renderDetails(FAILED_RUN);

    expect(screen.getByText('master')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('push')).toBeInTheDocument();
    expect(screen.getByText('by octo')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('leaves out what GitHub did not tell it, and the attempt of a first run', () => {
    renderDetails({
      ...PASSED_RUN,
      event: undefined,
      actor: undefined,
      headSha: undefined,
      runAttempt: undefined,
    });

    expect(screen.queryByText(/Attempt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
    expect(screen.queryByText('push')).not.toBeInTheDocument();
  });

  it('says when it started and how long it took', () => {
    renderDetails(FAILED_RUN);
    expect(screen.getByText(/Started 3h ago/)).toHaveTextContent('took 4m 12s');
  });

  it('says how long a live run has been going instead', () => {
    renderDetails(LIVE_RUN);
    expect(screen.getByText(/Started 3h ago/)).toHaveTextContent(/running for/);
  });

  it('opens the run on GitHub', async () => {
    const { user } = renderDetails(FAILED_RUN);
    await user.click(screen.getByRole('button', { name: 'Open run on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(FAILED_RUN.htmlUrl);
  });

  it('offers Fix with AI and Copy error only on a failed run', () => {
    const failed = renderDetails(FAILED_RUN);
    expect(screen.getByRole('button', { name: /Fix with AI/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy error/ })).toBeInTheDocument();
    failed.unmount();

    renderDetails(PASSED_RUN);
    expect(screen.queryByRole('button', { name: /Fix with AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy error/ })).not.toBeInTheDocument();
  });

  it('offers Stop only while the run is still going', () => {
    const live = renderDetails(LIVE_RUN);
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
    live.unmount();

    renderDetails(FAILED_RUN);
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
  });
});

describe('RunDetails jobs', () => {
  it('shimmers while the jobs load, then lists them with a summary', async () => {
    let finish: (value: unknown) => void = () => undefined;
    runDetails.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    renderDetails(FAILED_RUN);

    expect(screen.getByTestId('run-jobs-loading')).toBeInTheDocument();

    await act(async () => finish({ ok: true, jobs: [job(), job({ id: 12, name: 'lint' })] }));

    const jobs = await screen.findByRole('region', { name: 'Jobs' });
    expect(within(jobs).getByText('2 failed')).toBeInTheDocument();
    expect(within(jobs).getByRole('button', { name: /^deploy/ })).toBeInTheDocument();
    expect(within(jobs).getByRole('button', { name: /^lint/ })).toBeInTheDocument();
    expect(screen.queryByTestId('run-jobs-loading')).not.toBeInTheDocument();
  });

  it('opens the failed step on its log and fixes it with the run it belongs to', async () => {
    const { user } = renderWithProviders(
      <RunDetails project={project} repo="acme/app" workflow={workflow} run={FAILED_RUN} />,
      {
        bridge: {
          'pipelines.runDetails': runDetails,
          'pipelines.runAnnotations': runAnnotations,
          'pipelines.runError': runError,
          'pipelines.jobLog': async () => ({
            ok: true,
            steps: [
              {
                number: 1,
                lines: [{ text: 'deploy refused: 401', kind: 'error' }],
                errors: 1,
                warnings: 0,
              },
            ],
          }),
        },
      },
    );

    const log = await screen.findByRole('region', { name: 'Run deploy log' });
    expect(await within(log).findByText('deploy refused: 401')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Fix with AI' }));

    expect(JSON.parse(screen.getByRole('dialog', { name: 'Fix step' }).textContent ?? '')).toEqual({
      project: 'p1',
      repo: 'acme/app',
      jobId: 11,
      jobName: 'deploy',
      stepNumber: 1,
      stepName: 'Run deploy',
      workflowName: 'CD',
      displayTitle: 'fix(desktop): stop click-swallow timer',
      runNumber: 7,
      headBranch: 'master',
    });
  });

  it('asks for the jobs of this run only', async () => {
    renderDetails(FAILED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(runDetails).toHaveBeenCalledTimes(1);
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100 });
  });

  it('explains a failed read, keeps the reason in a tooltip, and retries', async () => {
    runDetails.mockResolvedValueOnce({ ok: false, error: 'HTTP 403: Forbidden' });
    const { user } = renderDetails(FAILED_RUN);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the jobs from GitHub.');
    await user.hover(within(alert).getByText('Could not load the jobs from GitHub.'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('HTTP 403: Forbidden');

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('region', { name: 'Jobs' })).toBeInTheDocument();
    expect(runDetails).toHaveBeenCalledTimes(2);
  });

  it('says GitHub has not started a queued run’s jobs', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    renderDetails({ ...LIVE_RUN, status: 'queued' });
    expect(await screen.findByText('GitHub has not started any jobs yet.')).toBeInTheDocument();
  });

  it('says a finished run had no jobs', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    renderDetails({ ...PASSED_RUN });
    expect(await screen.findByText('No jobs ran for this run.')).toBeInTheDocument();
  });

  it('keeps a running job’s clock moving between reads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue({
      ok: true,
      jobs: [
        job({
          status: 'in_progress',
          conclusion: null,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          completedAt: null,
          steps: [],
        }),
      ],
    });
    renderDetails(LIVE_RUN);
    const button = await screen.findByRole('button', { name: /^deploy/ });
    const before = button.textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole('button', { name: /^deploy/ }).textContent).not.toBe(before);
  });
});

describe('RunDetails annotations', () => {
  it('shows what the run left behind', async () => {
    runAnnotations.mockResolvedValue({
      ok: true,
      annotations: [annotation],
      counts: { failure: 0, warning: 1, notice: 0 },
    });
    renderDetails(FAILED_RUN);

    const section = await screen.findByRole('region', { name: 'Annotations' });
    expect(within(section).getByRole('button', { name: /1 warning/ })).toBeInTheDocument();
  });

  it('leaves the section out when there is nothing', async () => {
    renderDetails(FAILED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    await waitFor(() => expect(runAnnotations).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Annotations' })).not.toBeInTheDocument();
  });

  it('does not look for annotations on a run that is still going', async () => {
    renderDetails(LIVE_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(runAnnotations).not.toHaveBeenCalled();
  });
});

describe('RunDetails failure output', () => {
  it('stays closed, and does not read the logs, until it is opened', async () => {
    renderDetails(FAILED_RUN);
    const toggle = await screen.findByRole('button', { name: /Failure output/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(runError).not.toHaveBeenCalled();
  });

  it('reads the failure when opened and shows it as text', async () => {
    const { user } = renderDetails(FAILED_RUN);

    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    const section = screen.getByRole('region', { name: 'Failure output' });
    expect(await within(section).findByText(/Step: Run deploy \(failure\)/)).toBeInTheDocument();
    expect(runError).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/app', runId: 100, workflowName: 'CD' }),
    );
  });

  it('shimmers while the failure loads', async () => {
    runError.mockImplementationOnce(() => new Promise(() => undefined));
    const { user } = renderDetails(FAILED_RUN);

    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    expect(screen.getByTestId('run-failure-loading')).toBeInTheDocument();
  });

  it('copies the failure', async () => {
    const { user } = renderDetails(FAILED_RUN);
    await user.click(await screen.findByRole('button', { name: /Failure output/ }));
    await screen.findByText(/Step: Run deploy/);

    await user.click(screen.getByRole('button', { name: 'Copy failure output' }));

    expect(await navigator.clipboard.readText()).toBe('Job: deploy\n  Step: Run deploy (failure)');
  });

  it('explains a failed read and retries it', async () => {
    runError.mockResolvedValueOnce({ ok: false, error: 'No error details were available.' });
    const { user } = renderDetails(FAILED_RUN);
    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    const section = screen.getByRole('region', { name: 'Failure output' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Could not read the failure.',
    );

    await user.click(within(section).getByRole('button', { name: 'Retry' }));

    expect(await within(section).findByText(/Step: Run deploy/)).toBeInTheDocument();
  });

  it('is not there for a run that passed', async () => {
    renderDetails(PASSED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(screen.queryByRole('region', { name: 'Failure output' })).not.toBeInTheDocument();
  });
});

describe('RunDetails for a pipeline that has never run', () => {
  it('says so and opens the workflow on GitHub', async () => {
    const { user } = renderDetails(null);

    expect(screen.getByText('This pipeline has not run yet.')).toBeInTheDocument();
    expect(runDetails).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open workflow on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(workflow.htmlUrl);
  });
});
