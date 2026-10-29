import { useState } from 'react';
import { Wand2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AutoFixChip } from './AutoFixChip';
import { AutoFixPanel } from './AutoFixPanel';
import { AutoFixSetup, type AutoFixTarget } from './AutoFixSetup';
import { phaseView, sessionForRun } from './autoFixView';
import { useAutoFixSessions } from './useAutoFix';

/**
 * Auto-fix for one run, wherever runs are listed. A run auto-fix is handling shows its chip, which
 * opens the session; a live run without it offers to switch it on. A finished run with no session
 * shows nothing, since auto-fix is switched on while a run is still going.
 */
export function AutoFixControl({
  target,
  live,
  className,
}: {
  target: AutoFixTarget & { runId: number };
  live: boolean;
  className?: string;
}): React.JSX.Element | null {
  const { sessions } = useAutoFixSessions();
  const [open, setOpen] = useState(false);
  const session = sessionForRun(sessions, target.repo, target.runId);

  if (session) {
    const view = phaseView(session);
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Auto-fix: ${view.label}. ${view.description}`}
            className={cn(
              'shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              className,
            )}
          >
            <AutoFixChip session={session} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[22rem]">
          <AutoFixPanel session={session} />
        </PopoverContent>
      </Popover>
    );
  }

  if (!live) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SimpleTooltip label="Fix it with an agent if it fails, then push the fix">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Auto-fix this run if it fails"
            className={cn('h-8 shrink-0 gap-1 px-2 hover:text-primary', className)}
          >
            <Wand2 className="h-3.5 w-3.5" />
            Auto-fix
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent className="w-auto">
        {open ? <AutoFixSetup target={target} onDone={() => setOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}
