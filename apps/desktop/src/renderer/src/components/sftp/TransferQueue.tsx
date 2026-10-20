import { formatBytes } from '@shared/remoteProtocol';
import type { SftpBatchState, SftpBatchView, SftpJobKind, SftpTarget } from '@shared/sftpTypes';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { durationText } from '@/components/deploy/files/copy';
import { filesProblem, filesProblemText } from '@/components/deploy/files/messages';
import { ChevronDown, Download, Lock, RotateCw, Trash2, Upload, X } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE, GLASS_PANEL, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TransferQueueProps } from './contracts';

/**
 * The Transfers card at the bottom of the SFTP file manager (E25). One hairline row per batch:
 * what it is, how far it got (items, bytes, speed, time left), its state in words, and the
 * buttons that cancel or retry it. The header holds the actions for the whole queue and folds the
 * card down to one line. Every click goes to the page through the props; nothing here talks to
 * the bridge.
 */

const ACTIVE: ReadonlySet<SftpBatchState> = new Set(['expanding', 'queued', 'running', 'waiting']);

const KIND: Record<SftpJobKind, { Icon: typeof Upload; noun: string }> = {
  upload: { Icon: Upload, noun: 'Upload' },
  download: { Icon: Download, noun: 'Download' },
  delete: { Icon: Trash2, noun: 'Delete' },
  chmod: { Icon: Lock, noun: 'Permissions' },
};

const count = (n: number): string => n.toLocaleString('en-US');

function isActive(b: SftpBatchView): boolean {
  return ACTIVE.has(b.state);
}

function canRetry(b: SftpBatchView): boolean {
  return b.state === 'failed' || b.state === 'cancelled' || (!isActive(b) && b.failedItems > 0);
}

/** How far the batch is, 0 to 100: by bytes when it moves any, else by items. */
function percentOf(b: SftpBatchView): number {
  const processed = b.doneItems + b.failedItems + b.skippedItems;
  const raw =
    b.totalBytes && b.totalBytes > 0
      ? b.transferredBytes / b.totalBytes
      : b.totalItems && b.totalItems > 0
        ? processed / b.totalItems
        : 0;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

/** "1 running, 1 waiting for you", for the folded header. */
function summaryText(batches: SftpBatchView[]): string {
  const running = batches.filter((b) => b.state === 'running' || b.state === 'expanding').length;
  const queued = batches.filter((b) => b.state === 'queued').length;
  const waiting = batches.filter((b) => b.state === 'waiting').length;
  const failed = batches.filter((b) => b.state === 'failed').length;
  const parts = [
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
    waiting > 0 ? `${waiting} waiting for you` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'All finished';
}

/** Runs a callback once at a time per key, and says which keys are still running. */
function usePending(): {
  pending: ReadonlySet<string>;
  run: (key: string, fn: () => void | Promise<void>) => void;
} {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  function run(key: string, fn: () => void | Promise<void>): void {
    if (pending.has(key)) return;
    setPending((now) => new Set(now).add(key));
    void Promise.resolve()
      .then(fn)
      .catch((error: unknown) => toast.error(filesProblem(error)))
      .finally(() =>
        setPending((now) => {
          const next = new Set(now);
          next.delete(key);
          return next;
        }),
      );
  }
  return { pending, run };
}

export function TransferQueue({
  snapshot,
  onCancel,
  onRetry,
  onClearFinished,
  className,
}: TransferQueueProps): React.JSX.Element | null {
  const [open, setOpen] = useState(true);
  const { pending, run } = usePending();
  const bodyId = useId();
  const batches = snapshot?.batches ?? [];
  if (batches.length === 0) return null;

  const anyActive = batches.some(isActive);
  const anyRetry = batches.some(canRetry);
  const anyFinished = batches.some((b) => !isActive(b));

  const cancel = (target: SftpTarget, key: string): void => run(key, () => onCancel(target));
  const retry = (target: SftpTarget, key: string): void => run(key, () => onRetry(target));

  return (
    <section aria-label="Transfers" className={cn(GLASS_PANEL, 'min-h-0', className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 pl-2 pr-3">
        <SimpleTooltip label={open ? 'Hide transfers' : 'Show transfers'}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={open ? 'Hide transfers' : 'Show transfers'}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown
              className={cn('transition-transform duration-150', !open && '-rotate-90')}
            />
          </Button>
        </SimpleTooltip>
        <h2 className={SECTION_HEADING}>Transfers</h2>
        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-muted-foreground">
          {batches.length}
        </span>
        {!open && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {summaryText(batches)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {anyRetry && (
            <Button
              size="xs"
              variant="soft"
              disabled={pending.has('retry-all')}
              onClick={() => retry({}, 'retry-all')}
            >
              <RotateCw />
              Retry failed
            </Button>
          )}
          {anyFinished && (
            <Button
              size="xs"
              variant="soft"
              disabled={pending.has('clear')}
              onClick={() => run('clear', onClearFinished)}
            >
              Clear finished
            </Button>
          )}
          {anyActive && (
            <Button
              size="xs"
              variant="danger"
              disabled={pending.has('cancel-all')}
              onClick={() => cancel({}, 'cancel-all')}
            >
              <X />
              Cancel all
            </Button>
          )}
        </div>
      </div>
      {open && (
        <ul
          id={bodyId}
          className={cn('settings-rows rail-scroll min-h-0 overflow-y-auto', FOOTER_HAIRLINE)}
        >
          {batches.map((b) => (
            <BatchRow
              key={b.batchId}
              batch={b}
              pending={pending}
              onCancel={cancel}
              onRetry={retry}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BatchRow({
  batch: b,
  pending,
  onCancel,
  onRetry,
}: {
  batch: SftpBatchView;
  pending: ReadonlySet<string>;
  onCancel: (target: SftpTarget, key: string) => void;
  onRetry: (target: SftpTarget, key: string) => void;
}): React.JSX.Element {
  const [showFailures, setShowFailures] = useState(false);
  const failuresId = useId();
  const { Icon, noun } = KIND[b.kind];
  const active = isActive(b);
  const failed = b.state === 'failed';
  const percent = percentOf(b);
  const processed = b.doneItems + b.failedItems + b.skippedItems;
  const moved = b.totalBytes !== null && b.totalBytes > 0;
  const cancelKey = `cancel:${b.batchId}`;
  const retryKey = `retry:${b.batchId}`;
  const route = b.target ? `From ${b.source}\nTo ${b.target}` : b.source;

  return (
    <li className="flex flex-col gap-1.5 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5 text-xs">
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            failed
              ? 'bg-destructive/12 text-destructive'
              : b.state === 'done'
                ? 'bg-success/12 text-success'
                : b.state === 'cancelled'
                  ? 'bg-foreground/[0.06] text-muted-foreground'
                  : 'bg-primary/12 text-primary',
          )}
        >
          <Icon className="h-3 w-3" />
          <span className="sr-only">{noun}</span>
        </span>
        <SimpleTooltip label={route} align="start">
          <span className="min-w-0 flex-1 truncate font-medium">{b.label}</span>
        </SimpleTooltip>
        <span className="flex shrink-0 items-center gap-1.5">
          {b.state === 'waiting' && (
            <Chip tone="warning" dot pulse>
              Waiting for your answer
            </Chip>
          )}
          {b.state === 'queued' && <Chip>Queued</Chip>}
          {/* A batch whose files were all skipped did nothing, so it says only Skipped. */}
          {b.state === 'done' && (b.doneItems > 0 || b.skippedItems === 0) && (
            <Chip tone="success">Done</Chip>
          )}
          {b.state === 'cancelled' && <Chip>Cancelled</Chip>}
          {b.skippedItems > 0 && <Chip>{`Skipped ${count(b.skippedItems)}`}</Chip>}
          {b.failedItems > 0 && (
            <button
              type="button"
              aria-expanded={showFailures}
              aria-controls={failuresId}
              onClick={() => setShowFailures(!showFailures)}
              className="cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Chip tone="destructive">
                {`Failed ${count(b.failedItems)}`}
                <ChevronDown
                  className={cn('transition-transform duration-150', !showFailures && '-rotate-90')}
                />
              </Chip>
            </button>
          )}
          {active ? (
            <SimpleTooltip label="Cancel this transfer">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Cancel ${b.label}`}
                disabled={pending.has(cancelKey)}
                onClick={() => onCancel({ batchId: b.batchId }, cancelKey)}
                className="hover:bg-destructive/10 hover:text-destructive"
              >
                <X />
              </Button>
            </SimpleTooltip>
          ) : canRetry(b) ? (
            <SimpleTooltip label="Try again">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Retry ${b.label}`}
                disabled={pending.has(retryKey)}
                onClick={() => onRetry({ batchId: b.batchId }, retryKey)}
              >
                <RotateCw />
              </Button>
            </SimpleTooltip>
          ) : null}
        </span>
      </div>

      {active && (
        <div
          role="progressbar"
          aria-label={`${b.label} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={b.state === 'expanding' ? undefined : percent}
          className="ml-8.5 h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
        >
          {b.state === 'expanding' ? (
            <div className="h-full w-1/3 rounded-full bg-primary/60 motion-safe:animate-pulse" />
          ) : (
            <div
              className="h-full rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)] transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      )}

      <p className="ml-8.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted-foreground">
        {b.totalItems === null ? (
          <span>Counting files…</span>
        ) : (
          <span>{`${count(processed)} of ${count(b.totalItems)}`}</span>
        )}
        {moved && (
          <span>{`${formatBytes(b.transferredBytes)} / ${formatBytes(b.totalBytes ?? 0)}`}</span>
        )}
        {active && b.state !== 'waiting' && b.bytesPerSecond !== null && (
          <span>{`${formatBytes(Math.round(b.bytesPerSecond))}/s`}</span>
        )}
        {active && b.state !== 'waiting' && b.etaSeconds !== null && (
          <span>{`${durationText(b.etaSeconds * 1000)} left`}</span>
        )}
      </p>

      {active && b.running.length > 0 && b.totalItems !== 1 && (
        <ul aria-label="Files on their way" className="ml-8.5 space-y-0.5">
          {b.running.map((it) => (
            <li
              key={it.itemId}
              className="flex items-center gap-2 text-[11px] text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
                {it.relPath}
              </span>
              <span className="shrink-0 tabular-nums">
                {`${it.size > 0 ? Math.min(100, Math.round((it.transferred / it.size) * 100)) : 0}%`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {showFailures && b.failedItems > 0 && (
        <div id={failuresId} className="ml-8.5 space-y-1">
          <ul
            aria-label="Failed files"
            className="settings-rows overflow-hidden rounded-lg bg-destructive/[0.05] ring-1 ring-inset ring-destructive/15"
          >
            {b.failures.map((f) => (
              <li key={f.itemId} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-foreground/90">{f.relPath}</p>
                  <p className="truncate text-destructive">
                    {f.errorCode ? filesProblemText(f.errorCode, f.error) : (f.error ?? 'Failed')}
                  </p>
                </div>
                <SimpleTooltip label="Try this file again">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Retry ${f.relPath}`}
                    disabled={pending.has(`retry:${b.batchId}:${f.itemId}`)}
                    onClick={() =>
                      onRetry(
                        { batchId: b.batchId, itemId: f.itemId },
                        `retry:${b.batchId}:${f.itemId}`,
                      )
                    }
                  >
                    <RotateCw />
                  </Button>
                </SimpleTooltip>
              </li>
            ))}
          </ul>
          {b.failuresTruncated && (
            <p className="text-[11px] text-muted-foreground">
              {`${count(Math.max(0, b.failedItems - b.failures.length))} more failed. Retry the whole transfer to send them all again.`}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
