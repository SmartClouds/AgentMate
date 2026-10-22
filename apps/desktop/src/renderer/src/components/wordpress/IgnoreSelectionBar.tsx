import { EyeOff, Spinner, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The strip that appears while files are ticked in a deploy review: how many, and the two things
 * to do with them. It sticks to the bottom of the scrolling review so it is never off screen.
 */
export function IgnoreSelectionBar({
  count,
  busy = false,
  onIgnore,
  onClear,
  className,
}: {
  count: number;
  busy?: boolean;
  onIgnore: () => void;
  onClear: () => void;
  className?: string;
}): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Selected files"
      className={cn(
        'sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-background/90 px-3 py-2 shadow-lg ring-1 ring-inset ring-foreground/[0.12] backdrop-blur',
        className,
      )}
    >
      <p aria-live="polite" className="min-w-0 flex-1 text-sm tabular-nums">
        {count === 1 ? '1 file selected' : `${count} files selected`}
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="h-3.5 w-3.5" /> Clear
      </Button>
      <Button size="sm" disabled={busy} onClick={onIgnore} aria-label="Ignore selected files">
        {busy ? (
          <Spinner className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <EyeOff className="h-3.5 w-3.5" />
        )}
        Ignore
      </Button>
    </div>
  );
}
