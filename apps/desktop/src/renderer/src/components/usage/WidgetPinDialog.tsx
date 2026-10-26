import {
  ALL_AGENTS_WIDGET_ID,
  type ProviderUsage,
  type UsageProviderDefinition,
  type WidgetMode,
} from '@runova/core';
import { useEffect, useState } from 'react';
import { Pin } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { AllAgentsCharts } from './AllAgentsCharts';
import { UsageCardBody } from './UsageCard';
import {
  DEFAULT_WIDGET_SETTINGS,
  WidgetSettingsForm,
  type WidgetSettingsValue,
  widgetGlassVars,
} from './WidgetSettingsForm';

/**
 * Shown when pinning a Token Usage card to the desktop: pick frost, whether
 * it stays on top, the period the headline uses, then add it.
 */
export function WidgetPinDialog({
  open,
  onOpenChange,
  def,
  usage,
  mode,
  onPin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  def: UsageProviderDefinition;
  usage: ProviderUsage | undefined;
  mode: WidgetMode;
  onPin: (settings: WidgetSettingsValue) => Promise<void>;
}): React.JSX.Element {
  const [settings, setSettings] = useState<WidgetSettingsValue>({
    ...DEFAULT_WIDGET_SETTINGS,
    period: mode === 'subscription' ? 'day' : DEFAULT_WIDGET_SETTINGS.period,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSettings({
      ...DEFAULT_WIDGET_SETTINGS,
      period:
        def.id === ALL_AGENTS_WIDGET_ID
          ? 'week'
          : mode === 'subscription'
            ? 'day'
            : DEFAULT_WIDGET_SETTINGS.period,
      size: def.id === ALL_AGENTS_WIDGET_ID ? 'large' : DEFAULT_WIDGET_SETTINGS.size,
    });
  }, [open, def.id, mode]);

  async function confirm(): Promise<void> {
    setSaving(true);
    try {
      await onPin(settings);
      onOpenChange(false);
      setSettings(DEFAULT_WIDGET_SETTINGS);
    } catch {
      // The page already toasted the error; keep the dialog open to retry.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to desktop</DialogTitle>
          <DialogDescription>
            {def.name} sits on your desktop as a glass widget. Set the fill color, how frosted it
            is, and whether it stays above other windows or only shows with the desktop.
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll className="max-h-[min(28rem,55vh)] space-y-4 pr-1">
          <div
            className="widget-glass card-spot relative overflow-hidden rounded-2xl p-3"
            style={widgetGlassVars(settings.blurPercent, settings.backgroundColor)}
          >
            <div className="widget-sheen" aria-hidden />
            {def.id === ALL_AGENTS_WIDGET_ID ? (
              <AllAgentsCharts
                framed={false}
                compact
                period={settings.period}
                onPeriodChange={(period) => setSettings((s) => ({ ...s, period }))}
              />
            ) : usage ? (
              <UsageCardBody
                usage={usage}
                def={def}
                style={settings.style}
                compact
                mode={mode}
                period={settings.period}
                onPeriodChange={(period) => setSettings((s) => ({ ...s, period }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Usage figures load after you pin it.</p>
            )}
          </div>

          <WidgetSettingsForm value={settings} onChange={setSettings} />
        </OverflowScroll>

        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void confirm()}>
            <Pin className="h-3.5 w-3.5" />
            {saving ? 'Adding…' : 'Add to desktop'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
