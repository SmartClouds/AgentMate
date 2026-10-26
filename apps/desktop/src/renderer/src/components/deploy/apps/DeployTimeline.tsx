import { coreErrorMessage } from '@shared/coreErrors';
import type {
  StackDeployStep,
  StackRevisionInfo,
  StackStepState,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useRef, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  History,
  Minus,
  Spinner,
  StopCircle,
} from '@/components/icons';
import { GLASS_CARD, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  formatDuration,
  linesOfStep,
  orderedSteps,
  REVISION_TEXT,
  REVISION_TONE,
  STEP_HINT,
  STEP_STATE_TEXT,
  STEP_TEXT,
  stepDuration,
} from '@/lib/deploy/apps/format';
import { cn } from '@/lib/utils';
import { useJobLines, useNow } from './hooks';
import { StatusPill } from './StatusPill';

/**
 * A deploy as it happens: validate, pull, build, up and health, each with its own state, how long
 * it took (ticking while it runs) and the log lines it wrote. The running or failed step opens by
 * itself. Logs are the core's redacted text, shown as text, never as markup.
 */

function StepMark({ state }: { state: StackStepState }): React.JSX.Element {
  // Inset rings rather than borders: a tinted border would lose to the global border colour.
  const ring =
    'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-inset';
  if (state === 'succeeded') {
    return (
      <span className={cn(ring, 'bg-success/12 text-success ring-success/40')}>
        <CircleCheck className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className={cn(ring, 'bg-destructive/12 text-destructive ring-destructive/50')}>
        <CircleX className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span
        className={cn(
          ring,
          'bg-primary/12 text-primary ring-primary shadow-[0_0_14px_-2px_hsl(var(--primary)/0.7)]',
        )}
      >
        <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
      </span>
    );
  }
  if (state === 'cancelled') {
    return (
      <span className={cn(ring, 'bg-warning/12 text-warning ring-warning/40')}>
        <Ban className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span className={cn(ring, 'text-muted-foreground ring-foreground/[0.12]')}>
        <Minus className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className={cn(ring, 'text-muted-foreground/60 ring-foreground/[0.12]')}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

function StepRow({
  step,
  lines,
  last,
  now,
  expanded,
  onToggle,
}: {
  step: StackDeployStep;
  lines: ReturnType<typeof linesOfStep>;
  last: boolean;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const label = STEP_TEXT[step.kind];
  const duration = stepDuration(step, now);
  const bottom = useRef<HTMLDivElement>(null);
  const logId = `step-log-${step.kind}`;
  const reached = step.state !== 'pending';

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line scrolls to the bottom
  useEffect(() => {
    if (expanded) bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [lines.length, expanded]);

  return (
    <li aria-label={label} className="relative flex gap-3 pb-1">
      {!last && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-7 bottom-0 left-[13px] w-px',
            step.state === 'succeeded' || step.state === 'skipped'
              ? 'bg-success/40'
              : 'bg-foreground/[0.1]',
          )}
        />
      )}
      <StepMark state={step.state} />
      <div className="min-w-0 flex-1 pb-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={!reached}
          aria-expanded={reached ? expanded : undefined}
          aria-controls={reached ? logId : undefined}
          className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block text-sm',
                reached ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            <span className="block text-xs text-muted-foreground">
              {step.state === 'failed' && step.detail ? step.detail : STEP_HINT[step.kind]}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
            <span>{STEP_STATE_TEXT[step.state]}</span>
            {duration !== null && (
              <span className="font-mono tabular-nums text-foreground/80">
                {formatDuration(duration)}
              </span>
            )}
            {reached &&
              (expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              ))}
          </span>
        </button>
        {reached && expanded && (
          <div
            id={logId}
            role="log"
            aria-label={`${label} log`}
            aria-live={step.state === 'running' ? 'polite' : 'off'}
            className={cn(
              SECTION_WELL,
              'mt-2 max-h-64 overflow-auto font-mono text-xs leading-relaxed',
            )}
          >
            {lines.length === 0 ? (
              <p className="text-muted-foreground">
                {step.state === 'running' ? 'Waiting for output…' : 'Nothing was written.'}
              </p>
            ) : (
              lines.map((line) => (
                <div
                  key={line.seq}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    line.source === 'err' && 'text-warning',
                    line.source === 'system' && 'text-muted-foreground',
                  )}
                >
                  {line.text}
                </div>
              ))
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>
    </li>
  );
}

function Summary({ revision }: { revision: StackRevisionInfo }): React.JSX.Element | null {
  const steps = orderedSteps(revision.steps);
  const failed = steps.find((step) => step.state === 'failed');
  const cancelled = steps.some((step) => step.state === 'cancelled');
  if (revision.state === 'live' || (revision.state === 'superseded' && !failed)) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-success">
        <CircleCheck className="h-4 w-4" />
        {revision.state === 'live'
          ? `Revision ${revision.number} is live.`
          : `Revision ${revision.number} deployed, and a later one replaced it.`}
      </p>
    );
  }
  if (cancelled) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-warning">
        <Ban className="h-4 w-4" /> The deploy was cancelled. What ran before keeps running.
      </p>
    );
  }
  if (revision.state === 'failed' || failed) {
    const detail = failed?.detail ?? revision.error;
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleX className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          The deploy failed{failed ? ` at ${STEP_TEXT[failed.kind].toLowerCase()}` : ''}
          {detail ? `: ${detail}` : '.'}
        </span>
      </p>
    );
  }
  return null;
}

export function DeployTimeline({
  serverId,
  revision,
  canOperate,
  onSettled,
  onRollback,
  flat = false,
}: {
  serverId: string;
  revision: StackRevisionInfo;
  canOperate: boolean;
  /** Called once when the job's log ends, so the app is read again. */
  onSettled?: () => void;
  /** Offered on an older revision that ran once. */
  onRollback?: () => void;
  /** Drawn as a soft well instead of a glass card, for a spot already inside one. */
  flat?: boolean;
}): React.JSX.Element {
  const log = useJobLines(serverId, revision.jobId ?? null);
  const steps = orderedSteps(revision.steps);
  const running =
    revision.state === 'deploying' ||
    (log.job?.state === 'running' && !log.ended) ||
    steps.some((step) => step.state === 'running');
  const now = useNow(running);
  const [toggled, setToggled] = useState<Partial<Record<string, boolean>>>({});
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!log.ended || settled.current) return;
    settled.current = true;
    onSettled?.();
  }, [log.ended, onSettled]);

  async function cancel(): Promise<void> {
    if (!revision.jobId) return;
    setCancelling(true);
    setProblem(null);
    try {
      await window.runova.deployJobs.cancel(serverId, revision.jobId);
    } catch (error) {
      setProblem(coreErrorMessage(error));
      setCancelling(false);
    }
  }

  const started = steps.find((step) => step.startedAtUnixMs !== undefined)?.startedAtUnixMs;
  const ended = [...steps].reverse().find((step) => step.finishedAtUnixMs !== undefined);
  const total =
    started === undefined
      ? null
      : (running ? now : (ended?.finishedAtUnixMs ?? revision.finishedAtUnixMs ?? now)) - started;

  return (
    <section
      aria-label={`Deploy of revision ${revision.number}`}
      className={cn(flat ? SECTION_WELL : GLASS_CARD, 'space-y-4 p-4')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">Revision {revision.number}</h4>
        <StatusPill tone={REVISION_TONE[revision.state]}>
          {REVISION_TEXT[revision.state]}
        </StatusPill>
        {revision.rollbackOf !== undefined && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <History className="h-3 w-3" /> rollback of revision {revision.rollbackOf}
          </span>
        )}
        {total !== null && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(total)}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {canOperate && running && revision.jobId && (
            <Button size="sm" variant="soft" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <StopCircle className="h-3.5 w-3.5" />
              )}
              {cancelling ? 'Cancelling…' : 'Cancel the deploy'}
            </Button>
          )}
          {onRollback && !running && (
            <Button size="sm" variant="soft" onClick={onRollback}>
              <History className="h-3.5 w-3.5" /> Roll back to this revision
            </Button>
          )}
        </span>
      </div>
      <ol aria-label="Deploy steps" className="space-y-0">
        {steps.map((step, index) => {
          const auto = step.state === 'running' || step.state === 'failed';
          const expanded = toggled[step.kind] ?? auto;
          return (
            <StepRow
              key={step.kind}
              step={step}
              lines={linesOfStep(log.lines, step)}
              last={index === steps.length - 1}
              now={now}
              expanded={expanded}
              onToggle={() => setToggled((current) => ({ ...current, [step.kind]: !expanded }))}
            />
          );
        })}
      </ol>
      {!revision.jobId && revision.state === 'ready' && (
        <p className="text-sm text-muted-foreground">This revision has not been deployed yet.</p>
      )}
      <Summary revision={revision} />
      {(problem || log.error) && (
        <p role="alert" className="text-sm text-destructive">
          {problem ?? log.error}
        </p>
      )}
    </section>
  );
}
