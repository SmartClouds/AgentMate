import type { OpenWidgetOptions, WidgetPeriod, WidgetSize, WidgetStyle } from '@runova/core';
import { clampWidgetBlurPercent, widgetBackgroundColor } from '@runova/core';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PeriodChips } from './PeriodCompare';

export interface WidgetSettingsValue {
  size: WidgetSize;
  style: WidgetStyle;
  blurPercent: number;
  alwaysOnTop: boolean;
  period: WidgetPeriod;
  /** Hex fill, or null to use the app theme. */
  backgroundColor: string | null;
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettingsValue = {
  size: 'medium',
  style: 'colorful',
  blurPercent: 50,
  alwaysOnTop: true,
  period: 'day',
  backgroundColor: null,
};

const BG_PRESETS: { color: string | null; label: string }[] = [
  { color: null, label: 'Theme' },
  { color: '#0c0c0e', label: 'Ink' },
  { color: '#1a222c', label: 'Slate' },
  { color: '#12182a', label: 'Navy' },
  { color: '#122018', label: 'Forest' },
  { color: '#241016', label: 'Wine' },
  { color: '#2a2218', label: 'Sand' },
  { color: '#e8e4dc', label: 'Frost' },
];

export function settingsToOpenOptions(value: WidgetSettingsValue): OpenWidgetOptions {
  return {
    size: value.size,
    style: value.style,
    blurPercent: clampWidgetBlurPercent(value.blurPercent),
    alwaysOnTop: value.alwaysOnTop,
    period: value.period,
    backgroundColor: widgetBackgroundColor(value.backgroundColor),
  };
}

/** CSS vars the widget glass surface reads for frost amount and fill. */
export function widgetGlassVars(
  blurPercent: number,
  backgroundColor?: string | null,
): React.CSSProperties {
  const p = clampWidgetBlurPercent(blurPercent) / 100;
  const hex = widgetBackgroundColor(backgroundColor);
  return {
    ['--widget-blur' as string]: `${(p * 40).toFixed(1)}px`,
    ['--widget-frost' as string]: (0.28 + p * 0.42).toFixed(3),
    ...(hex ? { ['--widget-bg' as string]: hex } : {}),
  } as React.CSSProperties;
}

const SIZES: { id: WidgetSize; label: string }[] = [
  { id: 'small', label: 'S' },
  { id: 'medium', label: 'M' },
  { id: 'large', label: 'L' },
];

/**
 * Shared controls for pinning a widget and for the in-widget settings overlay:
 * period, frost, fill color, always-on-top vs desktop, size, and color style.
 */
export function WidgetSettingsForm({
  value,
  onChange,
  className,
}: {
  value: WidgetSettingsValue;
  onChange: (next: WidgetSettingsValue) => void;
  className?: string;
}): React.JSX.Element {
  const selectedBg = widgetBackgroundColor(value.backgroundColor);
  const customSelected =
    selectedBg != null && !BG_PRESETS.some((preset) => preset.color === selectedBg);

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground">Period</Label>
        <PeriodChips value={value.period} onChange={(period) => onChange({ ...value, period })} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="widget-blur" className="text-xs text-muted-foreground">
            Background blur
          </Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {clampWidgetBlurPercent(value.blurPercent)}%
          </span>
        </div>
        <input
          id="widget-blur"
          type="range"
          min={0}
          max={100}
          step={1}
          value={clampWidgetBlurPercent(value.blurPercent)}
          onChange={(event) => onChange({ ...value, blurPercent: Number(event.target.value) })}
          className="widget-range w-full"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Background color</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {BG_PRESETS.map((preset) => {
            const active = selectedBg === preset.color;
            return (
              <SimpleTooltip key={preset.label} label={preset.label}>
                <button
                  type="button"
                  aria-label={preset.label}
                  aria-pressed={active}
                  className={cn(
                    'h-6 w-6 rounded-full border transition-shadow',
                    active
                      ? 'border-foreground ring-2 ring-foreground/30 ring-offset-1 ring-offset-background'
                      : 'border-foreground/20 hover:border-foreground/50',
                  )}
                  style={
                    preset.color
                      ? { backgroundColor: preset.color }
                      : {
                          background:
                            'conic-gradient(from 90deg, hsl(var(--card)) 0 50%, hsl(var(--muted)) 50% 100%)',
                        }
                  }
                  onClick={() => onChange({ ...value, backgroundColor: preset.color })}
                />
              </SimpleTooltip>
            );
          })}
          <label
            className={cn(
              'relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border',
              customSelected
                ? 'border-foreground ring-2 ring-foreground/30 ring-offset-1 ring-offset-background'
                : 'border-foreground/20 hover:border-foreground/50',
            )}
            title="Custom color"
          >
            <span
              className="block h-full w-full"
              style={{ backgroundColor: customSelected ? selectedBg : '#888888' }}
            />
            <input
              type="color"
              aria-label="Custom background color"
              value={selectedBg ?? '#888888'}
              onChange={(event) =>
                onChange({
                  ...value,
                  backgroundColor: widgetBackgroundColor(event.target.value),
                })
              }
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="widget-always-on-top" className="text-xs font-medium">
            Always on top
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {value.alwaysOnTop
              ? 'Stays above other windows'
              : 'Sits on the desktop, behind other windows'}
          </p>
        </div>
        <Switch
          id="widget-always-on-top"
          checked={value.alwaysOnTop}
          onCheckedChange={(alwaysOnTop) => onChange({ ...value, alwaysOnTop })}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground">Size</Label>
        <div className="inline-flex rounded-full bg-foreground/8 p-0.5">
          {SIZES.map((option) => {
            const active = option.id === value.size;
            return (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-background/80 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onChange({ ...value, size: option.id })}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground">Style</Label>
        <div className="inline-flex rounded-full bg-foreground/8 p-0.5">
          {(
            [
              { id: 'colorful', label: 'Color' },
              { id: 'mono', label: 'Mono' },
            ] as const
          ).map((option) => {
            const active = option.id === value.style;
            return (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-background/80 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onChange({ ...value, style: option.id })}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
