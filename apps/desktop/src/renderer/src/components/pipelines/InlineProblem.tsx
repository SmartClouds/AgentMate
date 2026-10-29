import { CircleX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';

/** A one-line problem with a reason behind a tooltip and a way to try again. */
export function InlineProblem({
  message,
  reason,
  onRetry,
}: {
  message: string;
  reason: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-xl bg-destructive/[0.05] px-3 py-2 text-xs ring-1 ring-inset ring-destructive/15"
    >
      <CircleX className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        <SimpleTooltip label={reason} className="max-w-sm" wrapTrigger>
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {message}
          </span>
        </SimpleTooltip>
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
