import type { Project } from '@agentmat/core';
import type { GithubWorkflowInfo, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { act, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTone } from '@/components/pipelines/runStatus';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { FailedRunActions, PipelinesSection } from './PipelinesSection';
import type { PipelineRow, PipelinesView } from './usePipelineStatus';

const mounts = vi.fn();
const unmounts = vi.fn();

vi.mock('./FixRunDialog', async () => {
  const React = await import('react');
  return {
    FixRunDialog: () => {
      React.useEffect(() => {
        mounts();
        return () => unmounts();
      }, []);
      return <div>fix dialog</div>;
    },
  };
});

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;

function workflow(id: number, name: string): GithubWorkflowInfo {
  return {
    id,
    name,
    path: `.github/workflows/${name.toLowerCase()}.yml`,
    state: 'active',
    htmlUrl: `https://github.com/acme/app/actions/workflows/${name.toLowerCase()}.yml`,
    badgeUrl: '',
    dispatchable: false,
    dispatchInputs: [],
  };
}

function row(
  id: number,
  name: string,
  state: Pick<GithubWorkflowRunInfo, 'status' | 'conclusion'> | null,
): PipelineRow {
  const run: GithubWorkflowRunInfo | null = state && {
    id: id * 100,
    workflowId: id,
    name,
    displayTitle: `${name} commit`,
    runNumber: id,
    headBranch: 'main',
    htmlUrl: `https://github.com/acme/app/actions/runs/${id * 100}`,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ...state,
  };
  return { workflow: workflow(id, name), run, tone: run ? runTone(run) : null };
}

const FAILED = { status: 'completed', conclusion: 'failure' } as const;
const PASSED = { status: 'completed', conclusion: 'success' } as const;

function ready(rows: PipelineRow[]): PipelinesView {
  return { kind: 'ready', rows, repo: 'acme/app' };
}

const onRetry = vi.fn();
const onOpenDetails = vi.fn();
const openExternal = vi.fn();

/** Holds the view in state so a test can change it without remounting the providers around it. */
let setViewFromTest: (view: PipelinesView) => void = () => undefined;

function Harness({ initial }: { initial: PipelinesView }): React.JSX.Element {
  const [view, setView] = useState(initial);
  setViewFromTest = setView;
  return (
    <PipelinesSection
      project={project}
      view={view}
      retrying={false}
      onRetry={onRetry}
      onOpenDetails={onOpenDetails}
    />
  );
}

function renderSection(view: PipelinesView) {
  const rendered = renderWithProviders(<Harness initial={view} />, {
    bridge: {
      'pipelines.runError': { ok: true, text: 'Job: test\n  Step: Run tests (failure)' },
      'shell.openExternal': openExternal,
    },
  });
  return { ...rendered, update: (next: PipelinesView) => act(() => setViewFromTest(next)) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PipelinesSection', () => {
  it('shimmers while the first read is in flight', () => {
    renderSection({ kind: 'loading' });
    expect(screen.getByTestId('pipelines-loading')).toBeInTheDocument();
  });

  it('shows a notice in place of the rows, and wires Retry to it', async () => {
    const { user } = renderSection({
      kind: 'notice',
      notice: { kind: 'error', error: 'rate limited' },
    });
    expect(screen.getByText('Could not load pipelines')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lists each pipeline with its latest run and outcome', () => {
    renderSection(ready([row(1, 'CD', FAILED), row(2, 'Nightly', PASSED), row(3, 'Docs', null)]));

    expect(screen.getByText('CD')).toBeInTheDocument();
    expect(screen.getByText('CD commit · main · 3h ago')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Never run')).toBeInTheDocument();
  });

  it('offers Fix with AI and Copy error on a failed run only', () => {
    renderSection(ready([row(1, 'CD', FAILED), row(2, 'Nightly', PASSED)]));

    expect(screen.getAllByRole('button', { name: /Fix with AI/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Copy error/ })).toHaveLength(1);
  });

  it('opens the details on that pipeline when its card is clicked, not GitHub', async () => {
    const { user } = renderSection(ready([row(1, 'CD', FAILED), row(2, 'Nightly', PASSED)]));

    await user.click(screen.getByRole('button', { name: /Nightly/ }));

    expect(onOpenDetails).toHaveBeenCalledWith(2);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the details for a pipeline that has never run', async () => {
    const { user } = renderSection(ready([row(3, 'Docs', null)]));

    await user.click(screen.getByRole('button', { name: /Docs/ }));

    expect(onOpenDetails).toHaveBeenCalledWith(3);
  });

  it('does not open the details when Fix with AI is pressed', async () => {
    const { user } = renderSection(ready([row(1, 'CD', FAILED)]));

    await user.click(screen.getByRole('button', { name: /Fix with AI/ }));

    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it('keeps an open Fix with AI dialog while the rows refresh underneath it', async () => {
    const { user, update } = renderSection(ready([row(1, 'CD', FAILED)]));
    await user.click(screen.getByRole('button', { name: /Fix with AI/ }));
    expect(await screen.findByText('fix dialog')).toBeInTheDocument();

    update(ready([row(1, 'CD', FAILED), row(2, 'Nightly', PASSED)]));

    expect(screen.getByText('fix dialog')).toBeInTheDocument();
    expect(screen.getByText('Nightly')).toBeInTheDocument();
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });
});

describe('FailedRunActions', () => {
  const run = { repo: 'acme/app', runId: 100, workflowName: 'CD' };

  it('copies the failure text and says so', async () => {
    const { user } = renderWithProviders(<FailedRunActions project={project} run={run} />, {
      bridge: {
        'pipelines.runError': { ok: true, text: 'Job: test\n  Step: Run tests (failure)' },
      },
    });

    await user.click(screen.getByRole('button', { name: /Copy error/ }));

    expect(await navigator.clipboard.readText()).toBe('Job: test\n  Step: Run tests (failure)');
    expect(toast.success).toHaveBeenCalledWith('Failure copied');
  });

  it('shows GitHub’s reason when the failure cannot be read', async () => {
    const { user } = renderWithProviders(<FailedRunActions project={project} run={run} />, {
      bridge: { 'pipelines.runError': { ok: false, error: 'Install the GitHub CLI.' } },
    });

    await user.click(screen.getByRole('button', { name: /Copy error/ }));

    expect(toast.error).toHaveBeenCalledWith('Install the GitHub CLI.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the buttons together in one row', () => {
    renderWithProviders(<FailedRunActions project={project} run={run} />);
    const group = screen.getByRole('button', { name: /Fix with AI/ }).parentElement as HTMLElement;
    expect(within(group).getAllByRole('button')).toHaveLength(2);
  });
});
