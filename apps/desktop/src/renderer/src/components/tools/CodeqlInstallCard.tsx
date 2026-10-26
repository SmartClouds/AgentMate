import type { CodeqlInstallProgress, CodeqlLocalStatus } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, FolderOpen, StopCircle, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * CodeQL's own install actions.
 *
 * Unlike every other tool here, CodeQL has no package manager behind it on Windows or Linux, so
 * there is no shell command to hand the terminal. GitHub ships it as a release zip, and this
 * fetches that zip, checks it against the SHA-256 published beside it, and unpacks it into
 * Runova's tools folder. Nothing goes on the system PATH and nothing needs admin rights.
 */

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function progressLabel(progress: CodeqlInstallProgress): string {
  if (progress.phase === 'downloading' && progress.total > 0) {
    const speed = progress.bytesPerSecond > 0 ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : '';
    return `${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}${speed}`;
  }
  if (progress.phase === 'extracting' && progress.total > 0) {
    return `${progress.transferred} of ${progress.total} files`;
  }
  return progress.message;
}

export function CodeqlInstallCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<CodeqlInstallProgress | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.codeqlStatus,
    queryFn: () => window.runova.security.codeqlStatus(),
    meta: { silentLoading: true },
  });

  // Subscribed for the life of the card rather than only during an install, so navigating away
  // and back rejoins a download that is already running.
  useEffect(() => {
    return window.runova.security.onCodeqlProgress((payload) => {
      setProgress(
        payload.phase === 'done' || payload.phase === 'failed' || payload.phase === 'cancelled'
          ? null
          : payload,
      );
      if (payload.phase === 'done') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.codeqlStatus });
      }
      // A cancel resolves normally rather than throwing, so the mutation's error path never runs
      // and this is the only place that can acknowledge it.
      if (payload.phase === 'cancelled') toast.info('CodeQL download cancelled.');
    });
  }, [queryClient]);

  // An install started before this card mounted still shows up, because the status carries it.
  useEffect(() => {
    const running = statusQuery.data?.progress;
    if (running && !progress) setProgress(running);
  }, [statusQuery.data, progress]);

  const install = useMutation({
    mutationFn: () => window.runova.security.installCodeql(),
    onSuccess: (status: CodeqlLocalStatus) => {
      queryClient.setQueryData(queryKeys.codeqlStatus, status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolsStatus });
      if (status.installed) {
        toast.success(
          status.version ? `CodeQL ${status.version} is ready.` : 'CodeQL is ready to use.',
        );
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'The CodeQL install failed.');
    },
    onSettled: () => setProgress(null),
    meta: { silentLoading: true },
  });

  const remove = useMutation({
    mutationFn: () => window.runova.security.removeCodeql(),
    onSuccess: (status: CodeqlLocalStatus) => {
      queryClient.setQueryData(queryKeys.codeqlStatus, status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolsStatus });
      toast.success('The downloaded CodeQL copy was removed.');
    },
    meta: { silentLoading: true },
  });

  const status = statusQuery.data;
  const busy = progress !== null || install.isPending;

  if (busy) {
    const fraction = progress?.fraction ?? null;
    return (
      <div className="w-full space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">
            {progress?.message ?? 'Starting'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 px-2.5 hover:bg-foreground/[0.06]"
            onClick={() => void window.runova.security.cancelCodeqlInstall()}
          >
            <StopCircle className="h-3.5 w-3.5" /> Cancel
          </Button>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={
              fraction === null
                ? 'h-full w-1/3 animate-pulse rounded-full bg-primary'
                : 'h-full rounded-full bg-primary transition-[width] duration-300'
            }
            style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
        {progress && (
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {progressLabel(progress)}
          </p>
        )}
      </div>
    );
  }

  // A codeql the user put on PATH themselves is used as-is; offering to download a second copy
  // would only invite a version mismatch nobody could explain.
  if (status?.installed && status.onPath) {
    return (
      <p className="text-xs text-muted-foreground">
        Using the <span className="font-mono text-foreground">codeql</span> already on your PATH.
      </p>
    );
  }

  return (
    <>
      <SimpleTooltip
        label={
          status?.installed
            ? 'Download the current release again and replace this copy'
            : 'Downloads the official release from GitHub and verifies its checksum. About 420 MB to download and 700 MB on disk once unpacked.'
        }
      >
        <Button
          size="sm"
          variant={status?.installed ? 'soft' : 'default'}
          onClick={() => install.mutate()}
        >
          <Download /> {status?.installed ? 'Reinstall' : 'Download CodeQL'}
        </Button>
      </SimpleTooltip>

      <Button
        variant="soft"
        size="sm"
        onClick={() => void window.runova.security.openCodeqlFolder()}
      >
        <FolderOpen /> Open folder
      </Button>

      {status?.installed && (
        <Button
          variant="soft"
          size="sm"
          onClick={() => {
            void (async () => {
              const confirmed = await confirmDialog({
                title: 'Remove the downloaded CodeQL?',
                description:
                  'This deletes the copy in Runova’s tools folder. You can download it again at any time.',
                confirmLabel: 'Remove',
                variant: 'destructive',
              });
              if (confirmed) remove.mutate();
            })();
          }}
        >
          <Trash2 /> Remove
        </Button>
      )}
    </>
  );
}
