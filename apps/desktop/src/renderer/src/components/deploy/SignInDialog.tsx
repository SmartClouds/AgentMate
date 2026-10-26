import { coreErrorCode, coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { Lock, Spinner } from '@/components/icons';
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

/** What each refusal means to the person signing in. */
export function signInProblem(error: unknown): string {
  switch (coreErrorCode(error)) {
    case 'invalidCredentials':
      return 'That password is not right.';
    case 'totpInvalid':
      return 'That code is not right, or it was used already. Codes change every 30 seconds.';
    case 'deviceRevoked':
    case 'deviceUnknown':
      return 'The core no longer accepts this computer. Close this and enroll it again.';
    case 'rateLimited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return coreErrorMessage(error);
  }
}

/**
 * Signing in to a core: this computer's key does its part by itself, so only the password is
 * asked for, and then a code from an authenticator app when two-factor is on.
 */
export function SignInDialog({
  server,
  open,
  onOpenChange,
  onSignedIn,
}: {
  server: DeployServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setCode('');
    setNeedsCode(false);
    setUseRecovery(false);
    setProblem(null);
  }, [open]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!password || (needsCode && !code)) return;
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.deploy.signIn({
        serverId: server.id,
        password,
        ...(needsCode && !useRecovery ? { totpCode: code.replace(/\s/g, '') } : {}),
        ...(needsCode && useRecovery ? { recoveryCode: code.trim() } : {}),
      });
      onSignedIn();
      onOpenChange(false);
    } catch (error) {
      if (coreErrorCode(error) === 'totpRequired') {
        setNeedsCode(true);
      } else {
        setProblem(signInProblem(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" /> Sign in to {server.nickname}
            </DialogTitle>
            <DialogDescription>
              {needsCode
                ? useRecovery
                  ? 'Enter one of the recovery codes you saved when you turned on two-factor.'
                  : 'Enter the 6-digit code from your authenticator app.'
                : 'This computer proves itself with its own key; the core also asks for your password.'}
            </DialogDescription>
          </DialogHeader>
          {!needsCode && (
            <div className="space-y-1.5">
              <Label htmlFor={`signin-password-${server.id}`}>Password</Label>
              <SecretInput
                id={`signin-password-${server.id}`}
                value={password}
                onChange={setPassword}
                placeholder="Your password on the core"
                autoFocus
              />
              {server.dev && (
                <p className="text-xs text-muted-foreground">
                  The DevHost's user is <span className="font-mono">dev</span>, with the password{' '}
                  <span className="whitespace-nowrap font-mono">runova-local-password</span>.
                </p>
              )}
            </div>
          )}
          {needsCode && (
            <div className="space-y-1.5">
              <Label htmlFor={`signin-code-${server.id}`}>
                {useRecovery ? 'Recovery code' : 'Authenticator code'}
              </Label>
              <Input
                id={`signin-code-${server.id}`}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={useRecovery ? 'xxxxx-xxxxx' : '123 456'}
                className="font-mono tracking-widest"
                autoFocus
              />
              <button
                type="button"
                className="cursor-pointer text-xs text-primary underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setUseRecovery((current) => !current);
                  setCode('');
                }}
              >
                {useRecovery
                  ? 'Use the authenticator app instead'
                  : 'Lost your phone? Use a recovery code'}
              </button>
            </div>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password || (needsCode && !code)}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Sign in
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
