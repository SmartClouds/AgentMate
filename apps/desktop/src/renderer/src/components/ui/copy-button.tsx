import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A small copy action under a message or next to a command. It turns into a check for a moment
 * once the text is on the clipboard, which screen readers hear too. Inside a `group` it stays
 * quiet until the group is hovered or focused, unless `alwaysVisible`.
 */

const COPIED_FOR_MS = 1500;

export function CopyButton({
  text,
  label,
  alwaysVisible = false,
  className,
}: {
  text: string;
  /** What the button says before it copied ("Copy message"). */
  label: string;
  alwaysVisible?: boolean;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error('Could not copy that.');
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }

  const name = copied ? 'Copied' : label;
  return (
    <>
      <SimpleTooltip label={name}>
        <button
          type="button"
          aria-label={name}
          onClick={() => void copy()}
          className={cn(
            'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,opacity] hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !alwaysVisible &&
              !copied &&
              'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
            copied && 'text-success hover:text-success',
            className,
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </SimpleTooltip>
      {/* Only there while it says so, so a list of messages is not a list of live regions. */}
      {copied && (
        <span role="status" className="sr-only">
          Copied
        </span>
      )}
    </>
  );
}
