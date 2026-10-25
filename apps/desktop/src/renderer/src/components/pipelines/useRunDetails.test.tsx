import type { GithubRunJob, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { LIVE_REFETCH_MS, useRunDetails } from './useRunDetails';

const runDetails = vi.fn();

type RunArg = Pick<GithubWorkflowRunInfo, 'id' | 'status' | 'runAttempt'>;

const DONE: RunArg = { id: 100, status: 'completed', runAttempt: 1 };
const LIVE: RunArg = { id: 100, status: 'in_progress', runAttempt: 1 };

function job(id: number, name: string, status: GithubRunJob['status'] = 'completed'): GithubRunJob {
  return {
    id,
    name,
    status,
    conclusion: status === 'completed' ? 'success' : null,
    startedAt: null,
    completedAt: null,
    htmlUrl: null,
    runnerName: null,
    steps: [],
  };
}

function render(initial: { run: RunArg | null; enabled: boolean }) {
  return renderHookWithProviders(
    (props: { run: RunArg | null; enabled: boolean }) =>
      useRunDetails('acme/app', props.run, props.enabled),
    { initialProps: initial, bridge: { 'pipelines.runDetails': runDetails } },
  );
}

beforeEach(() => {
  runDetails.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRunDetails', () => {
  it('reads the jobs of the run', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [job(1, 'build')] });
    const { result } = render({ run: DONE, enabled: true });

    await waitFor(() => expect(result.current.data).toEqual([job(1, 'build')]));
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100 });
  });

  it('turns a failed read into an error that carries the reason', async () => {
    runDetails.mockResolvedValue({ ok: false, error: 'HTTP 403: Forbidden' });
    const { result } = render({ run: DONE, enabled: true });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('HTTP 403: Forbidden');
  });

  it('reads nothing while off, or when there is no run to read', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    const off = render({ run: DONE, enabled: false });
    const none = render({ run: null, enabled: true });

    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });

    expect(runDetails).not.toHaveBeenCalled();
    expect(off.result.current.data).toBeUndefined();
    expect(none.result.current.data).toBeUndefined();
  });

  it('does not show another run’s jobs while this run loads', async () => {
    runDetails.mockImplementation(({ runId }: { runId: number }) =>
      runId === 100
        ? Promise.resolve({ ok: true, jobs: [job(1, 'first')] })
        : new Promise(() => undefined),
    );
    const { result, rerender } = render({ run: DONE, enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ run: { ...DONE, id: 200 }, enabled: true });

    await waitFor(() => expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 200 }));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useRunDetails polling', () => {
  it('keeps reading a run that is still going, so the steps move along', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue({ ok: true, jobs: [job(1, 'build', 'in_progress')] });
    const { result } = render({ run: LIVE, enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(runDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_REFETCH_MS + 100);
    });
    expect(runDetails).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_REFETCH_MS + 100);
    });
    expect(runDetails).toHaveBeenCalledTimes(3);
  });

  it('reads a finished run once and leaves it alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue({ ok: true, jobs: [job(1, 'build')] });
    const { result } = render({ run: DONE, enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * LIVE_REFETCH_MS);
    });

    expect(runDetails).toHaveBeenCalledTimes(1);
  });

  it('stops reading when the dialog closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue({ ok: true, jobs: [job(1, 'build', 'in_progress')] });
    const { result, rerender } = render({ run: LIVE, enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ run: LIVE, enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * LIVE_REFETCH_MS);
    });

    expect(runDetails).toHaveBeenCalledTimes(1);
  });

  it('reads once more when a run finishes, keeping the old jobs on screen meanwhile', async () => {
    runDetails.mockResolvedValueOnce({ ok: true, jobs: [job(1, 'build', 'in_progress')] });
    const { result, rerender } = render({ run: LIVE, enabled: true });
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe('in_progress'));

    let finish: (value: unknown) => void = () => undefined;
    runDetails.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    rerender({ run: DONE, enabled: true });

    await waitFor(() => expect(runDetails).toHaveBeenCalledTimes(2));
    // No flash back to a shimmer: the half-done jobs stay until the final ones arrive.
    expect(result.current.data?.[0]?.status).toBe('in_progress');

    await act(async () => finish({ ok: true, jobs: [job(1, 'build', 'completed')] }));
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe('completed'));
  });

  it('reads again when the run is re-run', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [job(1, 'build')] });
    const { result, rerender } = render({ run: DONE, enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ run: { ...DONE, runAttempt: 2 }, enabled: true });

    await waitFor(() => expect(runDetails).toHaveBeenCalledTimes(2));
  });
});
