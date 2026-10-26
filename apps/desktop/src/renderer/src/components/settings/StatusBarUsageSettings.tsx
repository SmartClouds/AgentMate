import {
  type AppSettings,
  getUsageProvider,
  normalizeStatusBarUsage,
  STATUS_BAR_USAGE_PROVIDERS,
  type StatusBarUsageProviderId,
  type StatusBarUsageSettings,
} from '@runova/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChartColumn } from '@/components/icons';
import { ProviderLogo } from '@/components/providerLogos';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Which AI subscriptions show their plan limits in the bottom status bar. A switch only decides
 * whether the item may show: a provider that reports no limit (an unlimited Cursor plan, Codex
 * on an API key) stays out of the bar either way.
 */
export function StatusBarUsageSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const queryClient = useQueryClient();
  const saved = normalizeStatusBarUsage(settings.statusBarUsage);

  const save = useMutation({
    mutationFn: (statusBarUsage: StatusBarUsageSettings) =>
      window.runova.settings.update({ statusBarUsage }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
  // Show the switch where it was flipped to while the write is in flight.
  const shown = save.isPending && save.variables ? save.variables : saved;

  const toggle = (id: StatusBarUsageProviderId, checked: boolean): void => {
    save.mutate({ ...shown, [id]: checked });
  };

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ChartColumn className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>Status bar limits</CardTitle>
          <CardDescription>
            Plan limits along the bottom of the window: the share used of the next limit to reset,
            and when it does.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {STATUS_BAR_USAGE_PROVIDERS.map((id) => {
          const name = getUsageProvider(id)?.name ?? id;
          const switchId = `status-bar-usage-${id}`;
          return (
            <div key={id} className="flex items-center justify-between gap-4">
              <label htmlFor={switchId} className="flex min-w-0 items-start gap-3">
                <ProviderLogo providerId={id} className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{name}</span>
                  <span className="block text-xs text-muted-foreground">
                    Shows when the account reports a plan limit.
                  </span>
                </span>
              </label>
              <Switch
                id={switchId}
                aria-label={`Show ${name} limits in the status bar`}
                checked={shown[id]}
                onCheckedChange={(checked) => toggle(id, checked)}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
