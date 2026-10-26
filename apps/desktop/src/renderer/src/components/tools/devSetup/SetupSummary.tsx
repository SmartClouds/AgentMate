import type { SetupSummary as Summary } from '@runova/core';
import { RefreshCw, Spinner } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { summaryHeadline, summarySubline, type UpdateStatus } from './devSetupView';

export interface InstallAllControl {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled, shown on hover. */
  hint?: string;
  /** What it will leave for the person to do, shown under the buttons. */
  note?: string | null;
}

/** An install run in progress, which takes over the card until it ends. */
export interface RunControl {
  headline: string;
  subline: string;
  /** How far through the whole run it is, 0 to 1. */
  fraction: number;
  onCancel: () => void;
  /** What the cancel button says. Defaults to "Cancel install". */
  cancelLabel?: string;
}

/**
 * The card at the top of the checklist: how far along the machine is, and the buttons that act on
 * all of it at once. The bar is a real progressbar, so a screen reader reads out the same count
 * the headline shows. While an install runs the card speaks of the run instead.
 */
export function SetupSummary({
  summary,
  onRecheckAll,
  installAll,
  updateAll,
  updatesStatus,
  run,
}: {
  summary: Summary;
  onRecheckAll: () => void;
  installAll?: InstallAllControl;
  /** Brings what is installed up to date. Led with only when nothing is missing. */
  updateAll?: InstallAllControl;
  /** How the search for newer versions is going, said under the headline. */
  updatesStatus?: UpdateStatus;
  run?: RunControl;
}): React.JSX.Element {
  const readyPercent = summary.total === 0 ? 0 : Math.round((summary.ready / summary.total) * 100);
  const runPercent = run ? Math.round(Math.min(1, Math.max(0, run.fraction)) * 100) : 0;
  const note = run ? null : [installAll?.note, updateAll?.note].filter(Boolean).join(' ');
  const searching = !run && updatesStatus === 'checking' && summary.checking === 0;

  return (
    <section aria-label="Setup progress" className={cn(GLASS_CARD, 'p-4')}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight">
            {run ? run.headline : summaryHeadline(summary)}
          </h2>
          <p
            aria-live="polite"
            className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            {searching && (
              <Spinner
                aria-hidden
                className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none"
              />
            )}
            <span>{run ? run.subline : summarySubline(summary, updatesStatus)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="soft" size="sm" disabled={Boolean(run)} onClick={onRecheckAll}>
            <RefreshCw /> Check again
          </Button>
          {run ? (
            <Button variant="danger" size="sm" onClick={run.onCancel}>
              {run.cancelLabel ?? 'Cancel install'}
            </Button>
          ) : (
            <>
              {updateAll && (
                <SimpleTooltip label={updateAll.hint} wrapTrigger={Boolean(updateAll.disabled)}>
                  <Button
                    size="sm"
                    variant={installAll ? 'tint' : 'default'}
                    disabled={updateAll.disabled}
                    onClick={updateAll.onClick}
                  >
                    {updateAll.label}
                  </Button>
                </SimpleTooltip>
              )}
              {installAll && (
                <SimpleTooltip label={installAll.hint} wrapTrigger={Boolean(installAll.disabled)}>
                  <Button size="sm" disabled={installAll.disabled} onClick={installAll.onClick}>
                    {installAll.label}
                  </Button>
                </SimpleTooltip>
              )}
            </>
          )}
        </div>
      </div>

      {note && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>}

      {(run || summary.total > 0) && (
        <div
          role="progressbar"
          aria-label="Dev setup progress"
          aria-valuemin={0}
          aria-valuemax={run ? 100 : summary.total}
          aria-valuenow={run ? runPercent : summary.ready}
          aria-valuetext={run ? run.headline : `${summary.ready} of ${summary.total} ready`}
          className="mt-3 h-2 overflow-hidden rounded-full bg-foreground/10"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
              !run && summary.complete ? 'bg-success' : 'bg-primary',
            )}
            style={{ width: `${run ? runPercent : readyPercent}%` }}
          />
        </div>
      )}
    </section>
  );
}
