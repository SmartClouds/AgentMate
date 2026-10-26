import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Clock, Spinner, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { clock, secondsLeft } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { GLASS_EDGE } from '../deployKit';
import { SECURITY_CARD } from '../security/SecurityCard';
import { StepList, type StepStates } from './StepList';

/**
 * The safe-apply banner: a change is live on the server and undoes itself at the deadline
 * unless it is kept. Keeping it opens a brand-new SSH connection, which is the proof that a new
 * login still gets in. The fuse under the clock burns down with the time left (it holds still
 * when motion is reduced; the clock still counts). A failed keep leaves the countdown running:
 * the change is still waiting, and the timer on the server still reverts it.
 */

/** When the screen reader hears the time left, besides the start. */
const ANNOUNCE_AT = new Set([30, 10]);

export function CountdownBanner({
  change,
  windowSeconds,
  now,
  busy,
  steps,
  problem,
  canDecide,
  onKeep,
  onRevert,
}: {
  change: FirewallChangeSetInfo;
  windowSeconds: number;
  now: number;
  busy: 'keep' | 'revert' | null;
  steps: StepStates;
  problem: string | null;
  /** Admins. Others see the countdown and wait. */
  canDecide: boolean;
  onKeep: () => void;
  onRevert: () => void;
}): React.JSX.Element {
  const deadline = change.deadlineUnixMs;
  const left = deadline === undefined ? null : secondsLeft(deadline, now);
  const expired = left === 0;
  const share = left === null ? 1 : Math.min(1, left / Math.max(1, windowSeconds));
  const urgent = left !== null && left <= 10;

  return (
    <section
      aria-labelledby="keep-changes-title"
      // The edge carries the urgency. It is a ring, since the global border colour repaints a
      // border.
      className={cn(SECURITY_CARD, urgent ? GLASS_EDGE.destructive : GLASS_EDGE.warning)}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
        <div
          role="timer"
          aria-label={left === null ? 'Applying' : `${left} seconds left`}
          className={cn(
            'flex items-center gap-2 font-mono text-3xl font-semibold tabular-nums leading-none',
            urgent ? 'text-destructive' : 'text-warning',
          )}
        >
          <Clock className="h-5 w-5" />
          {left === null ? '--:--' : clock(left)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="keep-changes-title" className="text-sm font-semibold text-foreground">
            {left === null
              ? 'Applying the firewall change'
              : expired
                ? 'Time is up: the old rules are coming back'
                : 'Keep changes?'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {change.summary}.{' '}
            {expired
              ? 'The server puts the old rules back by itself.'
              : 'Keep it if this computer should go on reaching the server. At zero the old rules come back by themselves.'}
          </p>
        </div>
        {canDecide ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="soft"
              disabled={busy !== null || expired || left === null}
              onClick={onRevert}
            >
              {busy === 'revert' ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <Undo className="h-3.5 w-3.5" />
              )}
              Revert
            </Button>
            <Button size="sm" disabled={busy !== null || expired || left === null} onClick={onKeep}>
              {busy === 'keep' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Keep changes
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Waiting for {change.requestedBy ?? 'whoever made it'} to keep it.
          </p>
        )}
      </div>
      {(steps.length > 0 || problem) && (
        <div className="space-y-1 px-4 pb-3.5">
          <StepList steps={steps} />
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
      <div className="h-1 w-full bg-foreground/[0.06]" aria-hidden="true">
        <div
          data-testid="fuse"
          className={cn(
            'h-full origin-left motion-safe:transition-transform motion-safe:duration-1000 motion-safe:ease-linear',
            urgent ? 'bg-destructive' : 'bg-warning',
          )}
          style={{ transform: `scaleX(${share})` }}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        {left !== null && ANNOUNCE_AT.has(left) ? `${left} seconds left to keep the change.` : ''}
      </p>
    </section>
  );
}
