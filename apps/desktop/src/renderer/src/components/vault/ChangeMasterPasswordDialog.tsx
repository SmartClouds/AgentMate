import { masterPasswordProblem } from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
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
import { PasswordStrengthMeter } from './PasswordStrengthMeter';

export function ChangeMasterPasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const ids = { current: useId(), next: useId(), again: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = next ? masterPasswordProblem(next) : null;
  const mismatch = again !== '' && again !== next;
  const ready = current !== '' && next !== '' && !problem && again === next && !busy;

  function reset(): void {
    setCurrent('');
    setNext('');
    setAgain('');
    setError(null);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (await window.runova.vault.changePassword(current, next)) {
        toast.success('Master password changed', {
          description: 'Use the new password the next time you unlock the vault.',
        });
        reset();
        onOpenChange(false);
      } else {
        setError('Your current password is wrong.');
      }
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change master password</DialogTitle>
          <DialogDescription>
            The vault is encrypted again with a fresh key. Old copies of the vault file keep the old
            password.
          </DialogDescription>
        </DialogHeader>
        <form id="vault-change-password" className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={ids.current}>Current password</Label>
            <SecretInput id={ids.current} value={current} onChange={setCurrent} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.next}>New password</Label>
            <SecretInput id={ids.next} value={next} onChange={setNext} />
            <PasswordStrengthMeter password={next} showWarning={!problem} />
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.again}>Type the new password again</Label>
            <SecretInput id={ids.again} value={again} onChange={setAgain} />
            {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="vault-change-password" disabled={!ready}>
            {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
            Change password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
