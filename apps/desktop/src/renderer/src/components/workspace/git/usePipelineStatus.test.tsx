import type {
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
  ProjectPipelineStatus,
} from '@shared/apiTypes';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { type PipelinesView, usePipelineStatus } from './usePipelineStatus';

/**
 * The Pipelines section and its larger-view dialog read one shared state. A refresh that fails while
 * the dialog (or a Fix with AI dialog inside it) is open used to swap the rows for the error notice,
 * which unmounted whatever the user was reading.
 */

const status = vi.fn();

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

function run(
  workflowId: number,
  state: Pick<GithubWorkflowRunInfo, 'status' | 'conclusion'>,
): GithubWorkflowRunInfo {
  return {
    id: workflowId * 100,
    workflowId,
    name: `wf${workflowId}`,
    displayTitle: 'Add login',
    runNumber: 7,
    headBranch: 'main',
    htmlUrl: `https://github.com/acme/app/actions/runs/${workflowId * 100}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...state,
  };
}

const healthy: ProjectPipelineStatus = {
  projectId: 'p1',
  cliAvailable: true,
  authenticated: true,
  github: { owner: 'acme', repo: 'app' },
  workflows: [workflow(1, 'CI')],
  runsByWorkflowId: { 1: run(1, { status: 'completed', conclusion: 'failure' }) },
};

function renderStatus(enabled = true) {
  return renderHookWithProviders(
    ({ on }: { on: boolean }) => usePipelineStatus('p1', { enabled: on }),
    { initialProps: { on: enabled }, bridge: { 'pipelines.status': status } },
  );
}

function view(result: { current: { view: PipelinesView } }): PipelinesView {
  return result.current.view;
}

function names(result: { current: { view: PipelinesView } }): string[] {
  const current = view(result);
  return current.kind === 'ready' ? current.rows.map((row) => row.workflow.name) : [];
}

/** Marks the cached status stale and waits for the refetch to land. */
async function refresh(client: ReturnType<typeof renderStatus>['queryClient']) {
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.pipelineStatus('p1') });
  });
}

beforeEach(() => {
  status.mockReset();
});

describe('usePipelineStatus view', () => {
  it('is loading until the first read answers', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result } = renderStatus();
    expect(view(result)).toEqual({ kind: 'loading' });
    await waitFor(() => expect(view(result).kind).toBe('ready'));
  });

  it('lists each workflow with its latest run, its tone and the repo', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));

    const current = view(result);
    if (current.kind !== 'ready') throw new Error('expected ready');
    expect(current.repo).toBe('acme/app');
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]?.workflow.name).toBe('CI');
    expect(current.rows[0]?.run?.id).toBe(100);
    expect(current.rows[0]?.tone?.outcome).toBe('failed');
  });

  it('puts failures first, then running, queued, passed, cancelled and never-run', async () => {
    status.mockResolvedValueOnce({
      ...healthy,
      workflows: [
        workflow(1, 'Never'),
        workflow(2, 'Passed'),
        workflow(3, 'Cancelled'),
        workflow(4, 'Queued'),
        workflow(5, 'Failed'),
        workflow(6, 'Running'),
      ],
      runsByWorkflowId: {
        1: null,
        2: run(2, { status: 'completed', conclusion: 'success' }),
        3: run(3, { status: 'completed', conclusion: 'cancelled' }),
        4: run(4, { status: 'queued', conclusion: null }),
        5: run(5, { status: 'completed', conclusion: 'failure' }),
        6: run(6, { status: 'in_progress', conclusion: null }),
      },
    });
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));

    expect(names(result)).toEqual(['Failed', 'Running', 'Queued', 'Passed', 'Cancelled', 'Never']);
  });

  it.each([
    ['gh is missing', { cliAvailable: false }, 'no-cli'],
    ['gh is signed out', { authenticated: false }, 'signed-out'],
    ['the repo is not on GitHub', { github: null }, 'no-remote'],
    ['there are no workflows', { workflows: [] }, 'no-workflows'],
  ] as const)('says so when %s', async (_label, patch, kind) => {
    status.mockResolvedValueOnce({ ...healthy, ...patch });
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));
    const current = view(result);
    expect(current.kind === 'notice' && current.notice.kind).toBe(kind);
  });

  it('names the repo that has no workflows', async () => {
    status.mockResolvedValueOnce({ ...healthy, workflows: [] });
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));
    expect(view(result)).toMatchObject({
      notice: { kind: 'no-workflows', repo: 'acme/app' },
    });
  });

  it('shows the error when the very first load reports one', async () => {
    status.mockResolvedValueOnce({ ...healthy, error: 'rate limited', workflows: [] });
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));
    expect(view(result)).toMatchObject({ notice: { kind: 'error', error: 'rate limited' } });
  });

  it('shows a plain error when the very first load throws', async () => {
    status.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));
    expect(view(result)).toMatchObject({ notice: { kind: 'error', error: null } });
  });
});

describe('usePipelineStatus refresh errors', () => {
  it('keeps the last rows when a refresh reports an error', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result, queryClient } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));

    status.mockResolvedValueOnce({ ...healthy, error: 'rate limited' });
    await refresh(queryClient);

    expect(status).toHaveBeenCalledTimes(2);
    expect(view(result).kind).toBe('ready');
    expect(names(result)).toEqual(['CI']);
  });

  it('keeps the last rows when a refresh throws', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result, queryClient } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));

    status.mockRejectedValueOnce(new Error('network down'));
    await refresh(queryClient);

    expect(view(result).kind).toBe('ready');
    expect(names(result)).toEqual(['CI']);
  });

  it('recovers to fresh rows after a failed refresh', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result, queryClient } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));

    status.mockResolvedValueOnce({ ...healthy, error: 'rate limited' });
    await refresh(queryClient);
    status.mockResolvedValueOnce({ ...healthy, workflows: [workflow(1, 'Release')] });
    await refresh(queryClient);

    await waitFor(() => expect(names(result)).toEqual(['Release']));
  });
});

/** A promise the test settles by hand, so a state that lasts "a moment" can be held and asserted on. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('usePipelineStatus retry', () => {
  const failed = { ...healthy, error: 'rate limited', workflows: [] };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports retrying until the attempt settles', async () => {
    status.mockResolvedValueOnce(failed);
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));
    expect(result.current.retrying).toBe(false);

    const attempt = deferred<unknown>();
    status.mockImplementationOnce(() => attempt.promise);
    act(() => result.current.retry());

    expect(result.current.retrying).toBe(true);
    expect(status).toHaveBeenCalledTimes(2);
    await act(async () => attempt.resolve(failed));
    await waitFor(() => expect(result.current.retrying).toBe(false), { timeout: 2000 });
  });

  it('stays busy for a beat even when the retry fails instantly', async () => {
    status.mockResolvedValueOnce(failed);
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));

    vi.useFakeTimers();
    status.mockResolvedValueOnce(failed);
    act(() => result.current.retry());
    // The answer is in well before the beat is over, but a retry that flashes by reads as a
    // click that did nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.retrying).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.retrying).toBe(false);
  });

  it('ignores a second retry while one is in flight', async () => {
    status.mockResolvedValueOnce(failed);
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('notice'));

    const attempt = deferred<unknown>();
    status.mockImplementationOnce(() => attempt.promise);
    act(() => result.current.retry());
    act(() => result.current.retry());

    await act(async () => attempt.resolve(failed));
    await waitFor(() => expect(result.current.retrying).toBe(false), { timeout: 2000 });
    expect(status).toHaveBeenCalledTimes(2);
  });
});

describe('usePipelineStatus enabled', () => {
  it('does not read GitHub while it is off, and reads once it turns on', async () => {
    status.mockResolvedValue(healthy);
    const { result, rerender } = renderStatus(false);

    // Give a stray fetch every chance to happen.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(status).not.toHaveBeenCalled();
    expect(view(result)).toEqual({ kind: 'loading' });

    rerender({ on: true });
    await waitFor(() => expect(view(result).kind).toBe('ready'));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('refreshes on demand and says it is fetching meanwhile', async () => {
    status.mockResolvedValueOnce(healthy);
    const { result } = renderStatus();
    await waitFor(() => expect(view(result).kind).toBe('ready'));
    expect(result.current.fetching).toBe(false);

    const attempt = deferred<unknown>();
    status.mockImplementationOnce(() => attempt.promise);
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.fetching).toBe(true));
    await act(async () => attempt.resolve(healthy));
    await waitFor(() => expect(result.current.fetching).toBe(false));
    expect(status).toHaveBeenCalledTimes(2);
  });
});
