import type { Project } from '@agentmat/core';
import type { GithubRunJob, GithubWorkflowInfo, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTone } from '@/components/pipelines/runStatus';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PipelinesDialog } from './PipelinesDialog';
import type { PipelineRow, PipelinesState, PipelinesView } from './usePipelineStatus';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));

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

const CD = row(1, 'CD', FAILED);
const NIGHTLY = row(2, 'Nightly', PASSED);
const DOCS = row(3, 'Docs', null);

function job(name: string): GithubRunJob {
  return {
    id: name.length,
    name,
    status: 'completed',
    conclusion: 'success',
    startedAt: null,
    completedAt: null,
    htmlUrl: null,
    runnerName: null,
    steps: [],
  };
}

const refresh = vi.fn();
const retry = vi.fn();
const onOpenChange = vi.fn();
const openExternal = vi.fn();
const runDetails = vi.fn();

function ready(rows: PipelineRow[]): PipelinesView {
  return { kind: 'ready', rows, repo: 'acme/app' };
}

function stateOf(view: PipelinesView, extra: Partial<PipelinesState> = {}): PipelinesState {
  return { view, retry, retrying: false, refresh, fetching: false, ...extra };
}

let setStateFromTest: (state: PipelinesState) => void = () => undefined;

function Where(): React.JSX.Element {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function Harness({
  initial,
  workflowId,
}: {
  initial: PipelinesState;
  workflowId: number | null;
}): React.JSX.Element {
  const [state, setState] = useState(initial);
  setStateFromTest = setState;
  return (
    <>
      <PipelinesDialog
        project={project}
        open
        onOpenChange={onOpenChange}
        state={state}
        workflowId={workflowId}
      />
      <Where />
    </>
  );
}

function renderDialog(view: PipelinesView, workflowId: number | null = null) {
  const rendered = renderWithProviders(
    <Harness initial={stateOf(view)} workflowId={workflowId} />,
    {
      bridge: {
        'shell.openExternal': openExternal,
        'pipelines.runDetails': runDetails,
        'pipelines.runAnnotations': { ok: true, annotations: [], counts: {} },
      },
    },
  );
  return {
    ...rendered,
    update: (next: PipelinesView) => act(() => setStateFromTest(stateOf(next))),
  };
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Pipelines' });
}

beforeEach(() => {
  vi.clearAllMocks();
  runDetails.mockImplementation(({ runId }: { runId: number }) =>
    Promise.resolve({ ok: true, jobs: [job(`job-of-${runId}`)] }),
  );
});

describe('PipelinesDialog', () => {
  it('lists every pipeline with its latest run, in the order it is given', () => {
    renderDialog(ready([CD, NIGHTLY, DOCS]));

    const list = within(
      within(dialog()).getByRole('navigation', { name: 'Pipelines' }),
    ).getAllByRole('listitem');
    expect(list).toHaveLength(3);
    expect(list[0]).toHaveTextContent('CD');
    expect(list[0]).toHaveTextContent('CD commit · main · 3h ago');
    expect(list[0]).toHaveTextContent('Failed');
    expect(list[1]).toHaveTextContent('Nightly');
    expect(list[2]).toHaveTextContent('Never run');
    expect(within(dialog()).getByText('acme/app')).toBeInTheDocument();
  });

  it('opens on the first pipeline and reads only its jobs', async () => {
    renderDialog(ready([CD, NIGHTLY]));

    const pane = screen.getByRole('region', { name: 'CD details' });
    expect(within(pane).getByRole('heading', { name: 'CD' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^CD/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^Nightly/ })).not.toHaveAttribute('aria-current');

    await within(pane).findByRole('button', { name: /^job-of-100/ });
    expect(runDetails).toHaveBeenCalledTimes(1);
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100 });
  });

  it('opens on the pipeline whose card was clicked', async () => {
    renderDialog(ready([CD, NIGHTLY]), 2);

    expect(screen.getByRole('region', { name: 'Nightly details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Nightly/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await screen.findByRole('button', { name: /^job-of-200/ });
    expect(runDetails).toHaveBeenCalledTimes(1);
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 200 });
  });

  it('switches to another pipeline and reads its jobs', async () => {
    const { user } = renderDialog(ready([CD, NIGHTLY]));
    await screen.findByRole('button', { name: /^job-of-100/ });

    await user.click(screen.getByRole('button', { name: /^Nightly/ }));

    expect(screen.getByRole('region', { name: 'Nightly details' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'CD details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Nightly/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /^CD/ })).not.toHaveAttribute('aria-current');
    await screen.findByRole('button', { name: /^job-of-200/ });
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 200 });
  });

  it('says a pipeline that never ran has not run, without reading any jobs', async () => {
    const { user } = renderDialog(ready([CD, DOCS]));
    await screen.findByRole('button', { name: /^job-of-100/ });
    runDetails.mockClear();

    await user.click(screen.getByRole('button', { name: /^Docs/ }));

    expect(screen.getByText('This pipeline has not run yet.')).toBeInTheDocument();
    expect(runDetails).not.toHaveBeenCalled();
  });

  it('keeps the selection when the rows refresh, and falls back when it disappears', async () => {
    const { user, update } = renderDialog(ready([CD, NIGHTLY]));
    await user.click(screen.getByRole('button', { name: /^Nightly/ }));

    update(ready([CD, row(2, 'Nightly', FAILED)]));
    expect(screen.getByRole('region', { name: 'Nightly details' })).toBeInTheDocument();

    update(ready([CD]));
    expect(screen.getByRole('region', { name: 'CD details' })).toBeInTheDocument();
  });

  it('refreshes the list and the open run from the toolbar', async () => {
    const { user } = renderDialog(ready([CD, NIGHTLY]));
    await screen.findByRole('button', { name: /^job-of-100/ });

    await user.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));

    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(runDetails).toHaveBeenCalledTimes(2));
  });

  it('opens the project’s Actions page on GitHub from the toolbar', async () => {
    const { user } = renderDialog(ready([CD]));

    await user.click(screen.getByRole('button', { name: 'Open Actions on GitHub' }));

    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/actions');
  });

  it('closes on Escape', async () => {
    const { user } = renderDialog(ready([CD]));
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('focuses the dialog itself on open, so no toolbar tooltip pops up', async () => {
    renderDialog(ready([CD]));
    await waitFor(() => expect(dialog()).toHaveFocus());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('spins the refresh icon while it is reading', () => {
    renderWithProviders(
      <PipelinesDialog
        project={project}
        open
        onOpenChange={onOpenChange}
        state={stateOf(ready([CD]), { fetching: true })}
        workflowId={null}
      />,
      { bridge: { 'pipelines.runDetails': runDetails } },
    );
    const icon = screen.getByRole('button', { name: 'Refresh from GitHub' }).querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('animate-spin');
  });

  it('renders nothing while closed', () => {
    renderWithProviders(
      <PipelinesDialog
        project={project}
        open={false}
        onOpenChange={onOpenChange}
        state={stateOf(ready([CD]))}
        workflowId={null}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('PipelinesDialog states', () => {
  it('shimmers while the first read is in flight', () => {
    renderDialog({ kind: 'loading' });
    expect(screen.getByTestId('pipelines-dialog-loading')).toBeInTheDocument();
  });

  it('says what is missing when gh is not installed, and closes before sending you to Agent Tools', async () => {
    const { user } = renderDialog({ kind: 'notice', notice: { kind: 'no-cli' } });
    expect(screen.getByText('GitHub CLI not found')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Agent Tools' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('where')).toHaveTextContent('/tools');
  });

  it('retries a failed read from its notice', async () => {
    const { user } = renderDialog({
      kind: 'notice',
      notice: { kind: 'error', error: 'rate limited' },
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('has no Actions link until it knows the repo', () => {
    renderDialog({ kind: 'notice', notice: { kind: 'no-remote' } });
    expect(
      screen.queryByRole('button', { name: 'Open Actions on GitHub' }),
    ).not.toBeInTheDocument();
  });
});
