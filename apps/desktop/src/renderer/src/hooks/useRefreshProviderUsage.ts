import { getUsageProvider, type ProviderUsage } from '@runova/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { mergeProviderUsage } from '@/lib/statusBarLimits';

/**
 * Re-reads one provider on demand and puts the result into the usage list the rest of the app
 * already shows, so the status bar, the Token Usage page and the widgets agree straight away. It
 * does not raise the full-page loading overlay: the refresh button shows its own spinner.
 */
export function useRefreshProviderUsage(providerId: string) {
  const queryClient = useQueryClient();
  const name = getUsageProvider(providerId)?.name ?? providerId;

  return useMutation({
    mutationFn: (): Promise<ProviderUsage> => window.runova.usage.refreshProvider(providerId),
    meta: { silentLoading: true },
    onSuccess: async (usage) => {
      // A list poll that started before the refresh would otherwise land after it and undo it.
      await queryClient.cancelQueries({ queryKey: queryKeys.usageList });
      const list = queryClient.getQueryData<ProviderUsage[]>(queryKeys.usageList);
      if (list) queryClient.setQueryData(queryKeys.usageList, mergeProviderUsage(list, usage));
      else await queryClient.invalidateQueries({ queryKey: queryKeys.usageList });
    },
    onError: (error: Error) => {
      toast.error(`Could not refresh ${name} usage: ${error.message}`);
    },
  });
}
