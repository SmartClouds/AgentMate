import { ENVIRONMENT_KIND_LABELS, type EnvironmentKind } from '@runova/core';
import { cn } from '@/lib/utils';

/**
 * One color per kind. Test uses sky so it doesn't look like Development in green themes.
 * Outlines are `ring-*` (box-shadow) because the global `* { border-color }` rule in index.css is
 * unlayered and wins over Tailwind's border color utilities.
 */
export const KIND_TONES: Record<
  EnvironmentKind,
  { badge: string; dot: string; ring: string; ringSoft: string; selected: string; text: string }
> = {
  production: {
    badge: 'border-destructive/40 bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    ring: 'ring-destructive',
    ringSoft: 'ring-destructive/45',
    selected: 'ring-destructive/60 bg-destructive/10',
    text: 'text-destructive',
  },
  staging: {
    badge: 'border-warning/40 bg-warning/15 text-warning',
    dot: 'bg-warning',
    ring: 'ring-warning',
    ringSoft: 'ring-warning/45',
    selected: 'ring-warning/60 bg-warning/10',
    text: 'text-warning',
  },
  test: {
    badge: 'border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-500',
    ring: 'ring-sky-500',
    ringSoft: 'ring-sky-500/45',
    selected: 'ring-sky-500/60 bg-sky-500/10',
    text: 'text-sky-600 dark:text-sky-400',
  },
  development: {
    badge: 'border-success/40 bg-success/15 text-success',
    dot: 'bg-success',
    ring: 'ring-success',
    ringSoft: 'ring-success/45',
    selected: 'ring-success/60 bg-success/10',
    text: 'text-success',
  },
  custom: {
    badge: 'border-border bg-secondary text-secondary-foreground',
    dot: 'bg-muted-foreground',
    ring: 'ring-foreground/70',
    ringSoft: 'ring-foreground/30',
    selected: 'ring-foreground/40 bg-foreground/5',
    text: 'text-foreground',
  },
};

/** A dot in the kind's color, for dense lists. */
export function EnvironmentKindDot({
  kind,
  className,
}: {
  kind: EnvironmentKind;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', KIND_TONES[kind].dot, className)}
    />
  );
}

export function EnvironmentKindBadge({
  kind,
  className,
}: {
  kind: EnvironmentKind;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        KIND_TONES[kind].badge,
        className,
      )}
    >
      {ENVIRONMENT_KIND_LABELS[kind]}
    </span>
  );
}
