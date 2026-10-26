import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer, DeployTotpSetup } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Shield, Spinner } from '@/components/icons';
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

type Step = 'confirm' | 'scan' | 'codes';

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
}

/**
 * Turning two-factor on, or off. Both start by confirming the password (the core's step-up), so a
 * token lifted from this computer cannot change the account's second factor on its own.
 */
export function TwoFactorDialog({
  server,
  mode,
  open,
  onOpenChange,
  onChanged,
}: {
  server: DeployServer;
  mode: 'on' | 'off';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState<Step>('confirm');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<DeployTotpSetup | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep('confirm');
    setPassword('');
    setCode('');
    setSetup(null);
    setRecovery([]);
    setProblem(null);
  }, [open]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const confirmPassword = () =>
    run(async () => {
      await window.runova.deploy.stepUp({ serverId: server.id, password });
      if (mode === 'on') setSetup(await window.runova.deploy.beginTotp(server.id));
      setStep('scan');
    });

  const confirmCode = () =>
    run(async () => {
      const digits = code.replace(/\s/g, '');
      if (mode === 'on') {
        setRecovery((await window.runova.deploy.confirmTotp(server.id, digits)).codes);
        setStep('codes');
      } else {
        await window.runova.deploy.disableTotp(server.id, digits);
        toast.success('Two-factor is off.');
        onOpenChange(false);
      }
      onChanged();
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            {mode === 'on' ? 'Turn on two-factor' : 'Turn off two-factor'}
          </DialogTitle>
          <DialogDescription>
            {step === 'confirm' && 'First confirm your password.'}
            {step === 'scan' &&
              (mode === 'on'
                ? 'Scan this with an authenticator app (1Password, Google Authenticator, Authy...), then enter the code it shows.'
                : 'Enter a current code from your authenticator app.')}
            {step === 'codes' &&
              'Two-factor is on. Keep these recovery codes somewhere safe: each one works once if you lose your phone. They are not shown again.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'confirm' && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (password) void confirmPassword();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`twofactor-password-${server.id}`}>Password</Label>
              <SecretInput
                id={`twofactor-password-${server.id}`}
                value={password}
                onChange={setPassword}
                placeholder="Your password on the core"
                autoFocus
              />
            </div>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !password}>
                {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Continue
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'scan' && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (code) void confirmCode();
            }}
          >
            {setup && (
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <img
                  src={setup.qrDataUrl}
                  alt="QR code with the new authenticator key"
                  className="h-40 w-40 shrink-0 rounded-lg bg-white p-1.5"
                />
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    No camera? Type this key into the app instead:
                  </p>
                  <p className="font-mono text-sm text-foreground" aria-label="Authenticator key">
                    {setup.sharedKey}
                  </p>
                  <Button
                    type="button"
                    variant="soft"
                    size="sm"
                    onClick={() => void copy(setup.sharedKey.replace(/\s/g, ''), 'Key')}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy the key
                  </Button>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`twofactor-code-${server.id}`}>Code from the app</Label>
              <Input
                id={`twofactor-code-${server.id}`}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                className="max-w-40 font-mono tracking-widest"
                autoFocus
              />
            </div>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={mode === 'off' ? 'destructive' : 'default'}
                disabled={busy || !code}
              >
                {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                {mode === 'on' ? 'Turn on' : 'Turn off'}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'codes' && (
          <div className="space-y-4">
            <ul
              className="grid grid-cols-2 gap-2 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]"
              aria-label="Recovery codes"
            >
              {recovery.map((recoveryCode) => (
                <li key={recoveryCode} className="font-mono text-sm text-foreground">
                  {recoveryCode}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                type="button"
                variant="soft"
                onClick={() => void copy(recovery.join('\n'), 'Recovery codes')}
              >
                <Copy className="h-3.5 w-3.5" /> Copy all
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                I saved them
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
