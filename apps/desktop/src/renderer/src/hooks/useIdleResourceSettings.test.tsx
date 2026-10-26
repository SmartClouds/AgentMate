import type { AppSettings } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useIdleResourceSettings } from './useIdleResourceSettings';

/**
 * The Settings page and the Dashboard card both edit these two values through this hook, so the
 * clamping, the instant refresh of the idle list and the answer to a failed save are checked here
 * once instead of in each place.
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
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const SAVED = { idleResourceMinutes: 45, idleResourceNotify: false } as AppSettings;

beforeEach(() => {
  toast.error.mockReset();
});

describe('useIdleResourceSettings', () => {
  it('reports the defaults until the saved settings arrive', async () => {
    const { result } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: { 'settings.get': () => new Promise(() => undefined) },
    });

    expect(result.current).toMatchObject({ loaded: false, minutes: 20, notify: true });
  });

  it('reads what was saved', async () => {
    const { result } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: { 'settings.get': SAVED },
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toMatchObject({ minutes: 45, notify: false });
  });

  it('saves minutes inside the allowed range, whatever it is handed', async () => {
    const { result, bridge } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: { 'settings.get': SAVED, 'settings.update': async () => SAVED },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setMinutes(0));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ idleResourceMinutes: 1 }),
    );
    act(() => result.current.setMinutes(50_000));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
        idleResourceMinutes: 1440,
      }),
    );
  });

  it('saves the alert switch on its own, leaving the minutes alone', async () => {
    const { result, bridge } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: { 'settings.get': SAVED, 'settings.update': async () => SAVED },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setNotify(true));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ idleResourceNotify: true }),
    );
  });

  it('shows the value being saved while the save is in flight, so the control does not jump', async () => {
    let finish: (() => void) | undefined;
    const { result } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: {
        'settings.get': SAVED,
        'settings.update': () =>
          new Promise((resolve) => {
            finish = () => resolve(SAVED);
          }),
      },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setMinutes(120));

    await waitFor(() => expect(result.current.minutes).toBe(120));
    finish?.();
  });

  it('refreshes the idle list as soon as a save lands, since it is judged at read time', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: { 'settings.get': SAVED, 'settings.update': async () => SAVED },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current.setMinutes(30));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.resourceActivity }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
  });

  it('says so when a save fails, and goes back to what is stored', async () => {
    const { result } = renderHookWithProviders(() => useIdleResourceSettings(), {
      bridge: {
        'settings.get': SAVED,
        'settings.update': () => Promise.reject(new Error('EPERM')),
      },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setMinutes(120));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save that setting.'));
    await waitFor(() => expect(result.current.minutes).toBe(45));
  });
});
