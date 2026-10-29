import type { JobInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import {
  useDeployFollowedJobStore,
  useFinishedOnce,
  useFollowedJob,
} from './deployFollowedJobStore';

/**
 * A job a Deploy section follows (an image pull, the nginx install, a certificate) runs on the
 * server whether or not the page is open. The job being followed is kept here, so its log opens
 * again when the section comes back, and its end is handled once however often it is shown.
 */

const JOB = { id: 'job-1', title: 'Pull nginx', state: 'running' } as JobInfo;

describe('useFollowedJob', () => {
  it('keeps the job of a section, per server, across mounts', () => {
    const first = renderHookWithProviders(() => useFollowedJob('srv-1', 'containers'));
    expect(first.result.current[0]).toBeNull();
    act(() => first.result.current[1](JOB));
    expect(first.result.current[0]).toBe(JOB);
    first.unmount();

    const again = renderHookWithProviders(() => useFollowedJob('srv-1', 'containers'));
    expect(again.result.current[0]).toBe(JOB);
    const other = renderHookWithProviders(() => useFollowedJob('srv-2', 'containers'));
    expect(other.result.current[0]).toBeNull();
    const slot = renderHookWithProviders(() => useFollowedJob('srv-1', 'nginx'));
    expect(slot.result.current[0]).toBeNull();

    act(() => again.result.current[1](null));
    expect(useDeployFollowedJobStore.getState().jobs).toEqual({});
  });
});

describe('useFinishedOnce', () => {
  it('handles the end of a job once, even when the log opens again', () => {
    const callback = vi.fn();
    const first = renderHookWithProviders(() => useFinishedOnce('srv-1', callback));
    first.result.current({ ...JOB, state: 'failed' });
    first.result.current({ ...JOB, state: 'failed' });
    first.unmount();

    const again = renderHookWithProviders(() => useFinishedOnce('srv-1', callback));
    again.result.current({ ...JOB, state: 'failed' });
    expect(callback).toHaveBeenCalledTimes(1);

    again.result.current({ ...JOB, id: 'job-2', state: 'succeeded' });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
