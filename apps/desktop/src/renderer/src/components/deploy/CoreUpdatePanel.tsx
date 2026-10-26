import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { toast } from 'sonner';
import { CloudDownload, RefreshCw, TerminalSquare } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { coreUpdatePhases, useCoreRelease } from '@/lib/deploy/coreUpdate';
import { timeline } from '@/lib/deploy/setup';
import { useDeploySetupStore } from '@/stores/deploySetupStore';
import { useCoreHealth } from './coreHealth';
import { DeployCard, Notice } from './deployKit';
import { useProofStepUp } from './overview/useProofStepUp';
import { SetupFailure } from './SetupFailure';
import { SetupTimeline } from './SetupTimeline';

/**
 * Updating the server core without SSH: the server downloads the release from GitHub itself, and
 * when it cannot, the app uploads it over the core's own connection. An Owner confirms with their
 * password. A core that cannot replace itself (older, or not installed by the app) is handed to
 * the SSH installer, which also tries the server's own download before uploading.
 */
export function CoreUpdatePanel({
  server,
  onUseSsh,
  onCancel,
}: {
  server: DeployServer;
  /** Opens the SSH installer instead. */
  onUseSsh: () => void;
  /** Back to the server's sections. */
  onCancel: () => void;
}): React.JSX.Element {
  const run = useDeploySetupStore((state) => state.runs[server.id]);
  const updateCore = useDeploySetupStore((state) => state.updateCore);
  const clear = useDeploySetupStore((state) => state.clear);
  const release = useCoreRelease();
  const health = useCoreHealth(server);
  const stepUp = useProofStepUp(server);
  const updateRun = run?.kind === 'update' ? run : undefined;
  const running = health.data?.version ?? server.core?.version;
  const target = release.data;

  function start(): void {
    if (!target) return;
    const planned = coreUpdatePhases(target);
    void stepUp
      .run((proof) => updateCore(server.id, planned, proof), 'Updating the server core')
      .catch((error: unknown) => toast.error(coreErrorMessage(error)));
  }

  function switchToSsh(): void {
    clear(server.id);
    onUseSsh();
  }

  function cancel(): void {
    clear(server.id);
    onCancel();
  }

  const sshButton = (
    <Button variant="soft" size="sm" onClick={switchToSsh}>
      <TerminalSquare /> Update over SSH instead
    </Button>
  );

  let body: React.ReactNode;
  if (updateRun?.update?.outcome === 'needs-ssh') {
    body = (
      <>
        <Notice tone="warning">
          <p>{updateRun.update.reason}</p>
          <p className="mt-1 text-muted-foreground">
            Update it over SSH this once. Once it runs a newer core, later updates go through the
            core without SSH.
          </p>
        </Notice>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={switchToSsh}>
            <TerminalSquare /> Continue over SSH
          </Button>
          <Button size="sm" variant="soft" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </>
    );
  } else if (updateRun) {
    body = (
      <>
        <SetupTimeline label="Update steps" steps={timeline(updateRun.planned, updateRun.events)} />
        {updateRun.status === 'running' && (
          <p className="text-xs text-muted-foreground">
            You can leave this page. The update keeps going and shows up here again.
          </p>
        )}
        {updateRun.status === 'failed' && (
          <>
            <SetupFailure message={updateRun.error ?? 'The update stopped.'} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={start} disabled={!target}>
                <RefreshCw /> Try again
              </Button>
              {sshButton}
              <Button size="sm" variant="soft" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </>
    );
  } else if (release.isPending) {
    body = <Skeleton className="h-9 w-48 rounded-lg" />;
  } else if (!target) {
    body = (
      <>
        <Notice>This build of Runova has no server core to update to.</Notice>
        <div className="flex flex-wrap items-center gap-2">
          {sshButton}
          <Button size="sm" variant="soft" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </>
    );
  } else {
    const same = running === target.version;
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          {same
            ? `${server.nickname} already runs core ${target.version}. To put the same release on again, reinstall it over SSH.`
            : `${server.nickname} runs core ${running ?? 'of an unknown version'}. ${
                target.serverDownload
                  ? 'The server downloads the new release from GitHub itself; if it cannot, Runova uploads it over the core connection.'
                  : 'Runova uploads the new release over the core connection.'
              } No SSH login is needed, only your password on the core.`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {!same && (
            <Button onClick={start}>
              <CloudDownload /> Update to core {target.version}
            </Button>
          )}
          {sshButton}
          <Button variant="soft" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </>
    );
  }

  return (
    <DeployCard
      icon={<CloudDownload />}
      title="Update the server core"
      description="The running core keeps working until the new one is ready. If the new one does not stay up, the server goes back to the one it has now."
      bodyClassName="space-y-4"
    >
      {body}
      {stepUp.dialog}
    </DeployCard>
  );
}
