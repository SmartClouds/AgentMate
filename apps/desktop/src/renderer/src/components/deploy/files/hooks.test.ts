import type { FileSite, FilesChangesSnapshot } from '@shared/deployFilesTypes';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { selectSiteRun, useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import {
  finishRun,
  useCachedFileSiteChanges,
  useFileSiteChanges,
  useFileSiteHistory,
  useFileSites,
  useFilesRunEvents,
  useSavedServerNames,
  writeSnapshot,
} from './hooks';
import { fileSite, progressEvent, runResult, SITE_ID, snapshot } from './testing/fixtures';

/**
 * Reads for FTP and SFTP sites (E23). The list of sites and each site's pending changes are kept
 * fresh by events from main rather than by asking again, and a run's progress lands in the run
 * store whichever page is open.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

const run = () => selectSiteRun(SITE_ID)(useDeployFilesRunStore.getState());

beforeEach(() => {
  useDeployFilesRunStore.setState(useDeployFilesRunStore.getInitialState(), true);
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('useFileSites', () => {
  it('lists the sites, and an empty list when the bridge sends nothing', async () => {
    const site = fileSite();
    const { result } = renderHookWithProviders(() => useFileSites(), {
      bridge: { 'deployFiles.list': [site] },
    });
    await waitFor(() => expect(result.current.data).toEqual([site]));

    const empty = renderHookWithProviders(() => useFileSites());
    await waitFor(() => expect(empty.result.current.data).toEqual([]));
  });

  it('takes the new list main sends when the sites change', async () => {
    const { result, bridge } = renderHookWithProviders(() => useFileSites(), {
      bridge: { 'deployFiles.list': [fileSite()] },
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    const renamed = fileSite({ label: 'Renamed' });
    act(() =>
      bridge.$emit('deployFiles.onSitesChanged', { sites: [renamed, fileSite({ id: 'fs-2' })] }),
    );
    await waitFor(() =>
      expect(result.current.data?.map((site) => site.label)).toEqual(['Renamed', 'Bakery static']),
    );
  });
});

describe('useFileSiteChanges', () => {
  it('subscribes on mount, feeds the cache from events, and unsubscribes on unmount', async () => {
    const { result, bridge, unmount } = renderHookWithProviders(() => useFileSiteChanges(SITE_ID), {
      bridge: {
        'deployFiles.changes': snapshot({ computedAt: 1 }),
        'deployFiles.subscribe': snapshot({ computedAt: 2 }),
      },
    });
    await waitFor(() => expect(result.current.data?.computedAt).toBe(2));
    expect(bridge.$fn('deployFiles.subscribe')).toHaveBeenCalledWith(SITE_ID);

    const next = snapshot({ computedAt: 3, files: [] });
    act(() => bridge.$emit('deployFiles.onChanges', next));
    act(() => bridge.$emit('deployFiles.onChanges', snapshot({ siteId: 'other', computedAt: 9 })));
    await waitFor(() => expect(result.current.data?.files).toEqual([]));
    expect(result.current.data?.computedAt).toBe(3);

    unmount();
    expect(bridge.$fn('deployFiles.unsubscribe')).toHaveBeenCalledWith(SITE_ID);
    expect(bridge.$listenerCount('deployFiles.onChanges')).toBe(0);
  });

  it('never lets an older snapshot replace a newer one', async () => {
    const { result } = renderHookWithProviders(() => useFileSiteChanges(SITE_ID), {
      bridge: {
        'deployFiles.changes': () =>
          new Promise<FilesChangesSnapshot>((resolve) =>
            setTimeout(() => resolve(snapshot({ computedAt: 1, files: [] })), 20),
          ),
        'deployFiles.subscribe': snapshot({ computedAt: 5 }),
      },
    });
    await waitFor(() => expect(result.current.data?.computedAt).toBe(5));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(result.current.data?.computedAt).toBe(5);
  });

  it('waits quietly when main has nothing yet, and survives a failed subscribe', async () => {
    const { result } = renderHookWithProviders(() => useFileSiteChanges(SITE_ID), {
      bridge: {
        'deployFiles.subscribe': async () => {
          throw new Error('[files:siteUnknown] gone');
        },
      },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('reads the cache without subscribing for the rail', async () => {
    const { result, queryClient, bridge } = renderHookWithProviders(() =>
      useCachedFileSiteChanges(SITE_ID),
    );
    expect(result.current).toBeNull();
    act(() => writeSnapshot(queryClient, snapshot({ computedAt: 4 })));
    await waitFor(() => expect(result.current?.computedAt).toBe(4));
    expect(() => bridge.$fn('deployFiles.subscribe')).toThrow();
  });
});

describe('useFileSiteHistory', () => {
  it("reads the site's runs, and none when the bridge sends nothing", async () => {
    const { result } = renderHookWithProviders(() => useFileSiteHistory(SITE_ID), {
      bridge: { 'deployFiles.history': [runResult()] },
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    const empty = renderHookWithProviders(() => useFileSiteHistory(SITE_ID));
    await waitFor(() => expect(empty.result.current.data).toEqual([]));
  });
});

describe('useSavedServerNames', () => {
  it('maps saved server ids to their nicknames', async () => {
    const { result } = renderHookWithProviders(() => useSavedServerNames(), {
      bridge: { 'ssh.listServers': [{ id: 'srv-1', nickname: 'Production' }] },
    });
    await waitFor(() => expect(result.current.get('srv-1')).toBe('Production'));

    const empty = renderHookWithProviders(() => useSavedServerNames());
    expect(empty.result.current.size).toBe(0);
  });
});

describe('useFilesRunEvents', () => {
  function mount(sites: FileSite[] = [fileSite()]) {
    const view = renderHookWithProviders(() => useFilesRunEvents());
    view.queryClient.setQueryData(queryKeys.deployFilesSites, sites);
    return view;
  }

  it('puts progress into the run store', () => {
    const { bridge } = mount();
    act(() => bridge.$emit('deployFiles.onProgress', progressEvent({ filesDone: 2 })));
    expect(run().progress?.filesDone).toBe(2);
  });

  it('takes a finished run once, says how it went and refreshes what it changed', async () => {
    const { bridge, queryClient } = mount();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => bridge.$emit('deployFiles.onRunFinished', runResult()));
    act(() => bridge.$emit('deployFiles.onRunFinished', runResult()));

    expect(run().result?.state).toBe('done');
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0][0]).toBe('Deployed Bakery static: 2 uploaded, 1 deleted.');
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.deployFilesHistory(SITE_ID)));
    expect(keys).toContain(JSON.stringify(queryKeys.deployFilesSites));
    expect(keys).toContain(JSON.stringify(queryKeys.deployFilesChanges(SITE_ID)));
  });

  it('feeds snapshots for any site into the cache', () => {
    const { bridge, queryClient } = mount();
    act(() => bridge.$emit('deployFiles.onChanges', snapshot({ siteId: 'fs-9' })));
    expect(queryClient.getQueryData(queryKeys.deployFilesChanges('fs-9'))).toBeTruthy();
  });

  it('marks a site that needs review, and clears it again', () => {
    const { bridge, queryClient } = mount();
    const needsReview = { reason: 'conflicts' as const, message: 'Files changed', at: 1 };
    act(() => bridge.$emit('deployFiles.onNeedsReview', { siteId: SITE_ID, needsReview }));
    const sites = () => queryClient.getQueryData<FileSite[]>(queryKeys.deployFilesSites) ?? [];
    expect(sites()[0].needsReview).toEqual(needsReview);
    act(() => bridge.$emit('deployFiles.onNeedsReview', { siteId: SITE_ID, needsReview: null }));
    expect(sites()[0].needsReview).toBeNull();
  });

  it('stops listening on unmount', () => {
    const { bridge, unmount } = mount();
    unmount();
    expect(bridge.$listenerCount('deployFiles.onProgress')).toBe(0);
    expect(bridge.$listenerCount('deployFiles.onRunFinished')).toBe(0);
    expect(bridge.$listenerCount('deployFiles.onNeedsReview')).toBe(0);
    expect(bridge.$listenerCount('deployFiles.onChanges')).toBe(0);
  });
});

describe('finishRun', () => {
  function client() {
    return renderHookWithProviders(() => null).queryClient;
  }

  it('says plainly what a partial, failed or cancelled run leaves behind', () => {
    const queryClient = client();
    finishRun(
      queryClient,
      runResult({
        runId: 'a',
        state: 'partial',
        uploaded: 2,
        deleted: 0,
        failed: [{ path: 'x', code: 'server', message: 'no' }],
      }),
    );
    expect(toast.warning.mock.calls[0][0]).toBe(
      'Part of the site was deployed: 2 uploaded, 1 failed. The rest stays in the list.',
    );

    finishRun(
      queryClient,
      runResult({ runId: 'b', state: 'failed', error: { code: 'auth', message: 'no' } }),
    );
    expect(toast.error.mock.calls[0][0]).toMatch(/^The deploy failed\. The server didn't accept/);

    finishRun(queryClient, runResult({ runId: 'c', state: 'failed', error: null }));
    expect(toast.error.mock.calls[1][0]).toBe('The deploy failed.');

    finishRun(queryClient, runResult({ runId: 'd', state: 'cancelled', uploaded: 1, deleted: 0 }));
    expect(toast.info.mock.calls[0][0]).toBe(
      'Deploy cancelled after 1 uploaded. What was not sent stays in the list.',
    );

    finishRun(queryClient, runResult({ runId: 'e', state: 'cancelled', uploaded: 0, deleted: 0 }));
    expect(toast.info.mock.calls[1][0]).toBe('Deploy cancelled. Nothing was sent.');
  });

  it('drops a snapshot nobody watches, so the rail does not keep counting what was deployed', async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useCachedFileSiteChanges(SITE_ID),
    );
    act(() => writeSnapshot(queryClient, snapshot()));
    await waitFor(() => expect(result.current?.files).toHaveLength(3));

    act(() => finishRun(queryClient, runResult()));
    await waitFor(() => expect(result.current).toBeNull());
    // Stale too, so a reader that mounts next (the project badge) asks main at once.
    expect(queryClient.getQueryState(queryKeys.deployFilesChanges(SITE_ID))?.isInvalidated).toBe(
      true,
    );
  });

  it('keeps a watched snapshot and asks for a fresh one', async () => {
    let fresh = snapshot({ computedAt: 1 });
    const { result, queryClient, bridge } = renderHookWithProviders(
      () => useFileSiteChanges(SITE_ID),
      {
        bridge: {
          'deployFiles.subscribe': snapshot({ computedAt: 1 }),
          'deployFiles.changes': async () => fresh,
        },
      },
    );
    await waitFor(() => expect(result.current.data?.files).toHaveLength(3));
    const reads = bridge.$fn('deployFiles.changes').mock.calls.length;

    fresh = snapshot({ computedAt: 2, files: [] });
    act(() => finishRun(queryClient, runResult()));
    expect(result.current.data).not.toBeNull();
    await waitFor(() =>
      expect(bridge.$fn('deployFiles.changes').mock.calls.length).toBeGreaterThan(reads),
    );
    await waitFor(() => expect(result.current.data?.files).toHaveLength(0));
  });

  it('names no site it does not know', () => {
    const queryClient = client();
    finishRun(queryClient, runResult({ siteId: 'nobody' }));
    expect(toast.success.mock.calls[0][0]).toBe('Deployed: 2 uploaded, 1 deleted.');
  });
});
