import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { sshErrorCode } from '@shared/sshErrors';
import { useEffect, useState } from 'react';
import { Key, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';
import {
  type AccountDraft,
  AccountFields,
  accountProblem,
  EMPTY_ACCOUNT,
  toAccount,
} from './AccountFields';
import { SudoPasswordField } from './SudoPasswordField';

/**
 * Enrolling this computer on a core it is not on (or no longer on): over SSH as root, a fresh key
 * for an account the core has, then a sign-in with that account's password.
 */
export function EnrollDialog({
  server,
  open,
  onOpenChange,
  onEnrolled,
}: {
  server: DeployServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: () => void;
}): React.JSX.Element {
  const [account, setAccount] = useState<AccountDraft>(EMPTY_ACCOUNT);
  const [sudoPassword, setSudoPassword] = useState('');
  const [sudoCode, setSudoCode] = useState<ReturnType<typeof sshErrorCode>>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccount(EMPTY_ACCOUNT);
    setSudoPassword('');
    setSudoCode(null);
    setProblem(null);
  }, [open]);

  const accountIssue = accountProblem(account, 'existing');
  const needsSudo = sudoCode === 'sudo-password-required' || sudoCode === 'sudo-password-rejected';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (accountIssue || (needsSudo && !sudoPassword)) return;
    setBusy(true);
    setProblem(null);
    try {
      await withHostKeyTrust(server.id, () =>
        window.runova.deploy.enroll({
          serverId: server.id,
          sudoPassword: needsSudo ? sudoPassword : null,
          account: toAccount(account),
        }),
      );
      onEnrolled();
      onOpenChange(false);
    } catch (error) {
      const code = sshErrorCode(error);
      if (code === 'sudo-password-required' || code === 'sudo-password-rejected') {
        setSudoCode(code);
      } else {
        setProblem(coreErrorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-4 w-4 text-primary" /> Enroll this computer on {server.nickname}
            </DialogTitle>
            <DialogDescription>
              Runova makes a new key for this computer and registers it on the core over SSH. Use an
              account the core already has.
            </DialogDescription>
          </DialogHeader>
          <AccountFields
            mode="existing"
            draft={account}
            onChange={setAccount}
            idPrefix={`enroll-${server.id}`}
          />
          {needsSudo && (
            <SudoPasswordField
              id={`enroll-sudo-${server.id}`}
              user={server.username}
              value={sudoPassword}
              onChange={setSudoPassword}
              onSubmit={() => undefined}
              errorCode={sudoCode}
            />
          )}
          {problem && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || accountIssue !== null || (needsSudo && !sudoPassword)}
            >
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Enroll
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
