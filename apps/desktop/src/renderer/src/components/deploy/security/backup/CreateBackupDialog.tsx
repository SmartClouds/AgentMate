import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Archive, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Notice } from '../../deployKit';
import type { StepUp } from '../useStepUp';

/**
 * Making a backup: a passphrase typed twice, then where to save it. The core encrypts with it on
 * the server, so only the passphrase can open the file; Runova keeps it nowhere.
 */

const MIN = 12;

export function passphraseIssue(passphrase: string, again: string): string | null {
  if (passphrase.length === 0) return null;
  if (passphrase.length < MIN) return `Use at least ${MIN} characters.`;
  if (again.length > 0 && again !== passphrase) return 'The passphrases do not match.';
  return null;
}

export function CreateBackupDialog({
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
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setAgain('');
    setProblem(null);
  }, [open]);

  const issue = passphraseIssue(passphrase, again);
  const ready = passphrase.length >= MIN && again === passphrase && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await stepUp.run(() =>
        window.runova.deployHardening.createBackup({ serverId: server.id, passphrase }),
      );
      if (!result?.saved) return;
      toast.success(`Backup saved to ${result.path}`);
      onOpenChange(false);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-primary" /> Back up {server.nickname}
            </DialogTitle>
            <DialogDescription>
              The core's database, its keys, the apps' files, the sites and certificates, encrypted
              on the server with your passphrase and saved on this computer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`backup-pass-${server.id}`}>Passphrase</Label>
            <SecretInput
              id={`backup-pass-${server.id}`}
              value={passphrase}
              onChange={setPassphrase}
              placeholder="At least 12 characters"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`backup-again-${server.id}`}>Passphrase again</Label>
            <SecretInput id={`backup-again-${server.id}`} value={again} onChange={setAgain} />
          </div>
          {issue && (
            <p className="text-xs text-muted-foreground" role="status">
              {issue}
            </p>
          )}
          <Notice tone="warning" icon={TriangleAlert} className="text-xs">
            Without this passphrase the backup cannot be opened, by you or anyone. Runova does not
            keep it. Write it down somewhere safe.
          </Notice>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Choose where to save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
