import { GripVertical, type IconProps } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import type { ReorderMotion } from '@/components/ui/ReorderableGroup';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The pieces the Remote page's views share, so Host, Connect, SSH and Remote Desktop read as one
 * set of glass cards with hairline rows, the way Settings lays out its cards.
 */

/** The kit's glass card, clipped so the hairline rows meet its rounded corners. */
export const REMOTE_CARD = cn(GLASS_CARD, 'overflow-hidden');

/** A card's title row: the tinted icon tile, the title and a line about it, and its actions. */
export function RemoteCardHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: React.ForwardRefExoticComponent<IconProps>;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <div className="flex min-w-[min(100%,18rem)] flex-1 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1 pt-0.5">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** One row of a card: what it is on the left, the control for it on the right. */
export function RemoteRow({
  label,
  description,
  control,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-5 py-3.5',
        className,
      )}
    >
      <div className="min-w-[min(100%,14rem)] flex-1 space-y-0.5">
        <div className="text-[13px] font-medium">{label}</div>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>
    </div>
  );
}

/**
 * A saved server's row. A held row lifts off the card while the rows around it slide out of its
 * way, the same motion the Projects list has.
 */
export function serverRowClass(dragging: boolean): string {
  return cn(
    'relative flex flex-wrap items-center gap-x-3 gap-y-2 py-3 pl-2.5 pr-5',
    dragging
      ? 'z-10 rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10 transition-none'
      : 'transition-transform duration-200 ease-out motion-reduce:transition-none',
  );
}

/**
 * The only draggable part of a saved server's row, so pressing its buttons is never mistaken for
 * the start of a reorder.
 */
export function ServerDragGrip({ motion }: { motion: ReorderMotion }): React.JSX.Element {
  return (
    <SimpleTooltip label="Drag to reorder">
      <span
        data-drag-grip
        onPointerDown={motion.onGripPointerDown}
        className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-foreground/[0.08] hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
    </SimpleTooltip>
  );
}

/** Saved servers still loading: rows that shimmer in their own spot inside the card. */
export function ServerRowsSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading servers" className="settings-rows">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 py-3 pl-2.5 pr-5">
          {/* Where a loaded row keeps its drag grip, so the rows don't shift when they arrive. */}
          <span aria-hidden className="w-5 shrink-0" />
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}
