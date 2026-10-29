import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployBackupFile } from '@shared/deployHardeningTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ArchiveRestore,
  CircleCheck,
  CircleX,
  FolderOpen,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { type CoreRestore, useDeployBackupRunStore } from '@/stores/deployBackupRunStore';
import { Notice } from '../../deployKit';

/**
 * Restoring a backup onto this server's core, over SSH as root, so it also works on a new server
 * once the core is installed. The backup is checked with its passphrase before anything changes;
 * then the core's state is swapped for it, the core restarts, and this computer enrolls again as
 * one of the backup's Owners. A core that does not come back goes back to what it had.
 */

const NO_STEPS: CoreRestore['steps'] = [];

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function RestoreDialog({
  server,
  open,
  defaultUserName,
  onOpenChange,
}: {
  server: DeployServer;
  open: boolean;
  defaultUserName?: string;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<DeployBackupFile | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [userName, setUserName] = useState(defaultUserName ?? '');
  const [password, setPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  // The restore runs in the backup store, so leaving the page keeps it and its steps.
  const kept = useDeployBackupRunStore(
    (state): CoreRestore | undefined => state.coreRestores[server.id],
  );
  const steps = kept?.steps ?? NO_STEPS;
  const busy = kept?.busy ?? false;
  const problem = kept?.problem ?? null;
  const result = kept?.result ?? null;
  const setProblem = (next: string | null) =>
    useDeployBackupRunStore.getState().setCoreRestoreProblem(server.id, next);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPassphrase('');
    setUserName(defaultUserName ?? '');
    setPassword('');
    setSudoPassword('');
  }, [open, defaultUserName]);

  async function pick(): Promise<void> {
    setProblem(null);
    try {
      const picked = await window.runova.deployHardening.pickBackup();
      if (picked) setFile(picked);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    }
  }

  const ready =
    file !== null &&
    passphrase.length > 0 &&
    userName.trim().length > 0 &&
    password.length > 0 &&
    !busy;

  async function restore(): Promise<void> {
    if (!file || !ready) return;
    const confirmed = await confirmDialog({
      title: `Replace everything the core on ${server.nickname} knows?`,
      description:
        'Its users, computers, apps, sites, certificates and keys are replaced by the backup. Every session ends. The state it has now is kept on the server, root only, in case you need it.',
      warning: `Type ${server.nickname} to restore. Apps are not started by the restore; deploy them again, and apply in Websites so nginx serves the restored sites.`,
      confirmLabel: 'Restore',
      variant: 'destructive',
      typeToConfirm: server.nickname,
    });
    if (!confirmed) return;
    await useDeployBackupRunStore.getState().restoreCore(
      server.id,
      () =>
        window.runova.deployHardening.restore({
          serverId: server.id,
          fileToken: file.token,
          passphrase,
          sudoPassword: sudoPassword || null,
          userName: userName.trim(),
          password,
        }),
      () => void queryClient.invalidateQueries({ queryKey: ['deploy'] }),
    );
  }

  const id = (name: string) => `restore-${name}-${server.id}`;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArchiveRestore className="h-4 w-4 text-primary" /> Restore a backup onto{' '}
            {server.nickname}
          </DialogTitle>
          <DialogDescription>
            From this server or another one. The backup is checked with its passphrase before
            anything on the server changes.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-2 text-sm" role="status">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <CircleCheck className="h-4 w-4 text-success" /> Restored the backup of{' '}
              {result.backupHostName} from {new Date(result.backupCreatedAtUnixMs).toLocaleString()}
              .
            </p>
            {result.signInError && (
              <p className="text-destructive">Signing in did not work yet: {result.signInError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              The state from before is kept at{' '}
              <span className="font-mono">{result.previousStateFolder}</span>. Deploy the apps again
              and apply in Websites.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="soft"
                disabled={busy}
                onClick={() => void pick()}
              >
                <FolderOpen className="h-3.5 w-3.5" />{' '}
                {file ? 'Pick another file' : 'Pick the backup file'}
              </Button>
              {file && (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {file.name} ({size(file.sizeBytes)})
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id('passphrase')}>Backup passphrase</Label>
              <SecretInput id={id('passphrase')} value={passphrase} onChange={setPassphrase} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={id('user')}>Owner in the backup</Label>
                <Input
                  id={id('user')}
                  value={userName}
                  onChange={(event) => setUserName(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id('password')}>Their password</Label>
                <SecretInput id={id('password')} value={password} onChange={setPassword} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id('sudo')}>sudo password (optional)</Label>
              <SecretInput
                id={id('sudo')}
                value={sudoPassword}
                onChange={setSudoPassword}
                placeholder="Leave empty to use the saved login password"
              />
            </div>
            <Notice tone="warning" icon={TriangleAlert} className="text-xs">
              Everything the core on {server.nickname} knows now is replaced. This computer enrolls
              again as the Owner above.
            </Notice>
          </div>
        )}

        {steps.length > 0 && (
          <ol aria-label="Restore steps" className="space-y-1">
            {steps.map((step) => (
              <li
                key={`${step.phase}:${step.title}`}
                className={cn(
                  'flex items-start gap-2 text-xs',
                  step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {step.status === 'running' ? (
                  <Spinner className="mt-0.5 h-3 w-3 shrink-0 motion-safe:animate-spin" />
                ) : step.status === 'done' ? (
                  <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                ) : (
                  <CircleX className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                <span>
                  {step.title}
                  {step.status === 'failed' ? ' (failed)' : ''}
                  {step.detail ? `: ${step.detail}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}

        <DialogFooter>
          <Button variant="soft" disabled={busy} onClick={() => onOpenChange(false)}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button variant="destructive" disabled={!ready} onClick={() => void restore()}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Restore
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
