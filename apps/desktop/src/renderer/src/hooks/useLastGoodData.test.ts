import { useQuery } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The whole point of this hook is that a refresh which fails leaves the previous answer on
 * screen instead of blanking the page, so every test here is about what a caller still reads
 * back after something went wrong.
 *
 * The hook keeps its snapshots, failures and "already handled" marks in module level maps so the
 * state outlives a page, which is why each test uses a storage key of its own and the tests that
 * care about a cold start reload the module.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const STORAGE_PREFIX = 'runova:last-good:';

/** What the fake endpoint returns: a list, plus the "arrived but useless" error field. */
interface Runs {
  items: string[];
  error?: string;
}

type HookModule = typeof import('./useLastGoodData');

/** A copy of the module with empty in-memory maps, for the cold start cases. */
async function freshModule(): Promise<HookModule> {
  vi.resetModules();
  return import('./useLastGoodData');
}

/** The current responder, swapped mid-test to make the next fetch succeed or fail. */
let respond: () => Promise<Runs> = async () => ({ items: [] });

/** A distinct storage key per test, since the hook's maps are shared module state. */
let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `runs-${keyCounter}`;
}

function harness(module: HookModule) {
  return (storageKey: string) => {
    const query = useQuery<Runs>({
      queryKey: ['last-good-test', storageKey],
      queryFn: () => respond(),
    });
    return module.useLastGoodData<Runs>({
      storageKey,
      query,
      failureOf: (data) => data.error ?? null,
      title: 'Could not refresh runs',
    });
  };
}

beforeEach(() => {
  respond = async () => ({ items: [] });
});

describe('useLastGoodData while everything works', () => {
  it('passes the response through and reports when it was fetched', async () => {
    const module = await freshModule();
    respond = async () => ({ items: ['build'] });
    const key = nextKey();

    const { result } = renderHookWithProviders(() => harness(module)(key));

    await waitFor(() => expect(result.current.data?.items).toEqual(['build']));
    expect(result.current.failure).toBeNull();
    expect(result.current.savedAt).toBeGreaterThan(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the copy saved on disk before the first fetch comes back', async () => {
    const key = nextKey();
    localStorage.setItem(
      STORAGE_PREFIX + key,
      JSON.stringify({ data: { items: ['from last launch'] }, savedAt: 1_700_000_000_000 }),
    );
    // A fresh module has no in-memory snapshot, which is the state at app start.
    const module = await freshModule();
    // Never settles, so the only thing the hook can show is what was on disk.
    respond = () => new Promise<Runs>(() => undefined);

    const { result } = renderHookWithProviders(() => harness(module)(key));

    expect(result.current.data?.items).toEqual(['from last launch']);
    expect(result.current.savedAt).toBe(1_700_000_000_000);
  });
});

describe('useLastGoodData when a refresh fails', () => {
  it('keeps the last good value on screen and says what went wrong', async () => {
    const module = await freshModule();
    respond = async () => ({ items: ['build', 'deploy'] });
    const key = nextKey();

    const { result } = renderHookWithProviders(() => harness(module)(key));
    await waitFor(() => expect(result.current.data?.items).toEqual(['build', 'deploy']));

    respond = async () => {
      throw new Error("Error invoking remote method 'pipelines:list': Error: gh rate limited");
    };
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failure?.message).toBe('gh rate limited'));
    // The list the user was reading is untouched, which is the entire point.
    expect(result.current.data?.items).toEqual(['build', 'deploy']);
    expect(toast.error).toHaveBeenCalledWith('Could not refresh runs', {
      id: `refresh-failed:${key}`,
      description: 'gh rate limited Showing the last data that loaded.',
    });
  });

  it('treats a response that arrived with no usable data as a failure too', async () => {
    const module = await freshModule();
    respond = async () => ({ items: ['build'] });
    const key = nextKey();

    const { result } = renderHookWithProviders(() => harness(module)(key));
    await waitFor(() => expect(result.current.data?.items).toEqual(['build']));

    // The call succeeded, the payload is the failure. `failureOf` is what tells them apart.
    respond = async () => ({ items: [], error: 'workflow index missing' });
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failure?.message).toBe('workflow index missing'));
    expect(result.current.data?.items).toEqual(['build']);
  });

  it('lets the failure through untouched when there is nothing saved to fall back on', async () => {
    const module = await freshModule();
    respond = async () => {
      throw new Error('no such repository');
    };
    const key = nextKey();

    const { result } = renderHookWithProviders(() => harness(module)(key));

    // No snapshot, so the page renders its own error state rather than a stale list.
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled());
    expect(result.current.data).toBeUndefined();
    expect(result.current.failure).toBeNull();
  });

  it('clears the failure again once a refresh succeeds', async () => {
    const module = await freshModule();
    respond = async () => ({ items: ['build'] });
    const key = nextKey();

    const { result } = renderHookWithProviders(() => harness(module)(key));
    await waitFor(() => expect(result.current.data?.items).toEqual(['build']));

    respond = async () => {
      throw new Error('offline');
    };
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failure?.message).toBe('offline'));

    respond = async () => ({ items: ['build', 'release'] });
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failure).toBeNull());
    expect(result.current.data?.items).toEqual(['build', 'release']);
    expect(toast.dismiss).toHaveBeenCalledWith(`refresh-failed:${key}`);
  });

  it('counts every failure but only speaks up for the first one and for manual refreshes', async () => {
    const module = await freshModule();
    respond = async () => ({ items: ['build'] });
    const key = nextKey();

    const { result, queryClient } = renderHookWithProviders(() => harness(module)(key));
    await waitFor(() => expect(result.current.data?.items).toEqual(['build']));

    respond = async () => {
      throw new Error('offline');
    };
    // A background poll, the kind that would otherwise toast every minute.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['last-good-test', key] });
    });
    await waitFor(() => expect(result.current.failure?.count).toBe(1));
    expect(toast.error).toHaveBeenCalledTimes(1);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['last-good-test', key] });
    });
    await waitFor(() => expect(result.current.failure?.count).toBe(2));
    expect(toast.error).toHaveBeenCalledTimes(1);

    // The user asked this time, so silence would look like nothing happened.
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failure?.count).toBe(3));
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

describe('useLastGoodData across storage keys', () => {
  it('swaps to the copy saved under the new key', async () => {
    const first = nextKey();
    const second = nextKey();
    localStorage.setItem(
      STORAGE_PREFIX + second,
      JSON.stringify({ data: { items: ['other project'] }, savedAt: 1_700_000_000_000 }),
    );
    const module = await freshModule();
    respond = async () => ({ items: ['build'] });

    const { result, rerender } = renderHookWithProviders(
      ({ storageKey }: { storageKey: string }) => harness(module)(storageKey),
      { initialProps: { storageKey: first } },
    );
    await waitFor(() => expect(result.current.data?.items).toEqual(['build']));

    respond = () => new Promise<Runs>(() => undefined);
    rerender({ storageKey: second });

    await waitFor(() => expect(result.current.data?.items).toEqual(['other project']));
  });

  it('ignores a saved copy that is not a snapshot', async () => {
    const key = nextKey();
    localStorage.setItem(STORAGE_PREFIX + key, 'not json at all');
    const module = await freshModule();
    respond = () => new Promise<Runs>(() => undefined);

    const { result } = renderHookWithProviders(() => harness(module)(key));

    expect(result.current.data).toBeUndefined();
    expect(result.current.savedAt).toBeNull();
  });
});
