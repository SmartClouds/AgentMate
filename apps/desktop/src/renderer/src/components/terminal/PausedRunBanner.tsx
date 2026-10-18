import { Pause, Play, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { resumeRuns, useRunPause } from '@/stores/runPauseStore';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * The strip over a paused run's terminal. A frozen run prints nothing and seems to ignore what
 * you type (the shell reads it once it runs again), so without this the terminal looks hung.
 */
export function PausedRunBanner({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { paused, pending } = useRunPause(sessionId);
  const label = useTerminalStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.run?.label ?? 'run',
  );
  if (!paused) return null;

  const byAgent = paused.reason === 'agent';
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-warning/25 bg-warning/10 px-3 py-1.5 text-[11px]"
    >
      <Pause className="h-3 w-3 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 leading-snug">
        {byAgent ? (
          <>
            <span className="font-medium">Paused while an agent works in this folder.</span>{' '}
            <span className="text-muted-foreground">
              It resumes on its own a few seconds after the agent is done.
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">Paused. Its processes are frozen and use no CPU.</span>{' '}
            <span className="text-muted-foreground">
              What you type and any file changes are handled when you resume.
            </span>
          </>
        )}
      </p>
      <Button
        variant="soft"
        size="xs"
        aria-label={`Resume ${label}`}
        disabled={pending !== null}
        onClick={() => void resumeRuns([sessionId])}
      >
        {pending ? <Spinner className="motion-safe:animate-spin" /> : <Play />}
        {pending === 'resuming' ? 'Resuming' : 'Resume'}
      </Button>
    </div>
  );
}
