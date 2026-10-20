import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useState } from 'react';
import { OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The pieces every status bar item is built from, kept apart from StatusBar.tsx so items in their
 * own files (SftpTransfersSegment) can use them without importing the bar back.
 */

// whitespace-nowrap, because a squeezed segment would wrap and show only its middle line.
export const segmentClass =
  'flex h-full items-center gap-1.5 whitespace-nowrap rounded px-2 transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.07] data-[state=open]:text-foreground';

/** The glass every status bar panel opens as, the same as the app's menus and popovers. */
export const PANEL_SURFACE = cn(
  OVERLAY_SURFACE,
  OVERLAY_MOTION,
  'z-50 overflow-hidden p-3 origin-[var(--radix-popover-content-transform-origin)]',
);

/**
 * A panel opens on its own container, not on its first button, so that button's tooltip stays
 * shut (and one Escape closes the panel rather than only the tooltip).
 */
export function focusPanel(event: Event): void {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.focus();
}

/**
 * A status bar item that opens a panel with the detail behind its number. `label` names the
 * button and is its tooltip, unless `tooltip` gives the tooltip more to say (live numbers that
 * should not change the button's accessible name).
 */
export function PopSegment({
  label,
  tooltip,
  children,
  panel,
  className,
  width = 'w-72',
  onOpenAutoFocus,
}: {
  label: string;
  tooltip?: React.ReactNode;
  children: React.ReactNode;
  panel: React.ReactNode;
  className?: string;
  width?: string;
  onOpenAutoFocus?: (event: Event) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <SimpleTooltip label={open ? null : (tooltip ?? label)} side="top" delayDuration={250}>
        <PopoverPrimitive.Trigger asChild>
          <button type="button" aria-label={label} className={cn(segmentClass, className)}>
            {children}
          </button>
        </PopoverPrimitive.Trigger>
      </SimpleTooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={cn(PANEL_SURFACE, width)}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          {panel}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function PanelTitle({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
        <p className="text-xs font-semibold">{title}</p>
        {detail ? <p className="truncate text-[10px] text-muted-foreground">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}
