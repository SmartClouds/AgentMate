import type { GitChangeStatus } from '@runova/core';
import type { ChipTone } from '@/components/pageKit';
import { changeStatusMeta } from '@/lib/git';
import { cn } from '@/lib/utils';

/**
 * The theme colour a change status is tinted with, the same buckets the Project detail Git tab
 * uses: added is green, modified amber, deleted and conflicted red, renamed and copied primary.
 */
export function statusTone(status: GitChangeStatus): ChipTone {
  switch (status) {
    case 'A':
    case '?':
      return 'success';
    case 'D':
    case 'U':
      return 'destructive';
    case 'R':
    case 'C':
      return 'primary';
    default:
      return 'warning';
  }
}

const LETTER_TONE: Record<ChipTone, string> = {
  neutral: 'bg-foreground/[0.06] text-muted-foreground',
  primary: 'bg-primary/12 text-primary',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  destructive: 'bg-destructive/12 text-destructive',
};

const TEXT_TONE: Record<ChipTone, string> = {
  neutral: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/** The text colour for a file name that carries this status, as in the explorer tree. */
export function statusTextClass(status: GitChangeStatus): string {
  return TEXT_TONE[statusTone(status)];
}

/**
 * A change status as a small tinted letter chip (M, A, D, U, !). It is named for screen
 * readers, since the letter alone says little.
 */
export function StatusLetter({
  status,
  className,
}: {
  status: GitChangeStatus;
  className?: string;
}): React.JSX.Element {
  const meta = changeStatusMeta(status);
  return (
    <span
      role="img"
      aria-label={meta.label}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[5px] px-0.5 font-mono text-[10px] font-semibold leading-none',
        LETTER_TONE[statusTone(status)],
        className,
      )}
    >
      {meta.letter}
    </span>
  );
}
