import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The "pause runs while an agent works" setting, shared by the Settings page, the runs panel in
 * the status bar and the controller that does the pausing, so all three read the same cache.
 */
export function useAutoPauseRunsSetting(): {
  loaded: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  const mutation = useMutation({
    mutationFn: (autoPauseRunsWhileAgentWorks: boolean) =>
      window.runova.settings.update({ autoPauseRunsWhileAgentWorks }),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    onError: () => toast.error('Could not save that setting.'),
  });

  const saved = settingsQuery.data;
  return {
    loaded: saved !== undefined,
    // While a save is in flight the switch shows the value being saved, so it does not jump back.
    enabled: mutation.isPending ? mutation.variables : saved?.autoPauseRunsWhileAgentWorks === true,
    setEnabled: (value) => mutation.mutate(value),
  };
}
