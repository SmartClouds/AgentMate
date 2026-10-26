import { coreErrorCode, coreErrorMessage } from '@shared/coreErrors';
import type { DeployAccess, DeployServer } from '@shared/deployTypes';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';

/** Identity's allowed user name characters on the core. */
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;

/** What each refusal means to the person joining. */
function redeemProblem(error: unknown): string {
  switch (coreErrorCode(error)) {
    case 'enrollmentCodeInvalid':
      return 'That code is wrong, used or expired. Ask an Owner for a new one.';
    case 'invalidCredentials':
      return 'That password is not right.';
    case 'rateLimited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return coreErrorMessage(error);
  }
}

/**
 * Joining a core with an enrollment code an Owner made, for someone without sudo on the server:
 * this computer makes its own key, the core takes it with the code and the user's password, and
 * the app signs in. Nothing runs as root, and the password is not saved here.
 */
export function RedeemCodeDialog({
  server,
  open,
  onOpenChange,
  onEnrolled,
}: {
  server: DeployServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: (access: DeployAccess) => void;
}): React.JSX.Element {
  const id = useId();
  const [code, setCode] = useState('');
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setUserName('');
    setPassword('');
    setProblem(null);
  }, [open]);

  const ready = code.trim() !== '' && USER_NAME.test(userName) && password !== '';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const access = await withHostKeyTrust(server.id, () =>
        window.runova.deploySecurity.redeemEnrollmentCode({
          serverId: server.id,
          code: code.trim(),
          userName,
          password,
        }),
      );
      if (access.state === 'signed-in') {
        toast.success(`This computer joined ${server.nickname} and is signed in.`);
      } else {
        toast.success(`This computer joined ${server.nickname}.`, {
          description: 'Sign in with a code from your authenticator app to finish.',
        });
      }
      onEnrolled(access);
      onOpenChange(false);
    } catch (error) {
      setProblem(redeemProblem(error));
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
              <Key className="h-4 w-4 text-primary" /> Join {server.nickname} with a code
            </DialogTitle>
            <DialogDescription>
              An Owner of this core makes the code for you under Security, Users. This computer gets
              a key of its own; your password goes to the core and is not saved here. No sudo is
              needed, but your SSH login has to be in the server's runova group.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-code`}>Enrollment code</Label>
            <Input
              id={`${id}-code`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="K7Q2M-X9PLR-4TVWC-H3NBD"
              className="font-mono tracking-wider"
              autoFocus
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-user`}>User name</Label>
              <Input
                id={`${id}-user`}
                value={userName}
                onChange={(event) => setUserName(event.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
                placeholder="sam"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-password`}>Password</Label>
              <SecretInput
                id={`${id}-password`}
                value={password}
                onChange={setPassword}
                placeholder="Your password on the core"
              />
            </div>
          </div>
          {problem && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Join
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
