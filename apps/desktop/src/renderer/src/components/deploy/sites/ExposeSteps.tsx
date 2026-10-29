import { CircleCheck, CircleX, Clock, Minus, Spinner } from '@/components/icons';
import type { ExposeStep, ExposeStepState } from '@/lib/deploy/sites/expose';
import { cn } from '@/lib/utils';

/** The steps that put a port on a domain, each with how far it got and what went wrong. */

const STEP_ICON: Record<ExposeStepState, typeof CircleCheck> = {
  waiting: Clock,
  running: Spinner,
  done: CircleCheck,
  failed: CircleX,
  skipped: Minus,
};

const STEP_WORD: Record<ExposeStepState, string> = {
  waiting: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

const STEP_TONE: Record<ExposeStepState, string> = {
  waiting: 'text-muted-foreground',
  running: 'text-primary motion-safe:animate-spin',
  done: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
};

export function ExposeStepList({
  steps,
  className,
}: {
  steps: ExposeStep[];
  className?: string;
}): React.JSX.Element {
  return (
    <ol className={cn('space-y-1 text-sm', className)}>
      {steps.map((step) => {
        const Icon = STEP_ICON[step.state];
        return (
          <li key={step.id} aria-label={step.label} className="flex items-start gap-2">
            <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', STEP_TONE[step.state])} />
            <span className={cn(step.state === 'waiting' && 'text-muted-foreground')}>
              {step.label} <span className="text-muted-foreground">({STEP_WORD[step.state]})</span>
              {step.detail && (
                <span className="block text-xs text-muted-foreground">{step.detail}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
