import type { UpdateDownloadProgress, UpdateStatus } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CloudDownload, Download, Pause, Play, RefreshCw, Wifi } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { closeUpdateDialog, openUpdateDialog, useUpdateStore } from '@/stores/updateStore';

export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(0)} MB`;
}

export function formatUpdateSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 256) return '';
  return `${formatUpdateBytes(bytesPerSecond)}/s`;
}

export function formatUpdateEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.round(minutes / 60);
  return `about ${hours}h left`;
}

export function updatePercent(status: UpdateStatus): number | null {
  if (status.state === 'downloading' || status.state === 'paused') {
    return Math.min(100, Math.max(0, status.progress.percent));
  }
  if (status.state === 'error' && status.progress) {
    return Math.min(100, Math.max(0, status.progress.percent));
  }
  if (status.state === 'available' && status.info.sizeBytes && status.partialBytes > 0) {
    return Math.min(100, (status.partialBytes / status.info.sizeBytes) * 100);
  }
  if (status.state === 'downloaded') return 100;
  return null;
}

export function UpdateProgressTrack({
  percent,
  live,
  reconnecting,
}: {
  percent: number;
  live?: boolean;
  reconnecting?: boolean;
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn(
          'update-progress-bar h-full rounded-full bg-primary transition-[width] duration-300',
          reconnecting && 'bg-warning',
        )}
        data-live={live && !reconnecting ? 'true' : 'false'}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function progressLine(progress: UpdateDownloadProgress, reconnecting?: boolean): string {
  const parts = [
    `${formatUpdateBytes(progress.transferredBytes)} of ${formatUpdateBytes(progress.totalBytes)}`,
  ];
  if (reconnecting) {
    parts.push('saved');
  } else {
    const speed = formatUpdateSpeed(progress.bytesPerSecond);
    if (speed) parts.push(speed);
    const eta = formatUpdateEta(progress.etaSeconds);
    if (eta) parts.push(eta);
  }
  if (progress.resumed && !reconnecting) parts.push('resumed');
  return parts.join(' · ');
}

async function startDownload(): Promise<void> {
  try {
    await window.runova.app.downloadUpdate();
  } catch {
    // Status broadcast already carries the error. Don't toast over the dialog.
  }
}

/**
 * Drives the update confirm/progress/restart flow off useUpdateStore.
 * Downloads and restarts never happen without an explicit user confirmation.
 * Mount once near the app root, alongside ConfirmDialogHost.
 */
export function UpdateManager(): React.JSX.Element {
  const status = useUpdateStore((s) => s.status);
  const dialogOpen = useUpdateStore((s) => s.dialogOpen);
  const downloadPrompted = useRef<Set<string>>(new Set());
  const restartPrompted = useRef<Set<string>>(new Set());
  const wasDownloading = useRef(false);

  useEffect(() => {
    if (status.state === 'available' && !downloadPrompted.current.has(status.info.version)) {
      downloadPrompted.current.add(status.info.version);
      openUpdateDialog();
    }
    if (status.state === 'downloading' && !wasDownloading.current) {
      openUpdateDialog();
    }
    wasDownloading.current = status.state === 'downloading';
    if (status.state === 'downloaded' && !restartPrompted.current.has(status.info.version)) {
      restartPrompted.current.add(status.info.version);
      openUpdateDialog();
    }
    if (status.state === 'error') {
      openUpdateDialog();
    }
  }, [status]);

  const open =
    dialogOpen &&
    (status.state === 'available' ||
      status.state === 'downloading' ||
      status.state === 'paused' ||
      status.state === 'downloaded' ||
      (status.state === 'error' && Boolean(status.info)));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openUpdateDialog() : closeUpdateDialog())}>
      <DialogContent
        className={cn(status.state === 'downloading' && '[&>button]:opacity-70')}
        onInteractOutside={(e) => {
          if (status.state === 'downloading') e.preventDefault();
        }}
      >
        <UpdateDialogBody status={status} />
      </DialogContent>
    </Dialog>
  );
}

function UpdateDialogBody({ status }: { status: UpdateStatus }): React.JSX.Element {
  if (status.state === 'available') {
    const hasPartial = status.partialBytes > 0;
    const sizeLabel = status.info.sizeBytes ? formatUpdateBytes(status.info.sizeBytes) : null;
    const percent = updatePercent(status);
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload className="h-4 w-4" />
            {hasPartial ? 'Finish downloading update' : 'Update available'}
          </DialogTitle>
          <DialogDescription>
            Runova v{status.info.version}
            {sizeLabel ? ` · ${sizeLabel}` : ''}.
            {hasPartial
              ? ` ${formatUpdateBytes(status.partialBytes)} is already on disk. Resume continues from there.`
              : ' If the connection drops, the download picks up from the bytes already saved.'}
          </DialogDescription>
        </DialogHeader>
        {percent != null && percent > 0 && (
          <div className="space-y-2">
            <UpdateProgressTrack percent={percent} />
            <p className="text-xs text-muted-foreground">
              {formatUpdateBytes(status.partialBytes)}
              {status.info.sizeBytes ? ` of ${formatUpdateBytes(status.info.sizeBytes)}` : ''} saved
            </p>
          </div>
        )}
        {status.info.releaseNotes ? (
          <div className="max-h-32 overflow-y-auto rounded-lg border border-border/80 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {status.info.releaseNotes}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="soft" onClick={() => closeUpdateDialog()}>
            Later
          </Button>
          <Button onClick={() => void startDownload()}>
            <Download className="h-4 w-4" />
            {hasPartial ? 'Resume download' : 'Download'}
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (status.state === 'downloading') {
    const percent = updatePercent(status) ?? 0;
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {status.reconnecting ? <Wifi className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {status.reconnecting ? 'Reconnecting' : 'Downloading update'}
          </DialogTitle>
          <DialogDescription>
            {status.reconnecting
              ? `Connection dropped. Keeping ${formatUpdateBytes(status.progress.transferredBytes)} and retrying.`
              : `Runova v${status.info.version}. You can hide this window. The download keeps going.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-2xl font-semibold tabular-nums tracking-tight">
              {percent.toFixed(0)}%
            </p>
            <p className="text-xs text-muted-foreground">
              {status.reconnecting ? 'Waiting to resume' : 'Keeps saved bytes on timeout'}
            </p>
          </div>
          <UpdateProgressTrack percent={percent} live reconnecting={status.reconnecting} />
          <p className="text-xs tabular-nums text-muted-foreground">
            {progressLine(status.progress, status.reconnecting)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="soft" onClick={() => closeUpdateDialog()}>
            Hide
          </Button>
          <Button variant="soft" onClick={() => void window.runova.app.pauseDownload()}>
            <Pause className="h-4 w-4" />
            Pause
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (status.state === 'paused') {
    const percent = updatePercent(status) ?? 0;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Download paused</DialogTitle>
          <DialogDescription>{status.message}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <UpdateProgressTrack percent={percent} />
          <p className="text-xs tabular-nums text-muted-foreground">
            {progressLine(status.progress)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="soft" onClick={() => closeUpdateDialog()}>
            Hide
          </Button>
          <Button onClick={() => void startDownload()}>
            <Play className="h-4 w-4" />
            Resume download
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (status.state === 'downloaded') {
    return <DownloadedDialogBody version={status.info.version} />;
  }

  if (status.state === 'error') {
    const percent = updatePercent(status);
    return (
      <>
        <DialogHeader>
          <DialogTitle>{status.resumable ? 'Download interrupted' : 'Update failed'}</DialogTitle>
          <DialogDescription>{status.message}</DialogDescription>
        </DialogHeader>
        {percent != null && status.progress ? (
          <div className="space-y-2">
            <UpdateProgressTrack percent={percent} />
            <p className="text-xs tabular-nums text-muted-foreground">
              {formatUpdateBytes(status.progress.transferredBytes)} saved on disk
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="soft" onClick={() => closeUpdateDialog()}>
            Hide
          </Button>
          {status.resumable ? (
            <Button onClick={() => void startDownload()}>
              <Play className="h-4 w-4" />
              Resume download
            </Button>
          ) : (
            <Button
              onClick={() => {
                void window.runova.app.checkForUpdates().then((result) => {
                  if (result.state === 'error') toast.error(result.message);
                });
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }

  return (
    <DialogHeader>
      <DialogTitle>Updates</DialogTitle>
      <DialogDescription>Checking for a new version.</DialogDescription>
    </DialogHeader>
  );
}

/**
 * The restart step hands off to the installer, which can take a moment before
 * the app quits. Disable both buttons while
 * the IPC call is in flight so a click that has not quit yet never looks dead,
 * and surface a failure instead of staying on a stuck dialog.
 */
export function DownloadedDialogBody({ version }: { version: string }): React.JSX.Element {
  const [restarting, setRestarting] = useState(false);

  async function restartNow(): Promise<void> {
    if (restarting) return;
    setRestarting(true);
    try {
      await window.runova.app.quitAndInstall();
    } catch {
      setRestarting(false);
      toast.error('Restart to install failed. Quit the app and it installs on the way out.');
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Update ready to install</DialogTitle>
        <DialogDescription>
          Runova v{version} is downloaded. Restart now to finish installing, or it installs the next
          time you quit.
        </DialogDescription>
      </DialogHeader>
      <UpdateProgressTrack percent={100} />
      <DialogFooter>
        <Button variant="soft" disabled={restarting} onClick={() => closeUpdateDialog()}>
          Later
        </Button>
        <Button disabled={restarting} onClick={() => void restartNow()}>
          {restarting ? 'Restarting…' : 'Restart now'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Compact top-bar control so a background download stays visible after Hide. */
export function UpdateStatusChip(): React.JSX.Element | null {
  const status = useUpdateStore((s) => s.status);
  const dialogOpen = useUpdateStore((s) => s.dialogOpen);
  const percent = updatePercent(status);

  if (dialogOpen) return null;
  if (
    status.state !== 'downloading' &&
    status.state !== 'paused' &&
    status.state !== 'downloaded' &&
    !(status.state === 'error' && (status.resumable || status.info)) &&
    !(status.state === 'available' && status.partialBytes > 0)
  ) {
    return null;
  }

  const label =
    status.state === 'downloading'
      ? status.reconnecting
        ? 'Reconnecting'
        : `v${status.info.version}`
      : status.state === 'paused'
        ? 'Paused'
        : status.state === 'downloaded'
          ? 'Ready'
          : status.state === 'error'
            ? 'Interrupted'
            : 'Resume';

  return (
    <Button
      variant="soft"
      size="sm"
      className="hidden h-8 gap-2 px-2.5 sm:inline-flex"
      onClick={() => openUpdateDialog()}
      aria-label="Show update download"
    >
      <Download className="h-3.5 w-3.5" />
      <span className="max-w-[7rem] truncate text-xs">{label}</span>
      {percent != null && status.state !== 'downloaded' ? (
        <span className="tabular-nums text-xs text-muted-foreground">{percent.toFixed(0)}%</span>
      ) : null}
    </Button>
  );
}
