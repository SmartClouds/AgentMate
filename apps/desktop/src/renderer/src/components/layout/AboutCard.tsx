import icon28 from '@/assets/app-icon-28.webp';
import icon56 from '@/assets/app-icon-56.webp';
import icon72 from '@/assets/app-icon-72.webp';
import icon144 from '@/assets/app-icon-144.webp';
import iconLight28 from '@/assets/app-icon-light-28.webp';
import iconLight56 from '@/assets/app-icon-light-56.webp';
import iconLight72 from '@/assets/app-icon-light-72.webp';
import iconLight144 from '@/assets/app-icon-light-144.webp';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useIsDarkMode } from '@/lib/chartColors';
import { cn } from '@/lib/utils';
import { openAbout } from '@/stores/aboutStore';
import { PUBLISHER, useUpdateCheck } from './mainNav';

/*
 * Small copies of the app icon (assets/app-icon*.png is 512px). They come in the widths these
 * spots draw at, 28 and 72, plus double for HiDPI, and the browser picks from `sizes`, so a
 * 150% Windows display gets the next size up instead of a blurry stretch. The light theme gets
 * the variant with the dark stroke, the same switch the title bar makes.
 */
const APP_ICON_DARK = `${icon28} 28w, ${icon56} 56w, ${icon72} 72w, ${icon144} 144w`;
const APP_ICON_LIGHT = `${iconLight28} 28w, ${iconLight56} 56w, ${iconLight72} 72w, ${iconLight144} 144w`;

/** Runova's own icon in the colours that suit the current theme, drawn `size` px square. */
export function AppIcon({
  size,
  alt = '',
  className,
}: {
  size: number;
  /** Empty when the icon sits inside something that already says Runova. */
  alt?: string;
  className?: string;
}): React.JSX.Element {
  const isDark = useIsDarkMode();
  return (
    <img
      src={isDark ? icon72 : iconLight72}
      srcSet={isDark ? APP_ICON_DARK : APP_ICON_LIGHT}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={alt}
      decoding="async"
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  );
}

/**
 * The version chip, shared by the sidebar's about card and the top menu bar so the two read as
 * the same thing. A faint primary tint lifts it off the glass without shouting.
 */
export const VERSION_CHIP =
  'inline-flex shrink-0 select-none items-center gap-1 rounded-full bg-primary/12 font-medium leading-none tabular-nums text-primary ring-1 ring-inset ring-primary/15';

/** The chip's text: the version, or a pulsing "Checking…" while a check runs. */
export function VersionChipLabel({
  versionText,
  checking,
  fallback = '',
}: {
  versionText: string;
  checking: boolean;
  /** Shown when the version is not known yet. */
  fallback?: string;
}): React.JSX.Element {
  if (checking) {
    return (
      <>
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
        />
        Checking…
      </>
    );
  }
  return <>{versionText || fallback}</>;
}

/** A small primary dot that marks a waiting update. */
export function UpdateDot({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'h-2 w-2 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.8)]',
        className,
      )}
    />
  );
}

/*
 * .glass is plain (unlayered) CSS, so it outranks Tailwind's background and border utilities on
 * the same element. Hover feedback therefore comes from an overlay span. Focus is an outline set
 * off from the card. The base is outline-hidden, since outline-none would also cancel that focus
 * outline.
 */
const CARD_BASE =
  'glass group relative overflow-hidden rounded-[calc(var(--radius)+2px)] outline-hidden transition-transform active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60';
const HOVER_WASH =
  'pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/0 transition-colors group-hover:bg-primary/[0.07]';

/**
 * The foot of the sidebar: the Runova icon, the app's name and maker, and the running
 * version. The whole card opens the About dialog. On the icon rail it shrinks to just the icon.
 */
export function AboutCard({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { label, tooltip, versionText, checking, updatePending } = useUpdateCheck();

  if (collapsed) {
    return (
      <SimpleTooltip label={tooltip} side="right">
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-busy={checking}
          onClick={openAbout}
          // The same 34px square and corner as the nav entries above it, so the rail reads as one
          // column. The glass and the icon keep it apart as the about card.
          className={cn(
            CARD_BASE,
            'mx-auto mt-1 flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg',
          )}
        >
          <span aria-hidden className={HOVER_WASH} />
          <AppIcon
            size={24}
            className={cn(
              'relative transition-transform group-hover:scale-105',
              checking && 'motion-safe:animate-pulse',
            )}
          />
          {updatePending && <UpdateDot className="absolute right-0.5 top-0.5" />}
        </button>
      </SimpleTooltip>
    );
  }

  return (
    <SimpleTooltip label={tooltip} side="top" align="start">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-busy={checking}
        onClick={openAbout}
        className={cn(
          CARD_BASE,
          'mt-1 flex w-full shrink-0 items-center gap-2 px-2 py-2 text-left',
        )}
      >
        <span aria-hidden className={HOVER_WASH} />
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
          <AppIcon
            size={28}
            className={cn(
              'transition-transform group-hover:scale-105',
              checking && 'motion-safe:animate-pulse',
            )}
          />
          {updatePending && <UpdateDot className="absolute -right-0.5 -top-0.5" />}
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight text-foreground">
            Runova
          </span>
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">
            by {PUBLISHER}
          </span>
        </span>
        {(versionText || checking) && (
          <span className={cn(VERSION_CHIP, 'relative h-5 px-1.5 text-[10px]')}>
            <VersionChipLabel versionText={versionText} checking={checking} />
          </span>
        )}
      </button>
    </SimpleTooltip>
  );
}
