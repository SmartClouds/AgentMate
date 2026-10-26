import {
  ALL_AGENTS_WIDGET_ID,
  clampWidgetBlurPercent,
  getUsageProvider,
  type OpenWidgetOptions,
  type WidgetMode,
  widgetAlwaysOnTop,
  widgetBackgroundColor,
  widgetPeriod,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChartColumn, Clock, SettingsIcon, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AllAgentsCharts } from './AllAgentsCharts';
import { hasSubscriptionView, UsageCardBody, UsageCardBodySkeleton } from './UsageCard';
import {
  DEFAULT_WIDGET_SETTINGS,
  settingsToOpenOptions,
  WidgetSettingsForm,
  type WidgetSettingsValue,
  widgetGlassVars,
} from './WidgetSettingsForm';

/**
 * Standalone render target for a floating desktop widget window
 * (loaded at #/widget/:id). No AppShell/sidebar; a transparent page with a
 * frosted-glass card, an OS-drag strip, and a hover settings control.
 */
export default function WidgetRoute(): React.JSX.Element {
  const { id = '' } = useParams();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Make the whole document see-through so the glass card blurs the desktop.
  useEffect(() => {
    document.documentElement.setAttribute('data-widget', '');
    return () => document.documentElement.removeAttribute('data-widget');
  }, []);

  const instanceQuery = useQuery({
    queryKey: ['usage-widget-instance', id],
    queryFn: () => window.runova.usage.getWidget(id),
  });

  const instance = instanceQuery.data ?? null;
  const providerId = instance?.providerId;
  const isAllAgents = providerId === ALL_AGENTS_WIDGET_ID;

  // Re-read the instance when the main process reports a style/size change.
  useEffect(() => {
    return window.runova.usage.onWidgetUpdated((payload) => {
      if (payload.id === id) void instanceQuery.refetch();
    });
  }, [id, instanceQuery]);

  const usageQuery = useQuery({
    queryKey: ['usage-widget-data', providerId],
    queryFn: () => window.runova.usage.get(providerId as string),
    enabled: !!providerId && !isAllAgents,
    refetchInterval: 60_000,
  });

  const def = providerId ? getUsageProvider(providerId) : undefined;
  const usage = usageQuery.data;
  // Widgets pinned before modes existed have no `mode`, so they are token
  // widgets and must stay that way.
  const mode = instance?.mode ?? 'tokens';
  const blurPercent = clampWidgetBlurPercent(instance?.blurPercent);
  const backgroundColor = widgetBackgroundColor(instance?.backgroundColor);
  const period = widgetPeriod(instance ?? { period: 'day' });

  const showingLimits = mode === 'subscription' && !!usage && hasSubscriptionView(usage);
  const canToggle = !!usage && hasSubscriptionView(usage);

  async function patch(next: OpenWidgetOptions): Promise<void> {
    await window.runova.usage.configureWidget(id, next);
    await instanceQuery.refetch();
  }

  async function toggleMode(): Promise<void> {
    const next: WidgetMode = showingLimits ? 'tokens' : 'subscription';
    await patch({ mode: next });
  }

  const settingsValue: WidgetSettingsValue = instance
    ? {
        size: instance.size,
        style: instance.style,
        blurPercent,
        backgroundColor,
        alwaysOnTop: widgetAlwaysOnTop(instance),
        period,
      }
    : DEFAULT_WIDGET_SETTINGS;

  return (
    <div
      className="widget-glass card-spot group relative flex h-screen w-screen flex-col overflow-hidden rounded-2xl"
      style={widgetGlassVars(blurPercent, backgroundColor)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
        event.currentTarget.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
      }}
    >
      <div className="widget-sheen" aria-hidden />
      <div className="widget-drag flex h-7 shrink-0 items-center justify-end gap-0.5 px-2">
        {canToggle && !settingsOpen && (
          <SimpleTooltip
            label={showingLimits ? 'Show tokens and cost' : 'Show plan limits'}
            side="bottom"
          >
            <button
              type="button"
              className="widget-no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => void toggleMode()}
            >
              {showingLimits ? <ChartColumn className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
            </button>
          </SimpleTooltip>
        )}
        <SimpleTooltip label={settingsOpen ? 'Back to usage' : 'Widget settings'} side="bottom">
          <button
            type="button"
            className="widget-no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-70 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label={settingsOpen ? 'Back to usage' : 'Widget settings'}
          >
            <SettingsIcon className="h-3.5 w-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      <div className="widget-no-drag min-h-0 flex-1 px-3 pb-3">
        {settingsOpen ? (
          <OverflowScroll fill surface="card" className="pr-0.5">
            <WidgetSettingsForm
              value={settingsValue}
              onChange={(next) => void patch(settingsToOpenOptions(next))}
            />
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 w-full justify-start text-destructive hover:text-destructive"
              onClick={() => void window.runova.usage.closeWidget(id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from desktop
            </Button>
          </OverflowScroll>
        ) : isAllAgents ? (
          <OverflowScroll fill surface="card" className="pr-0.5">
            <AllAgentsCharts
              framed={false}
              compact={instance?.size === 'small'}
              period={period}
              onPeriodChange={(next) => void patch({ period: next })}
            />
          </OverflowScroll>
        ) : def && usage ? (
          <OverflowScroll fill surface="card" className="pr-0.5">
            <UsageCardBody
              usage={usage}
              def={def}
              style={instance?.style ?? 'colorful'}
              compact={instance?.size === 'small'}
              mode={mode}
              period={period}
              onPeriodChange={(next) => void patch({ period: next })}
            />
          </OverflowScroll>
        ) : (
          <UsageCardBodySkeleton compact={instance?.size === 'small'} />
        )}
      </div>
    </div>
  );
}
