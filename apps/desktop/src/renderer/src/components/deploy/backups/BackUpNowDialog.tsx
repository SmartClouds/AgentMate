import { coreErrorMessage } from '@shared/coreErrors';
import { backupSize } from '@shared/deploy/backupSchedule';
import type { BackupRunInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployBackupDownload } from '@shared/deployServerBackupsTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Archive, CircleCheck, Spinner, TriangleAlert } from '@/components/icons';
import { Chip, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { StepUp } from '../security/useStepUp';
import { KIND_LABEL, RUN_STATE } from './format';
import { useBackupDestinations, useRefreshBackups } from './hooks';
import { RunTargets } from './RunHistory';

/**
 * Back up now: to the destinations picked, to this computer, or both. For this computer the save
 * dialog comes first. The run is followed until it ends; closing this leaves it running on the
 * server, and the history shows how it went.
 */
export function BackUpNowDialog({
  server,
  open,
  stepUp,
  onOpenChange,
}: {
  server: DeployServer;
  open: boolean;
  stepUp: StepUp;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const destinations = useBackupDestinations(server.id, open);
  const refresh = useRefreshBackups(server.id);
  const [picked, setPicked] = useState<string[]>([]);
  const [download, setDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<BackupRunInfo | null>(null);
  const [downloaded, setDownloaded] = useState<number | null>(null);
  const [saved, setSaved] = useState<DeployBackupDownload | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setDownload(false);
    setRun(null);
    setDownloaded(null);
    setSaved(null);
    setProblem(null);
  }, [open]);

  useEffect(
    () =>
      window.runova.deployServerBackups.onRunProgress((event) => {
        if (event.serverId !== server.id) return;
        setRun((current) => (current && current.id === event.run.id ? event.run : current));
        if (event.downloadedBytes !== undefined) setDownloaded(event.downloadedBytes);
      }),
    [server.id],
  );

  const ready = (picked.length > 0 || download) && !busy && run === null;

  async function start(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const started = await stepUp.run(() =>
        window.runova.deployServerBackups.runNow({
          serverId: server.id,
          destinationIds: picked,
          download,
        }),
      );
      if (!started?.started || !started.run) return;
      setRun(started.run);
      refresh();
      const watched = await window.runova.deployServerBackups.watchRun({
        serverId: server.id,
        runId: started.run.id,
      });
      setRun(watched.run);
      if (watched.download) setSaved(watched.download);
      if (watched.download?.saved) toast.success(`Backup saved to ${watched.download.path}`);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const toggle = (id: string, on: boolean) =>
    setPicked((current) => (on ? [...current, id] : current.filter((one) => one !== id)));

  const id = (name: string) => `backup-now-${name}-${server.id}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-4 w-4 text-primary" /> Back up {server.nickname} now
          </DialogTitle>
          <DialogDescription>
            Pick where it goes. Each destination gets its own copy, and one that fails does not hold
            up the others.
          </DialogDescription>
        </DialogHeader>

        {run === null ? (
          <div className="space-y-3">
            {destinations.isPending ? (
              <div aria-busy="true" className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : destinations.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {coreErrorMessage(destinations.error)}
              </p>
            ) : (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-xs text-muted-foreground">Destinations</legend>
                {destinations.data.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No destinations yet. Add one in Destinations, or download the backup here.
                  </p>
                )}
                {destinations.data.map((destination) => (
                  <div key={destination.id} className="flex items-center gap-2">
                    <Checkbox
                      id={id(destination.id)}
                      checked={picked.includes(destination.id)}
                      onCheckedChange={(value) => toggle(destination.id, value === true)}
                    />
                    <Label htmlFor={id(destination.id)} className="font-normal">
                      {destination.name}
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {KIND_LABEL[destination.kind]}
                    </span>
                  </div>
                ))}
              </fieldset>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id={id('download')}
                checked={download}
                onCheckedChange={(value) => setDownload(value === true)}
              />
              <Label htmlFor={id('download')} className="font-normal">
                Download to this computer
              </Label>
            </div>
            <Notice tone="warning" icon={TriangleAlert} className="text-xs">
              Volumes are copied while the apps keep running. A database that is busy at that moment
              may restore in an inconsistent state.
            </Notice>
          </div>
        ) : (
          <div className="space-y-2 text-sm" role="status">
            <p className="flex items-center gap-2">
              {run.state === 'running' ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <CircleCheck className="h-3.5 w-3.5 text-success" />
              )}
              {run.state === 'running'
                ? 'Backing up. You can close this; the server carries on.'
                : run.state === 'succeeded'
                  ? 'The backup is done.'
                  : run.state === 'partlyFailed'
                    ? 'The backup is made, but not every destination took it.'
                    : `The backup failed${run.error ? `: ${run.error}` : '.'}`}
              <Chip tone={RUN_STATE[run.state].tone}>{RUN_STATE[run.state].label}</Chip>
            </p>
            {run.sizeBytes ? (
              <p className="text-xs text-muted-foreground">Size: {backupSize(run.sizeBytes)}</p>
            ) : null}
            <RunTargets run={run} />
            {downloaded !== null && !saved && (
              <p className="text-xs text-muted-foreground">
                Saving to this computer: {backupSize(downloaded)}
              </p>
            )}
            {saved?.saved && (
              <p className="text-xs text-muted-foreground">
                Saved to <span className="font-mono">{saved.path}</span>
              </p>
            )}
            {saved && !saved.saved && saved.error && (
              <p className="text-xs text-destructive">Not saved here: {saved.error}</p>
            )}
          </div>
        )}

        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            {run ? 'Close' : 'Cancel'}
          </Button>
          {run === null && (
            <Button disabled={!ready} onClick={() => void start()}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Start the backup
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
