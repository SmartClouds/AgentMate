import {
  type AppSettings,
  DEFAULT_IDLE_RESOURCE_MINUTES,
  normalizeIdleResourceMinutes,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

type IdleResourcePatch = Partial<Pick<AppSettings, 'idleResourceMinutes' | 'idleResourceNotify'>>;

/**
 * The two idle-resource settings, shared by the Settings page and the Dashboard card's popover
 * so the clamping and the refresh of the idle list happen in one place.
 */
export function useIdleResourceSettings(): {
  loaded: boolean;
  minutes: number;
  notify: boolean;
  setMinutes: (value: number) => void;
  setNotify: (value: boolean) => void;
} {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  const mutation = useMutation({
    mutationFn: (patch: IdleResourcePatch) => window.runova.settings.update(patch),
    meta: { silentLoading: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      // The idle list is judged against the threshold when it is read, so it changes right away.
      void queryClient.invalidateQueries({ queryKey: queryKeys.resourceActivity });
    },
    // Without this a failed save would just snap the control back with no word about why.
    onError: () => toast.error('Could not save that setting.'),
  });

  // While a save is in flight the control shows the value being saved, so it does not jump back.
  const pending = mutation.isPending ? mutation.variables : undefined;
  const saved = settingsQuery.data;

  return {
    loaded: saved !== undefined,
    minutes:
      pending?.idleResourceMinutes ?? saved?.idleResourceMinutes ?? DEFAULT_IDLE_RESOURCE_MINUTES,
    notify: pending?.idleResourceNotify ?? saved?.idleResourceNotify ?? true,
    setMinutes: (value) =>
      mutation.mutate({ idleResourceMinutes: normalizeIdleResourceMinutes(value) }),
    setNotify: (value) => mutation.mutate({ idleResourceNotify: value }),
  };
}
