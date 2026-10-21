import { formatTokenCount } from '@agentmat/core';
import type { RelayRunView } from '@shared/relayTypes';
import { useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  CircleCheck,
  Clock,
  Pause,
  Play,
  StopCircle,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { FuelRing } from './FuelRing';
import { choiceLabel, legPhaseLabel } from './relayView';
import { useRelayActions, useRelayContext } from './useRelay';

/** Opens the workspace on a leg's tab. */
export function useGoToTab(): (projectId: string, tabId: string) => void {
  const navigate = useNavigate();
  return (projectId, tabId) => {
    const store = useWorkspaceStore.getState();
    store.openProject(projectId);
    if (store.workspaces[projectId]?.tabs[tabId]) store.activateTab(projectId, tabId);
    navigate(`/workspace/${projectId}`);
  };
}

/**
 * The relay running on a project, in one line: the leg on the move with its fuel ring, what it is
 * doing, and the controls that make sense right now.
 */
export function RelayLiveStrip({
  run,
  compact = false,
}: {
  run: RelayRunView;
  compact?: boolean;
}): React.JSX.Element {
  const { pause, resume, cancel, markDone } = useRelayActions();
  const goToTab = useGoToTab();
  const reduceMotion = useReducedMotion();
  const leg = run.current;
  const context = useRelayContext(leg?.tabId);
  const used = context?.tokens ?? leg?.contextTokens ?? null;
  const waiting = leg?.phase === 'awaiting-user';
  const paused = run.status === 'paused';

  const headline =
    run.status === 'waiting'
      ? run.triggerText
      : leg
        ? `${leg.taskId} · ${legPhaseLabel(leg.phase, leg.awaiting)}`
        : paused
          ? 'Paused between tasks'
          : 'Between tasks';
  const detail =
    paused && run.pauseReason
      ? run.pauseReason
      : waiting && leg?.awaiting
        ? leg.awaiting.message
        : leg
          ? `Session ${leg.legNo} · ${choiceLabel(leg.choice)}${
              used !== null ? ` · ${formatTokenCount(used)} of ${formatTokenCount(leg.budget)}` : ''
            }`
          : `${run.queue.length} task${run.queue.length === 1 ? '' : 's'} to go`;

  return (
    <section
      aria-label="Relay in progress"
      className={cn(
        'relative overflow-hidden rounded-xl border px-3 py-2.5',
        waiting || paused
          ? 'border-amber-500/40 bg-amber-500/[0.07]'
          : 'border-primary/30 bg-primary/[0.06]',
      )}
    >
      {!reduceMotion && !waiting && !paused && run.status === 'running' ? (
        <span
          aria-hidden
          className="relay-baton-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-primary/15 to-transparent"
        />
      ) : null}
      <div className="relative flex items-center gap-2.5">
        {leg ? (
          <FuelRing
            used={used}
            budget={leg.budget}
            guardAt={context?.guardAt ?? leg.guardAt}
            size={30}
          >
            {waiting ? (
              <TriangleAlert aria-hidden className="h-3 w-3 text-amber-500" />
            ) : (
              <span
                aria-hidden
                className="h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]"
              />
            )}
          </FuelRing>
        ) : (
          <Clock aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold">{headline}</p>
          <p className="truncate text-[11px] text-muted-foreground">{detail}</p>
        </div>
        <div className={cn('flex shrink-0 items-center gap-0.5', compact && 'gap-0')}>
          {leg?.tabId ? (
            <SimpleTooltip label="Go to its tab">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Go to its tab"
                onClick={() => goToTab(run.projectId, leg.tabId as string)}
              >
                <TerminalSquare />
              </Button>
            </SimpleTooltip>
          ) : null}
          {waiting && leg ? (
            <SimpleTooltip label={`Count ${leg.taskId} as done and go on`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Mark ${leg.taskId} done`}
                onClick={() => void markDone(run, leg.taskId)}
              >
                <CircleCheck />
              </Button>
            </SimpleTooltip>
          ) : null}
          {paused ? (
            <SimpleTooltip label="Resume the relay">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Resume the relay"
                onClick={() => void resume(run)}
              >
                <Play />
              </Button>
            </SimpleTooltip>
          ) : (
            <SimpleTooltip label="Pause after this session">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Pause the relay"
                onClick={() => void pause(run)}
              >
                <Pause />
              </Button>
            </SimpleTooltip>
          )}
          <SimpleTooltip label="Stop the relay">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Stop the relay"
              onClick={() => void cancel(run)}
            >
              <StopCircle />
            </Button>
          </SimpleTooltip>
        </div>
      </div>
    </section>
  );
}
