import { Pause, Play, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { isPausable, useRunRows } from '@/hooks/useRunRows';
import { pauseRuns, resumeRuns, useRunPauseStore } from '@/stores/runPauseStore';
import { useShortcutLabel } from '@/stores/shortcutStore';

/**
 * Pause or Resume beside Run, for the runs of the project on screen. Only there while one of
 * them is going, so the header does not grow a button that does nothing. It acts on all of the
 * project's runs at once: they usually watch the same files (a web app and its API).
 */
export function PauseProjectRunsButton({
  scopeId,
  projectId,
  projectName,
}: {
  /** The workspace's scope (the project, or one of its worktrees). */
  scopeId: string;
  projectId: string;
  projectName: string;
}): React.JSX.Element | null {
  const rows = useRunRows().filter(
    (row) =>
      isPausable(row) && (row.session.projectId === scopeId || row.session.projectId === projectId),
  );
  const pending = useRunPauseStore((s) => rows.some((row) => s.pending[row.session.id]));
  const shortcut = useShortcutLabel('terminal.togglePauseRun');
  if (rows.length === 0) return null;

  const allPaused = rows.every((row) => row.state === 'paused');
  const ids = rows.map((row) => row.session.id);
  const verb = allPaused ? 'Resume' : 'Pause';
  const label =
    rows.length === 1
      ? `${verb} ${rows[0].session.run.label}`
      : `${verb} ${rows.length} runs of ${projectName}`;
  const detail = allPaused
    ? 'Thaw the processes; they pick up where they were'
    : 'Freeze the processes so they use no CPU';
  const tip = `${label}. ${detail}${rows.length === 1 && shortcut ? ` (${shortcut})` : ''}`;

  return (
    <SimpleTooltip label={tip}>
      <Button
        variant={allPaused ? 'soft' : 'ghost'}
        size="icon"
        aria-label={label}
        disabled={pending}
        className={allPaused ? 'text-warning' : undefined}
        onClick={() => void (allPaused ? resumeRuns(ids) : pauseRuns(ids))}
      >
        {pending ? (
          <Spinner className="h-4 w-4 motion-safe:animate-spin" />
        ) : allPaused ? (
          <Play className="h-4 w-4" />
        ) : (
          <Pause className="h-4 w-4" />
        )}
      </Button>
    </SimpleTooltip>
  );
}
