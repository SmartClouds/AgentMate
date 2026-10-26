import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { projectRow, splitOf, usageOf } from '../components/usage/weekday/testing/fixtures';
import { useProjectDaily } from './useProjectDaily';

/**
 * The chart reads the usage list the page already fetches. These tests cover what it shows while
 * that list is loading, after it fails, after a retry, and when no provider has a split at all.
 */

const claude = usageOf(
  'claude-code',
  splitOf([projectRow({ key: 'project:p1', name: 'Runova', tokens: [0, 100, 0, 0, 0, 0, 0] })]),
);
const codex = usageOf(
  'codex',
  splitOf([projectRow({ key: 'project:p1', name: 'Runova', tokens: [0, 0, 0, 0, 0, 0, 50] })]),
);

describe('useProjectDaily', () => {
  it('merges the split of every provider that reports one', async () => {
    const { result } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': [claude, codex, usageOf('cursor')] },
    });

    await waitFor(() => expect(result.current.split).not.toBeNull());
    expect(result.current.isPending).toBe(false);
    expect(result.current.isError).toBe(false);
    const [row] = result.current.split?.projects ?? [];
    expect(row.name).toBe('Runova');
    expect(row.tokens.reduce((sum, value) => sum + value, 0)).toBe(100 * 4 + 50 * 4);
  });

  it('is pending until the usage list arrives', () => {
    const { result } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': () => new Promise(() => undefined) },
    });

    expect(result.current.isPending).toBe(true);
    expect(result.current.split).toBeNull();
  });

  it('reports an error when the list cannot be read and there is nothing to show', async () => {
    const { result } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': () => Promise.reject(new Error('scan failed')) },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.split).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('keeps the last split on screen when a refresh fails', async () => {
    const { result, bridge } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': [claude] },
    });
    await waitFor(() => expect(result.current.split).not.toBeNull());

    bridge.$set('usage.list', () => Promise.reject(new Error('scan failed')));
    await act(async () => {
      result.current.retry();
    });

    // The refetch runs against the new answer, which is a fresh mock, so it is the one to check.
    await waitFor(() => expect(bridge.$fn('usage.list')).toHaveBeenCalled());
    expect(result.current.isError).toBe(false);
    expect(result.current.split?.projects).toHaveLength(1);
  });

  it('asks for the list again when retried', async () => {
    const { result, bridge } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': [claude] },
    });
    await waitFor(() => expect(result.current.split).not.toBeNull());

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(bridge.$fn('usage.list')).toHaveBeenCalledTimes(2));
  });

  it('has no split when no provider reports one', async () => {
    const { result } = renderHookWithProviders(() => useProjectDaily(), {
      bridge: { 'usage.list': [usageOf('cursor'), usageOf('openai')] },
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.split).toBeNull();
    expect(result.current.isError).toBe(false);
  });
});
