import type { GithubActionsRunErrorInput } from '@shared/apiTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Copies a failed run's annotations and logs, ready to paste at an agent. The main process does
 * the digging, so this is the same button whether it sits in the dashboard history or on a
 * project's workflow row.
 */
export function CopyRunErrorButton({
  input,
  iconOnly,
  className,
}: {
  input: GithubActionsRunErrorInput;
  iconOnly?: boolean;
  className?: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  async function copyError(): Promise<void> {
    setBusy(true);
    try {
      const result = await window.runova.pipelines.runError(input);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await navigator.clipboard.writeText(result.text);
      toast.success('Error copied to clipboard.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not copy that error.');
    } finally {
      setBusy(false);
    }
  }

  const icon = busy ? (
    <Spinner className="h-3.5 w-3.5 animate-spin" />
  ) : (
    <Copy className="h-3.5 w-3.5" />
  );

  return (
    <SimpleTooltip label="Copy the failure from this run">
      <Button
        variant="ghost"
        size={iconOnly ? 'icon' : 'sm'}
        className={cn(iconOnly ? 'shrink-0' : 'h-8 shrink-0 gap-1 px-2', className)}
        disabled={busy}
        aria-label="Copy error"
        onClick={() => void copyError()}
      >
        {icon}
        {iconOnly ? null : 'Copy error'}
      </Button>
    </SimpleTooltip>
  );
}
