import { useReducedMotion } from 'framer-motion';
import { StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatElapsed } from './usePlanJob';

/**
 * The planner at work: a baton running down a track while the CLI reads the project, with the
 * time it has taken so far and a way to stop it. It sits where the result will appear, so the
 * dialog never goes dark behind an overlay. Closing the dialog does not stop it.
 */
export function PlannerProgress({
  cliName,
  elapsed,
  doing,
  onCancel,
}: {
  cliName: string;
  elapsed: number;
  /** What the planner is doing, finishing the sentence "<CLI> is ...". */
  doing: string;
  onCancel: () => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-3 rounded-xl bg-primary/[0.05] px-4 py-3.5 ring-1 ring-primary/20 ring-inset"
    >
      <div className="relative h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 w-1/4 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent',
            reduceMotion
              ? 'left-[37%] opacity-70'
              : 'animate-[relay-baton_1.8s_ease-in-out_infinite]',
          )}
        />
      </div>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm">
          {cliName} is {doing}
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <StopCircle /> Cancel planning
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        It only reads. Nothing is written until you add the tasks. You can close this and keep
        working; you will get a notification when it is ready.
      </p>
    </div>
  );
}
