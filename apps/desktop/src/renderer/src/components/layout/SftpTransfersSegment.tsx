import * as PopoverPrimitive from '@radix-ui/react-popover';
import { formatBytes } from '@shared/remoteProtocol';
import type { SftpBatchView, SftpJobKind } from '@shared/sftpTypes';
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { durationText, plural } from '@/components/deploy/files/copy';
import { Download, FolderOpen, Lock, TerminalSquare, Trash2, Upload, X } from '@/components/icons';
import { isFilesPageOf, leaveFilesPage } from '@/components/sftp/SftpViewSwitch';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { openSftpDock } from '@/lib/sftp/dock';
import { sftpProblem } from '@/lib/sftp/messages';
import { isBatchActive, summarizeTransfers } from '@/lib/sftp/transferSummary';
import { cn } from '@/lib/utils';
import { serverFiles, useSftpStore } from '@/stores/sftpStore';
import { focusPanel, PanelTitle, PopSegment } from './statusBarKit';

/**
 * The SFTP file manager's transfers in the status bar (E25). A big upload can take a long while,
 * so the bar shows how far it is from any page, says when a conflict waits for an answer, and
 * leads back to the file manager or to the dialog that asks. Hidden while nothing runs and
 * nothing waits.
 *
 * The queue snapshots land every 100 ms with fresh objects, so the selectors here answer a JSON
 * string (or a plain string) of what is drawn, already formatted. A snapshot that changes nothing
 * on screen then changes nothing in the string, and nothing renders again. The speed and the time
 * left change on nearly every snapshot, so they stay out of the bar and its accessible name: only
 * the tooltip and the panel show them, and those subscribe only while they are open.
 */

/** What the bar draws, as text where it is text, so equal strings mean an equal bar. */
interface BarView {
  active: number;
  waiting: number;
  /** Of all bytes the active batches move; null while there is no total to divide by. */
  percent: number | null;
  direction: 'up' | 'down' | 'both' | null;
  servers: { serverId: string; nickname: string; conflict: boolean }[];
}

/** One active batch as its panel row draws it. */
interface BatchRowView {
  batchId: string;
  kind: SftpJobKind;
  label: string;
  /** Null while the batch is still counting its files. */
  percent: number | null;
  progress: string;
  rate: string | null;
}

const KIND: Record<SftpJobKind, { Icon: typeof Upload; noun: string }> = {
  upload: { Icon: Upload, noun: 'Upload' },
  download: { Icon: Download, noun: 'Download' },
  delete: { Icon: Trash2, noun: 'Delete' },
  chmod: { Icon: Lock, noun: 'Permissions' },
};

const count = (n: number): string => n.toLocaleString('en-US');

const rateText = (bytesPerSecond: number): string => `${formatBytes(Math.round(bytesPerSecond))}/s`;

function barView(servers: Parameters<typeof summarizeTransfers>[0]): BarView {
  const s = summarizeTransfers(servers);
  const percent =
    s.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((s.transferredBytes / s.totalBytes) * 100)))
      : null;
  return {
    active: s.active,
    waiting: s.waiting,
    percent,
    direction: s.direction,
    servers: s.perServer.map(({ serverId, nickname, conflict }) => ({
      serverId,
      nickname,
      conflict,
    })),
  };
}

/** "4.0 MB/s, 25 s left" for everything under way, or "" while nothing moves. */
function speedText(servers: Parameters<typeof summarizeTransfers>[0]): string {
  const s = summarizeTransfers(servers);
  if (s.bytesPerSecond <= 0) return '';
  const left = s.totalBytes - s.transferredBytes;
  const time =
    s.totalBytes > 0 && left > 0 ? `${durationText((left / s.bytesPerSecond) * 1000)} left` : null;
  return [rateText(s.bytesPerSecond), time].filter(Boolean).join(', ');
}

/** The live speed and time left, for the tooltip and the panel only. */
function TransferSpeed({ prefix = '' }: { prefix?: string }): React.JSX.Element | null {
  const text = useSftpStore((s) => speedText(s.servers));
  return text ? <span className="tabular-nums">{`${prefix}${text}`}</span> : null;
}

/** How far a batch is, 0 to 100: by bytes when it moves any, else by items (as the queue does). */
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

function batchRow(b: SftpBatchView): BatchRowView {
  const counting = b.state === 'expanding' || b.totalItems === null;
  const processed = b.doneItems + b.failedItems + b.skippedItems;
  return {
    batchId: b.batchId,
    kind: b.kind,
    label: b.label,
    percent: counting ? null : percentOf(b),
    progress: counting
      ? 'Counting files…'
      : b.totalBytes && b.totalBytes > 0
        ? `${formatBytes(b.transferredBytes)} of ${formatBytes(b.totalBytes)}`
        : `${count(processed)} of ${count(b.totalItems ?? 0)}`,
    rate:
      b.state !== 'waiting' && b.bytesPerSecond !== null && b.bytesPerSecond > 0
        ? rateText(b.bytesPerSecond)
        : null,
  };
}

/** A small dot that pulses, the way a Chip draws one, sized for the 24px bar. */
function PulseDot(): React.JSX.Element {
  return (
    <span aria-hidden className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full rounded-full bg-warning opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-warning" />
    </span>
  );
}

const linkClass =
  'rounded text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function SftpTransfersSegment(): React.JSX.Element | null {
  const signature = useSftpStore((s) => JSON.stringify(barView(s.servers)));
  const view = useMemo(() => JSON.parse(signature) as BarView, [signature]);
  if (view.active === 0 && view.waiting === 0) return null;

  const needsAnswer = view.waiting > 0;
  const transfers = plural(view.active, 'transfer');
  const detail = needsAnswer
    ? [view.active > 0 ? transfers : null, 'needs your answer']
    : [transfers];
  const label = `File transfers: ${detail.filter(Boolean).join(', ')}`;

  return (
    <PopSegment
      label={label}
      tooltip={
        <span className="flex flex-col">
          <span>{label}</span>
          <TransferSpeed />
        </span>
      }
      width="w-80"
      onOpenAutoFocus={focusPanel}
      className={cn(needsAnswer && 'text-warning hover:text-warning')}
      panel={
        <>
          <PanelTitle
            title="File transfers"
            detail={
              <>
                {view.percent !== null ? `${view.percent}% done` : null}
                <TransferSpeed prefix={view.percent !== null ? ', ' : ''} />
              </>
            }
          />
          <div className="flex flex-col gap-2">
            {view.servers.map((server) => (
              <ServerTransfers key={server.serverId} {...server} />
            ))}
          </div>
        </>
      }
    >
      {view.direction === 'up' || view.direction === 'both' ? (
        <>
          <Upload className="h-2.5 w-2.5" />
          <span className="sr-only">Upload</span>
        </>
      ) : null}
      {view.direction === 'down' || view.direction === 'both' ? (
        <>
          <Download className="h-2.5 w-2.5" />
          <span className="sr-only">Download</span>
        </>
      ) : null}
      {needsAnswer ? (
        <>
          <PulseDot />
          <span>Needs your answer</span>
        </>
      ) : (
        <>
          <span className="tabular-nums">{transfers}</span>
          {view.percent !== null ? (
            <span className="tabular-nums">{`${view.percent}%`}</span>
          ) : null}
        </>
      )}
    </PopSegment>
  );
}

/**
 * One server in the panel: its active batches with a way to cancel each, the question it waits
 * on, and the way to its file manager. Mounted only while the panel is open, so the rows'
 * subscription costs nothing the rest of the time.
 */
function ServerTransfers({
  serverId,
  nickname,
  conflict,
}: {
  serverId: string;
  nickname: string;
  conflict: boolean;
}): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const signature = useSftpStore((s) =>
    JSON.stringify(
      (serverFiles(s, serverId).queue?.batches ?? [])
        .filter((b) => isBatchActive(b.state))
        .map(batchRow),
    ),
  );
  const rows = useMemo(() => JSON.parse(signature) as BatchRowView[], [signature]);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());

  function cancel(row: BatchRowView): void {
    const store = useSftpStore.getState();
    setCancelling((now) => new Set(now).add(row.batchId));
    void Promise.resolve()
      .then(() => store.cancel(serverId, { batchId: row.batchId }))
      .catch((error: unknown) => {
        toast.error(`Could not cancel ${row.label}`, { description: sftpProblem(error) });
      })
      .finally(() =>
        setCancelling((now) => {
          const next = new Set(now);
          next.delete(row.batchId);
          return next;
        }),
      );
  }

  return (
    <section aria-label={nickname} className="flex flex-col gap-1">
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {nickname}
      </p>

      {conflict ? (
        <div className="flex items-center gap-2 rounded-lg bg-warning/10 px-2 py-1.5 text-warning">
          <PulseDot />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">Needs your answer</span>
          <PopoverPrimitive.Close asChild>
            <Button
              variant="soft"
              size="xs"
              aria-label={`Answer the question on ${nickname}`}
              onClick={() => useSftpStore.getState().requestAnswer(serverId)}
            >
              Answer
            </Button>
          </PopoverPrimitive.Close>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="-mx-1 flex flex-col">
          {rows.map((row) => {
            const { Icon, noun } = KIND[row.kind];
            return (
              <li key={row.batchId} className="flex flex-col gap-1 rounded-lg px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="h-2.5 w-2.5 shrink-0 text-primary" />
                  <span className="sr-only">{noun}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{row.label}</span>
                  <SimpleTooltip label="Cancel this transfer" side="top">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Cancel ${row.label}`}
                      disabled={cancelling.has(row.batchId)}
                      onClick={() => cancel(row)}
                      className="-my-1 h-5 w-5 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X />
                    </Button>
                  </SimpleTooltip>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${row.label} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={row.percent ?? undefined}
                  className="ml-4.5 h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
                >
                  {row.percent === null ? (
                    <div className="h-full w-1/3 rounded-full bg-primary/60 motion-safe:animate-pulse" />
                  ) : (
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                      style={{ width: `${row.percent}%` }}
                    />
                  )}
                </div>
                <p className="ml-4.5 flex gap-x-3 text-[10px] tabular-nums text-muted-foreground">
                  <span>{row.progress}</span>
                  {row.rate ? <span>{row.rate}</span> : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex items-center gap-3 border-t border-border/60 pt-1.5">
        <PopoverPrimitive.Close asChild>
          <button
            type="button"
            aria-label={`Open the file manager of ${nickname}`}
            onClick={() => navigate(`/ssh-files/${encodeURIComponent(serverId)}`)}
            className={cn(linkClass, 'flex items-center gap-1')}
          >
            <FolderOpen className="h-2.5 w-2.5" />
            Open file manager
          </button>
        </PopoverPrimitive.Close>
        <PopoverPrimitive.Close asChild>
          <button
            type="button"
            aria-label={`Show the file manager of ${nickname} in the panel`}
            onClick={() => {
              try {
                openSftpDock(serverId, nickname);
              } catch (error) {
                toast.error(`Could not show ${nickname} in the panel`, {
                  description: sftpProblem(error),
                });
                return;
              }
              // Its page would only say "Shown on the page" in the panel, so leave it.
              if (isFilesPageOf(location.pathname, serverId)) leaveFilesPage(navigate, serverId);
            }}
            className={cn(linkClass, 'flex items-center gap-1')}
          >
            <TerminalSquare className="h-2.5 w-2.5" />
            Show in panel
          </button>
        </PopoverPrimitive.Close>
      </div>
    </section>
  );
}
