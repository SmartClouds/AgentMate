import type { ErrorIssueQuery } from '@shared/errorTrackingTypes';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { detail, issue, page } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { useErrorIssues, useErrorIssue, useIssueStatusChange, issueFilter } = await import(
  './useErrorTracking'
);

const filter = issueFilter({ status: 'unresolved', period: '14d', sort: 'lastSeen' });

describe('useErrorIssues', () => {
  it('asks for the filter, and for a fresh read when the user refreshes', async () => {
    const list = vi.fn(async (_query: ErrorIssueQuery) => page());
    const { result } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: { 'errorTracking.listIssues': list },
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(1));
    expect(list).toHaveBeenLastCalledWith({
      status: 'unresolved',
      period: '14d',
      sort: 'lastSeen',
      cursor: null,
    });

    act(() => result.current.refresh());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1][0]).toEqual(expect.objectContaining({ refresh: true }));
  });

  it('appends the next page with its cursor', async () => {
    const list = vi.fn(async (query: ErrorIssueQuery) =>
      query.cursor
        ? page({ issues: [issue({ id: '2' })], nextCursor: null })
        : page({ issues: [issue({ id: '1' })], nextCursor: '0:100:0' }),
    );
    const { result } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: { 'errorTracking.listIssues': list },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.issues.map((one) => one.id)).toEqual(['1', '2']));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: '0:100:0' }));
    expect(result.current.hasMore).toBe(false);
  });

  it('starts over from the first page when a stale cursor stops the next page', async () => {
    const list = vi.fn(async (query: ErrorIssueQuery) => {
      if (query.cursor) throw new Error('That page is gone. Refresh the list.');
      return page({ issues: [issue({ id: '1' })], nextCursor: '0:50:0' });
    });
    const { result } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: { 'errorTracking.listIssues': list },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreFailed).toBe(true));
    expect(result.current.stale).toMatch(/Refresh the list/);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBeNull());
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, refresh: true }));
  });

  it('polls every minute and never raises the page overlay', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: { 'errorTracking.listIssues': async () => page() },
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(1));
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.errorIssues(filter) });
    expect(query?.observers[0]?.options.refetchInterval).toBe(60_000);
    expect(query?.meta?.silentLoading).toBe(true);
  });

  it('keeps the rows and says so when a refresh fails', async () => {
    let fail = false;
    const { result } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: {
        'errorTracking.listIssues': async () => {
          if (fail) throw new Error('Sentry is rate limiting, try again in 30s');
          return page();
        },
      },
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(1));
    fail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toMatch(/rate limiting/));
    expect(result.current.issues).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reads again when the main process says the issues changed', async () => {
    const list = vi.fn(async () => page());
    const { result, bridge } = renderHookWithProviders(() => useErrorIssues(filter), {
      bridge: { 'errorTracking.listIssues': list },
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(1));
    act(() => bridge.$emit('errorTracking.onChanged', { reason: 'issues' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe('useIssueStatusChange', () => {
  it('drops a resolved issue from the list at once and offers an undo', async () => {
    let release: () => void = () => undefined;
    const setStatus = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(issue({ status: 'resolved' }));
        }),
    );
    const { result, bridge } = renderHookWithProviders(
      () => ({
        list: useErrorIssues(filter),
        one: useErrorIssue({ connectionId: 'c1', issueId: '4501' }),
        change: useIssueStatusChange(),
      }),
      {
        bridge: {
          'errorTracking.listIssues': async () => page(),
          'errorTracking.getIssue': async () => detail(),
          'errorTracking.setIssueStatus': setStatus,
        },
      },
    );
    await waitFor(() => expect(result.current.one.data).toBeTruthy());
    await waitFor(() => expect(result.current.list.issues).toHaveLength(1));

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.change(issue(), 'resolved');
    });
    await waitFor(() => expect(result.current.list.issues).toHaveLength(0));
    expect(result.current.one.data?.issue.status).toBe('resolved');
    release();
    await act(() => done);

    expect(setStatus).toHaveBeenCalledWith({
      connectionId: 'c1',
      issueId: '4501',
      status: 'resolved',
      ignoreMinutes: null,
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Issue resolved',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    const undo = toast.success.mock.calls.at(-1)?.[1].action.onClick as () => void;
    act(() => undo());
    await waitFor(() =>
      expect(bridge.$fn('errorTracking.setIssueStatus')).toHaveBeenLastCalledWith({
        connectionId: 'c1',
        issueId: '4501',
        status: 'unresolved',
        ignoreMinutes: null,
      }),
    );
  });

  it('puts the issue back and says why when the change fails', async () => {
    const { result } = renderHookWithProviders(
      () => ({ list: useErrorIssues(filter), change: useIssueStatusChange() }),
      {
        bridge: {
          'errorTracking.listIssues': async () => page(),
          'errorTracking.setIssueStatus': async () => {
            throw new Error('Missing scope event:write');
          },
        },
      },
    );
    await waitFor(() => expect(result.current.list.issues).toHaveLength(1));
    await act(() => result.current.change(issue(), 'ignored', 60));
    await waitFor(() => expect(result.current.list.issues).toHaveLength(1));
    expect(toast.error).toHaveBeenCalledWith(
      'Could not ignore the issue',
      expect.objectContaining({ description: expect.stringContaining('event:write') }),
    );
  });
});
