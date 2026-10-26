import type { AndroidDevice, AndroidSnapshot } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The page's view of what is attached. The snapshot query is the baseline and the event channel
 * patches it, so a card flips to "booting" the moment the manager notices rather than on the next
 * poll. Both go through the same query cache, so there is only ever one source of truth.
 */

export interface AndroidState {
  snapshot: AndroidSnapshot | undefined;
  devices: AndroidDevice[];
  loading: boolean;
  fetching: boolean;
  refresh: () => void;
}

/** Running first, then whatever is coming up, then the rest. Alphabetical inside each group. */
const STATE_ORDER: Record<string, number> = {
  running: 0,
  finishing: 1,
  booting: 1,
  connecting: 1,
  launching: 1,
  stopping: 1,
  failed: 2,
  stopped: 3,
};

function sortDevices(snapshot: AndroidSnapshot | undefined): AndroidDevice[] {
  if (!snapshot) return [];
  const emulators = [...snapshot.emulators].sort((a, b) => {
    const order = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
    return order !== 0 ? order : a.avd.displayName.localeCompare(b.avd.displayName);
  });
  const physical = [...snapshot.physical].sort((a, b) =>
    (a.device.model ?? a.device.serial).localeCompare(b.device.model ?? b.device.serial),
  );
  return [...emulators, ...physical];
}

export function useAndroidState(enabled: boolean): AndroidState {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.androidSnapshot,
    queryFn: () => window.runova.android.refresh(),
    enabled,
    // A device can be plugged in at any moment, and there is no event for that.
    refetchInterval: enabled ? 4000 : false,
    meta: { silentLoading: true },
  });

  useEffect(() => {
    return window.runova.android.onEvent((event) => {
      if (event.kind === 'emulator') {
        // Patch the one card rather than refetching the world, so a boot stage lands immediately.
        queryClient.setQueryData<AndroidSnapshot>(queryKeys.androidSnapshot, (current) => {
          if (!current) return current;
          const emulators = current.emulators.some((e) => e.avd.name === event.emulator.avd.name)
            ? current.emulators.map((e) =>
                e.avd.name === event.emulator.avd.name ? event.emulator : e,
              )
            : [...current.emulators, event.emulator];
          return { ...current, emulators };
        });
      }
      if (event.kind === 'usage') {
        queryClient.setQueryData<AndroidSnapshot>(queryKeys.androidSnapshot, (current) => {
          if (!current) return current;
          return {
            ...current,
            emulators: current.emulators.map((emulator) =>
              emulator.serial && event.bySerial[emulator.serial]
                ? { ...emulator, usage: event.bySerial[emulator.serial] }
                : emulator,
            ),
          };
        });
      }
      if (event.kind === 'snapshot') {
        queryClient.setQueryData(queryKeys.androidSnapshot, event.snapshot);
      }
    });
  }, [queryClient]);

  // Sampling CPU is a real cost in the main process, so it only runs while this page is mounted
  // and the window is on screen.
  useEffect(() => {
    if (!enabled) return;
    const sync = (): void => {
      void window.runova.android.watchUsage(document.visibilityState === 'visible');
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      void window.runova.android.watchUsage(false);
    };
  }, [enabled]);

  const devices = useMemo(() => sortDevices(query.data), [query.data]);

  return {
    snapshot: query.data,
    devices,
    loading: query.isLoading,
    fetching: query.isFetching,
    refresh: () => void query.refetch(),
  };
}
