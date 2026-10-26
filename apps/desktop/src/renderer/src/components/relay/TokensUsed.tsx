import { formatTokenCount } from '@runova/core';
import type { RelayTaskCard } from '@shared/relayTypes';
import { cn } from '@/lib/utils';

/** Closer than this share of the estimate and the task counts as right on it. */
const ON_ESTIMATE_SHARE = 0.05;

type Usage = Pick<RelayTaskCard, 'estimate' | 'legCount' | 'legPeaks'>;

/** A task's sessions added up. Each one starts fresh, so its peak is what it took. */
export function tokensUsed(peaks: number[]): number {
  return peaks.reduce((sum, peak) => sum + peak, 0);
}

function verdict(used: number, estimate: number): { text: string; over: boolean } {
  const diff = used - estimate;
  const share = Math.abs(diff) / estimate;
  if (share < ON_ESTIMATE_SHARE) return { text: 'Right on the estimate', over: false };
  const percent = Math.round(share * 100);
  return diff < 0
    ? { text: `${formatTokenCount(-diff)} under the estimate (${percent}%)`, over: false }
    : { text: `${formatTokenCount(diff)} over the estimate (${percent}%)`, over: true };
}

/**
 * Used against estimated on one track: the fill is what the sessions used, the tick is the
 * estimate, and anything past the tick is drawn in amber.
 */
function UsageBar({ used, estimate }: { used: number; estimate: number }): React.JSX.Element {
  const scale = Math.max(used, estimate);
  const within = (Math.min(used, estimate) / scale) * 100;
  const over = used > estimate ? ((used - estimate) / scale) * 100 : 0;
  const tick = (estimate / scale) * 100;
  return (
    <span aria-hidden className="relative block h-1.5 rounded-full bg-foreground/[0.1]">
      <span
        className={cn(
          'absolute inset-y-0 left-0 bg-emerald-500',
          over > 0 ? 'rounded-l-full' : 'rounded-full',
        )}
        style={{ width: `${within}%` }}
      />
      {over > 0 ? (
        <span
          className="absolute inset-y-0 rounded-r-full bg-amber-500"
          style={{ left: `${within}%`, width: `${over}%` }}
        />
      ) : null}
      <span
        className="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-popover-foreground/70"
        style={{ left: `${tick}%` }}
      />
    </span>
  );
}

function TokensUsedCard({
  used,
  estimate,
  peaks,
  unmeasured,
}: {
  used: number;
  estimate: number | null;
  peaks: number[];
  unmeasured: number;
}): React.JSX.Element {
  const outcome = estimate !== null ? verdict(used, estimate) : null;
  return (
    <div className="w-56 space-y-2 py-0.5 whitespace-normal">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
          Tokens used
        </span>
        <span className="text-[10.5px] text-muted-foreground tabular-nums">
          {peaks.length} session{peaks.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[17px] font-semibold leading-none tabular-nums">
          {formatTokenCount(used)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {estimate !== null
            ? `of ~${formatTokenCount(estimate)} estimated`
            : 'no estimate to compare'}
        </span>
      </div>
      {estimate !== null && outcome ? (
        <>
          <UsageBar used={used} estimate={estimate} />
          <p
            className={cn(
              'text-[11px] tabular-nums',
              outcome.over
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400',
            )}
          >
            {outcome.text}
          </p>
        </>
      ) : null}
      {peaks.length > 1 ? (
        <ol className="space-y-0.5 border-t border-foreground/10 pt-1.5 text-[11px]">
          {peaks.map((peak, index) => (
            <li key={index} className="flex justify-between gap-2 tabular-nums">
              <span className="text-muted-foreground">Session {index + 1}</span>
              <span>{formatTokenCount(peak)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {unmeasured > 0 ? (
        <p className="text-[10.5px] text-muted-foreground">
          {unmeasured} more session{unmeasured === 1 ? '' : 's'} left no reading.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a finished task's tooltip says about the tokens it took: the total its sessions used set
 * against the planner's estimate. A session's figure is the most context it held, so a task that
 * ran over several sessions adds them up. Null when there is nothing worth showing.
 */
export function tokensUsedLabel(task: Usage): React.ReactNode {
  if (task.legPeaks.length === 0) {
    if (task.estimate === null) return null;
    return task.legCount === 0
      ? 'Finished outside a Relay session, so there is no token count to compare with the estimate.'
      : 'Its sessions left no token reading to compare with the estimate.';
  }
  return (
    <TokensUsedCard
      used={tokensUsed(task.legPeaks)}
      estimate={task.estimate}
      peaks={task.legPeaks}
      unmeasured={task.legCount - task.legPeaks.length}
    />
  );
}
