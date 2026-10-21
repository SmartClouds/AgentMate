import type { RelayRunView } from '@shared/relayTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Route } from '@/components/icons';
import { segmentClass } from '@/components/layout/statusBarKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { legPhaseLabel } from './relayView';
import { useRelayContext } from './useRelay';

function isLive(run: RelayRunView): boolean {
  return run.status === 'running' || run.status === 'paused' || run.status === 'waiting';
}

/** Running beats paused beats scheduled; a leg waiting on the user beats them all. */
function rank(run: RelayRunView): number {
  if (run.current?.phase === 'awaiting-user') return 0;
  if (run.status === 'running') return 1;
  if (run.status === 'paused') return 2;
  return 3;
}

/** Every live relay across projects: read once per project, then kept current from onRun. */
function useLiveRelays(): RelayRunView[] {
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  const [runs, setRuns] = useState<Record<string, RelayRunView>>({});

  const ids = (projects.data ?? []).map((project) => project.id).join('|');
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    void Promise.all(
      ids.split('|').map((id) =>
        Promise.resolve()
          .then(() => window.agentmat.relay.runs(id))
          .catch((): RelayRunView[] => []),
      ),
    ).then((lists) => {
      if (cancelled) return;
      setRuns((current) => {
        const next = { ...current };
        for (const run of lists.flat()) if (isLive(run)) next[run.id] = run;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ids]);

  useEffect(
    () =>
      window.agentmat.relay.onRun((run) =>
        setRuns((current) => {
          const { [run.id]: _old, ...rest } = current;
          return isLive(run) ? { ...rest, [run.id]: run } : rest;
        }),
      ),
    [],
  );

  return Object.values(runs).sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

/**
 * The status bar's relay item, there only while a relay is live: the task on the move, how far
 * the relay has come and how full the session's context is. A click opens that project's board.
 */
export function RelayStatusSegment(): React.JSX.Element | null {
  const runs = useLiveRelays();
  const open = useRelayBoardStore((s) => s.open);
  const run = runs[0];
  const context = useRelayContext(run?.current?.tabId);
  if (!run) return null;

  const done = run.finished.filter((item) => item.result === 'done').length;
  const total = run.finished.length + run.queue.length + (run.current ? 1 : 0);
  const leg = run.current;
  const used = context?.tokens ?? leg?.contextTokens ?? null;
  const percent = leg && used !== null ? Math.round((used / leg.budget) * 100) : null;
  const waiting = leg?.phase === 'awaiting-user';
  const label =
    run.status === 'waiting'
      ? `Relay scheduled. ${run.triggerText}`
      : `Relay ${leg ? `${leg.taskId}, ${legPhaseLabel(leg.phase, leg.awaiting)}` : run.status === 'paused' ? 'paused' : 'between tasks'}, ${done} of ${total} done`;

  return (
    <SimpleTooltip
      label={
        runs.length > 1
          ? `${label}. ${runs.length - 1} more relay${runs.length > 2 ? 's' : ''} live.`
          : label
      }
      side="top"
    >
      <button
        type="button"
        aria-label={label}
        onClick={() => open(run.projectId, leg?.taskId)}
        className={cn(segmentClass, waiting && 'text-amber-600 dark:text-amber-400')}
      >
        <Route
          aria-hidden
          className={cn('h-3 w-3', run.status === 'running' && !waiting && 'text-primary')}
        />
        {run.status === 'waiting' ? (
          <span>Scheduled</span>
        ) : (
          <>
            <span className="font-medium">
              {leg?.taskId ?? (run.status === 'paused' ? 'Paused' : 'Relay')}
            </span>
            <span className="tabular-nums">
              {done}/{total}
            </span>
            {percent !== null ? <span className="tabular-nums opacity-80">{percent}%</span> : null}
          </>
        )}
        {runs.length > 1 ? <span className="opacity-70">+{runs.length - 1}</span> : null}
      </button>
    </SimpleTooltip>
  );
}
