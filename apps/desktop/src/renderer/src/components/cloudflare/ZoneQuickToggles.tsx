import type { CloudflareZone } from '@shared/cloudflareTypes';
import { Bolt, Shield } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRemaining, SECURITY_LEVEL_LABELS } from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import { levelBeforeAttack, useZoneSettings } from './useZoneSettings';

const TONES = {
  warning: {
    pill: 'bg-warning/10 text-warning ring-warning/30 hover:bg-warning/15',
    icon: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
  },
  destructive: {
    pill: 'bg-destructive/10 text-destructive ring-destructive/35 hover:bg-destructive/15',
    icon: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
} as const;

/**
 * One header switch: an icon, its name and what it is set to, tinted while it is on. The state is
 * written out, so it never rests on the colour alone.
 */
function QuickSwitch({
  label,
  state,
  icon,
  on,
  tone,
  disabled,
  onToggle,
}: {
  label: string;
  state: string;
  icon: React.ReactNode;
  on: boolean;
  tone: keyof typeof TONES;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const colours = TONES[tone];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full py-1 pl-1 pr-3 text-left outline-none ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        on
          ? colours.pill
          : 'bg-foreground/[0.03] text-foreground ring-foreground/10 hover:bg-foreground/[0.06]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5',
          on ? colours.icon : 'bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        {icon}
        {on && (
          <span className="absolute right-0 top-0 flex h-2 w-2">
            <span
              className={cn(
                'absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping',
                colours.dot,
              )}
            />
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', colours.dot)} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium">{label}</span>
        <span
          className={cn(
            'truncate text-[11px] tabular-nums',
            on ? 'opacity-85' : 'text-muted-foreground',
          )}
        >
          {state}
        </span>
      </span>
    </button>
  );
}

/**
 * Development mode and I'm Under Attack, in the zone's header so they are one click away from
 * every tab. Both read the same settings as the tabs. Turning an attack off goes back to the
 * security level from before it, not to a guess.
 */
export function ZoneQuickToggles({ zone }: { zone: CloudflareZone }): React.JSX.Element | null {
  const { query, saving, change } = useZoneSettings(zone);

  if (query.isPending) {
    return (
      <div aria-busy="true" className="flex items-center gap-2">
        <Skeleton className="h-9 w-36 rounded-full" />
        <Skeleton className="h-9 w-36 rounded-full" />
      </div>
    );
  }
  // The open tab shows the problem; the header just leaves the switches out.
  if (query.isError) return null;

  const { developmentMode, securityLevel } = query.data;
  const developmentOn = developmentMode.value === 'on';
  const attackOn = securityLevel.value === 'under_attack';
  const remaining = formatRemaining(developmentMode.secondsRemaining);

  return (
    <div role="group" aria-label="Quick switches" className="flex flex-wrap items-center gap-2">
      <QuickSwitch
        label="Development mode"
        state={developmentOn ? (remaining ? `On, ${remaining}` : 'On') : 'Off'}
        icon={<Bolt />}
        on={developmentOn}
        tone="warning"
        disabled={!developmentMode.editable || saving === 'developmentMode'}
        onToggle={() =>
          void change(
            { setting: 'developmentMode', value: developmentOn ? 'off' : 'on' },
            developmentOn ? 'Development mode is off.' : 'Development mode is on for three hours.',
          )
        }
      />
      <QuickSwitch
        label="I'm Under Attack"
        state={attackOn ? 'On, visitors are checked' : 'Off'}
        icon={<Shield />}
        on={attackOn}
        tone="destructive"
        disabled={!securityLevel.editable || saving === 'securityLevel'}
        onToggle={() => {
          if (attackOn) {
            const level = levelBeforeAttack(zone.id);
            void change(
              { setting: 'securityLevel', value: level },
              `I'm Under Attack is off. Security level is ${SECURITY_LEVEL_LABELS[level]} again.`,
            );
          } else {
            void change(
              { setting: 'securityLevel', value: 'under_attack' },
              "I'm Under Attack is on. Every visitor gets a short check first.",
            );
          }
        }}
      />
    </div>
  );
}
