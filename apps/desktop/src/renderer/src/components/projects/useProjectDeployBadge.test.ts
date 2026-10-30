import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleStack } from '@/components/deploy/apps/testing/fixtures';
import { useFilesRunEvents, writeSnapshot } from '@/components/deploy/files/hooks';
import { fileSite, pending, runResult, snapshot } from '@/components/deploy/files/testing/fixtures';
import { queryKeys } from '@/lib/queryKeys';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useProjectDeployBadge } from './useProjectDeployBadge';

/**
 * The Deploy tab's badge on a project page: how many changes wait across the FTP and SFTP sites
 * attached to the project, tinted when one of them needs a look.
 */

const ATTACHED = fileSite({ projectIds: ['p1'] });
const OTHER = fileSite({ id: 'fs-2', projectIds: ['p2'] });

describe('useProjectDeployBadge', () => {
  it('counts the pending changes across the attached sites only', async () => {
    const second = fileSite({ id: 'fs-3', projectIds: ['p1', 'p2'] });
    const { result } = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [ATTACHED, OTHER, second],
        'deployFiles.changes': async (siteId: string) =>
          snapshot({
            siteId,
            files: siteId === 'fs-3' ? [pending('a.html')] : [pending('b'), pending('c')],
          }),
      },
    });
    await waitFor(() => expect(result.current).toEqual({ count: 3, attention: false }));
  });

  it('has no badge without attached sites or pending changes', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [ATTACHED],
        'deployFiles.changes': snapshot({ files: [] }),
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(['deploy', 'files', 'site', 'fs-1', 'changes'])).toBeTruthy(),
    );
    expect(result.current).toBeUndefined();

    const none = renderHookWithProviders(() => useProjectDeployBadge(undefined));
    expect(none.result.current).toBeUndefined();
  });

  it('follows the snapshots a watch writes into the cache', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [ATTACHED],
        'deployFiles.changes': snapshot({ files: [], computedAt: 1 }),
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(['deploy', 'files', 'site', 'fs-1', 'changes'])).toBeTruthy(),
    );
    act(() => writeSnapshot(queryClient, snapshot({ computedAt: 2, files: [pending('x')] })));
    await waitFor(() => expect(result.current?.count).toBe(1));
  });

  it('asks for attention when a site needs review or its last deploy failed', async () => {
    const review = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [
          fileSite({
            projectIds: ['p1'],
            needsReview: { reason: 'conflicts', message: 'x', at: 1 },
          }),
        ],
        'deployFiles.changes': snapshot({ files: [] }),
      },
    });
    await waitFor(() => expect(review.result.current).toEqual({ count: 1, attention: true }));

    const failed = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [
          fileSite({
            projectIds: ['p1'],
            lastDeploy: {
              at: 1,
              state: 'failed',
              trigger: 'user',
              uploaded: 0,
              deleted: 0,
              failed: 1,
            },
          }),
        ],
        'deployFiles.changes': snapshot({ files: [pending('a'), pending('b')] }),
      },
    });
    await waitFor(() => expect(failed.result.current).toEqual({ count: 2, attention: true }));
  });

  it('asks for attention when a Runova app of the project failed, from the cache alone', async () => {
    const { result, queryClient, bridge } = renderHookWithProviders(
      () => useProjectDeployBadge('p1'),
      {
        bridge: {
          'deployFiles.list': [],
          'deploy.listServers': [{ id: 's1' }],
        },
      },
    );
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.deployServers)).toBeTruthy());
    expect(result.current).toBeUndefined();

    act(() =>
      queryClient.setQueryData(queryKeys.deployAppsList('s1'), [
        sampleStack({ id: 'a1', status: 'failed', source: { projectId: 'p1' } }),
        sampleStack({ id: 'a2', status: 'failed', source: { projectId: 'p2' } }),
        sampleStack({ id: 'a3', status: 'running', source: { projectId: 'p1' } }),
      ]),
    );
    await waitFor(() => expect(result.current).toEqual({ count: 1, attention: true }));
    expect(() => bridge.$fn('deployStacks.list')).toThrow();
  });

  it('follows the app-wide run events, with no watch of its own', async () => {
    let files = [pending('a'), pending('b')];
    const { result, bridge } = renderHookWithProviders(
      () => {
        useFilesRunEvents();
        return useProjectDeployBadge('p1');
      },
      {
        bridge: {
          'deployFiles.list': [ATTACHED],
          'deployFiles.changes': async () => snapshot({ files, computedAt: Date.now() }),
        },
      },
    );
    await waitFor(() => expect(result.current?.count).toBe(2));

    // A save somewhere else: main's snapshot event lands in the same cache entry.
    act(() =>
      bridge.$emit(
        'deployFiles.onChanges',
        snapshot({ files: [pending('a'), pending('b'), pending('c')], computedAt: Date.now() + 5 }),
      ),
    );
    await waitFor(() => expect(result.current?.count).toBe(3));

    // A Deploy on save run that sent everything: the count is read again.
    files = [];
    act(() => bridge.$emit('deployFiles.onRunFinished', runResult({ trigger: 'deployOnSave' })));
    await waitFor(() => expect(result.current).toBeUndefined());
    expect(() => bridge.$fn('deployFiles.subscribe')).toThrow();
  });

  it('leaves out a snapshot that is not ready', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useProjectDeployBadge('p1'), {
      bridge: {
        'deployFiles.list': [ATTACHED],
        'deployFiles.changes': snapshot({ state: 'folderMissing', files: [pending('a')] }),
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(['deploy', 'files', 'site', 'fs-1', 'changes'])).toBeTruthy(),
    );
    expect(result.current).toBeUndefined();
  });
});
