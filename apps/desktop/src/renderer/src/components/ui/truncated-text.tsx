import { useLayoutEffect, useRef, useState } from 'react';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

// Spelled out, so Tailwind sees every class it has to generate.
const CLAMP: Record<number, string> = {
  1: 'truncate',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
};

function isCutOff(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

/**
 * Text cut to one line (or a few, with `lines`) that shows all of itself in a tooltip on hover or
 * keyboard focus, but only when something was actually cut off. The bubble is wider than a
 * label's and scrolls, so even a long question from the AI can be read in full where it sits.
 */
export function TruncatedText({
  text,
  children,
  lines = 1,
  className,
  side = 'bottom',
  focusable = true,
}: {
  /** The whole text, which the tooltip shows. */
  text: string;
  /** What the line shows instead of `text`, such as a command in code style. */
  children?: React.ReactNode;
  /** How many lines show before the rest is cut. One line ends in an ellipsis. */
  lines?: 1 | 2 | 3 | 4;
  className?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Whether cut-off text takes a Tab stop of its own. Off inside a button or link, which is
   * already the stop; the tooltip still shows on hover.
   */
  focusable?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cutOff, setCutOff] = useState(false);
  const persian = persianTextProps(text);

  // Measured up front as well as on open, so only text with more to read takes a Tab stop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text wraps differently, and the observer only sees size changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCutOff(isCutOff(el));
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, [text, lines]);

  return (
    <Tooltip
      open={open}
      delayDuration={300}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && el !== null && isCutOff(el));
      }}
    >
      <TooltipTrigger asChild>
        <span
          ref={ref}
          dir={persian.dir}
          tabIndex={cutOff && focusable ? 0 : undefined}
          className={cn(
            'min-w-0',
            lines === 1 ? 'block' : 'break-words',
            CLAMP[lines],
            persian.className,
            cutOff &&
              focusable &&
              'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {children ?? text}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-h-[50vh] max-w-[min(32rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap font-normal"
      >
        <span dir={persian.dir} className={cn('block', persian.className)}>
          {text}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
