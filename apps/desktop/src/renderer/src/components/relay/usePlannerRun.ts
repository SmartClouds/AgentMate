import type { RelayPlannerResult } from '@shared/relayTypes';
import { useEffect, useRef, useState } from 'react';

export type PlannerRunState =
  | { status: 'idle' }
  | { status: 'running'; requestId: string; startedAt: number }
  | { status: 'done'; result: Extract<RelayPlannerResult, { ok: true }> }
  | { status: 'failed'; error: string };

export interface PlannerRun {
  state: PlannerRunState;
  /** Seconds since the planner started, ticking while it runs. */
  elapsed: number;
  start: (run: (requestId: string) => Promise<RelayPlannerResult>) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

function newRequestId(): string {
  return `relay-plan-${crypto.randomUUID()}`;
}

/**
 * One planner run at a time: started with a request id, cancelable by it, and deaf to an answer
 * that lands after the user cancelled or closed the dialog.
 */
export function usePlannerRun(): PlannerRun {
  const [state, setState] = useState<PlannerRunState>({ status: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const live = useRef<string | null>(null);

  useEffect(() => {
    if (state.status !== 'running') return;
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - state.startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [state]);

  // A dialog that closes mid-run stops the planner, so nothing keeps reading the repository.
  useEffect(
    () => () => {
      if (live.current) void window.runova.relay.cancelPlanner(live.current);
      live.current = null;
    },
    [],
  );

  async function start(run: (requestId: string) => Promise<RelayPlannerResult>): Promise<void> {
    const requestId = newRequestId();
    live.current = requestId;
    setState({ status: 'running', requestId, startedAt: Date.now() });
    let result: RelayPlannerResult;
    try {
      result = await run(requestId);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (live.current !== requestId) return;
    live.current = null;
    if (result.ok) setState({ status: 'done', result });
    else if (result.cancelled) setState({ status: 'idle' });
    else setState({ status: 'failed', error: result.error });
  }

  function cancel(): void {
    const requestId = live.current;
    live.current = null;
    if (requestId) void window.runova.relay.cancelPlanner(requestId);
    setState({ status: 'idle' });
  }

  return {
    state,
    elapsed,
    start,
    cancel,
    reset: () => {
      live.current = null;
      setState({ status: 'idle' });
    },
  };
}

/** "0:42", for the planner's progress line. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
