import type { SshHardeningChangeInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeploySshOperation,
  DeploySshProgressEvent,
  DeploySshStep,
} from '@shared/deployHardeningTypes';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, Clock, Spinner, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { clock, secondsLeft } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { useTicking } from '../../firewall/hooks';

/**
 * An SSH change on probation: sshd runs the new settings, and the server puts the old ones back
 * at the deadline unless a new SSH connection that signs in with this computer's key keeps it.
 * Keeping opens that connection, which is the proof the app can still get in.
 */

export type SshSteps = Array<{
  step: DeploySshStep;
  state: DeploySshProgressEvent['state'];
  message?: string;
}>;

export const SSH_STEP_LABEL: Record<DeploySshStep, string> = {
  checkingLogin: 'Check that the app signs in with a key',
  openingConnection: 'Open a new SSH connection with the key',
  applying: 'Write, check and reload the sshd settings',
  confirming: 'Keep the change',
  reverting: 'Put the old settings back',
};

/** Each SSH operation's steps as main reports them, for this server. */
export function useSshSteps(serverId: string) {
  const [steps, setSteps] = useState<Record<DeploySshOperation, SshSteps>>({
    apply: [],
    confirm: [],
    revert: [],
  });
  useEffect(
    () =>
      window.runova.deployHardening.onSshProgress((event) => {
        if (event.serverId !== serverId) return;
        setSteps((current) => {
          const list = current[event.operation];
          const entry = { step: event.step, state: event.state, message: event.message };
          const at = list.findIndex((known) => known.step === event.step);
          const next =
            at < 0 ? [...list, entry] : list.map((known, index) => (index === at ? entry : known));
          return { ...current, [event.operation]: next };
        });
      }),
    [serverId],
  );
  const reset = useCallback(
    (operation: DeploySshOperation) => setSteps((current) => ({ ...current, [operation]: [] })),
    [],
  );
  return { steps, reset };
}

export function SshStepList({ steps }: { steps: SshSteps }): React.JSX.Element | null {
  if (steps.length === 0) return null;
  const word = { running: 'in progress', done: 'done', failed: 'failed' } as const;
  return (
    <ol aria-label="Steps" className="space-y-1">
      {steps.map(({ step, state, message }) => (
        <li
          key={step}
          aria-label={`${SSH_STEP_LABEL[step]}: ${word[state]}`}
          className={cn(
            'flex items-start gap-2 text-xs',
            state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {state === 'running' ? (
            <Spinner className="mt-0.5 h-3 w-3 shrink-0 motion-safe:animate-spin" />
          ) : state === 'done' ? (
            <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          ) : (
            <CircleX className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span>
            {SSH_STEP_LABEL[step]}
            {message ? `: ${message}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function SshChangeBanner({
  change,
  windowSeconds,
  busy,
  steps,
  problem,
  canDecide,
  onKeep,
  onRevert,
}: {
  change: SshHardeningChangeInfo;
  windowSeconds: number;
  busy: 'keep' | 'revert' | null;
  steps: SshSteps;
  problem: string | null;
  canDecide: boolean;
  onKeep: () => void;
  onRevert: () => void;
}): React.JSX.Element {
  const now = useTicking(true);
  const left = secondsLeft(change.deadlineUnixMs, now);
  const expired = left === 0;
  const share = Math.min(1, left / Math.max(1, windowSeconds));
  const urgent = left <= 10;
  return (
    <section
      aria-labelledby="keep-ssh-title"
      // It sits inside the checklist card, so it is an inset well rather than a glass card. The
      // ring carries the urgency; a coloured border would lose to the global border colour.
      className={cn(
        'overflow-hidden rounded-xl bg-foreground/[0.02] ring-1 ring-inset',
        urgent ? 'ring-destructive/50' : 'ring-warning/50',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div
          role="timer"
          aria-label={`${left} seconds left`}
          className={cn(
            'flex items-center gap-2 font-mono text-3xl font-semibold tabular-nums leading-none',
            urgent ? 'text-destructive' : 'text-warning',
          )}
        >
          <Clock className="h-5 w-5" />
          {clock(left)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="keep-ssh-title" className="text-sm font-semibold text-foreground">
            {expired ? 'Time is up: the old SSH settings are coming back' : 'Keep the SSH change?'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {change.summary}.{' '}
            {expired
              ? 'The server puts the old settings back by itself.'
              : 'Keeping it signs in once more with the key, under the new settings. At zero the old settings come back by themselves.'}
          </p>
        </div>
        {canDecide ? (
          <div className="flex gap-2">
            <Button size="sm" variant="soft" disabled={busy !== null || expired} onClick={onRevert}>
              {busy === 'revert' ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <Undo className="h-3.5 w-3.5" />
              )}
              Revert
            </Button>
            <Button size="sm" disabled={busy !== null || expired} onClick={onKeep}>
              {busy === 'keep' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Keep the change
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Waiting for {change.requestedBy} to keep it.
          </p>
        )}
      </div>
      {(steps.length > 0 || problem) && (
        <div className="space-y-1 px-4 pb-3">
          <SshStepList steps={steps} />
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
      <div className="h-1 w-full bg-foreground/[0.06]" aria-hidden="true">
        <div
          className={cn(
            'h-full origin-left motion-safe:transition-transform motion-safe:duration-1000 motion-safe:ease-linear',
            urgent ? 'bg-destructive' : 'bg-warning',
          )}
          style={{ transform: `scaleX(${share})` }}
        />
      </div>
    </section>
  );
}
