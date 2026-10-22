import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
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
import { rememberPassword, stepUpWithSavedPassword } from '@/lib/deploy/savedPassword';
import { queryKeys } from '@/lib/queryKeys';
import { RememberPasswordOption } from '../RememberPasswordOption';

/**
 * The core's step-up for sensitive changes: the password, or a code from the authenticator app,
 * entered within the last ten minutes. The app only steps up when that window has passed (or is
 * about to), remembers the new one for the next change, and steps up once more if the core turns
 * a change down anyway, since its clock is the one that counts. Each time it uses the password
 * the computer was asked to remember, and asks only when there is none or the core refuses it.
 */

export interface StepUp {
  /** Runs `work` once the core has a fresh step-up; undefined when the user backs out. */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  /** Render this once, wherever the hook is used. */
  dialog: React.ReactNode;
}

interface Known {
  until: number;
  twoFactor: boolean;
}

/** Ask again rather than let a change race the end of the window. */
const MARGIN_MS = 30_000;
/** SignalR's words for a refused policy; the role was checked before the button showed. */
const UNAUTHORIZED = /because user is unauthorized/i;

export function useStepUp(server: DeployServer): StepUp {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<{
    twoFactor: boolean;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const serverId = server.id;

  const known = useCallback(async (): Promise<Known> => {
    const key = queryKeys.deployStepUp(serverId);
    const cached = queryClient.getQueryData<Known>(key);
    if (cached) return cached;
    let found: Known = { until: 0, twoFactor: false };
    try {
      const account = await window.agentmat.deploy.account(serverId);
      found = { until: account.stepUpUntilUnixMs ?? 0, twoFactor: account.twoFactorEnabled };
    } catch {
      // Asking for the password is the safe answer to not knowing.
    }
    queryClient.setQueryData(key, found);
    return found;
  }, [queryClient, serverId]);

  const ask = useCallback(
    (twoFactor: boolean) => new Promise<boolean>((resolve) => setAsking({ twoFactor, resolve })),
    [],
  );

  const keep = useCallback(
    (until: number) =>
      queryClient.setQueryData<Known>(queryKeys.deployStepUp(serverId), (old) => ({
        twoFactor: old?.twoFactor ?? false,
        until,
      })),
    [queryClient, serverId],
  );

  /** Steps up with the remembered password when there is one, and asks for it when there is not. */
  const confirm = useCallback(
    async (twoFactor: boolean): Promise<boolean> => {
      const until = await stepUpWithSavedPassword(serverId);
      if (until === null) return ask(twoFactor);
      keep(until);
      return true;
    },
    [serverId, ask, keep],
  );

  const run = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      const state = await known();
      if (state.until - Date.now() < MARGIN_MS && !(await confirm(state.twoFactor))) {
        return undefined;
      }
      try {
        return await work();
      } catch (error) {
        if (!UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) throw error;
        if (!(await confirm(state.twoFactor))) return undefined;
        return await work();
      }
    },
    [known, confirm],
  );

  const finish = (confirmed: boolean, until?: number) => {
    if (until !== undefined) keep(until);
    asking?.resolve(confirmed);
    setAsking(null);
  };

  return {
    run,
    dialog: (
      <StepUpDialog
        server={server}
        open={asking !== null}
        twoFactor={asking?.twoFactor ?? false}
        onConfirmed={(until) => finish(true, until)}
        onCancel={() => finish(false)}
      />
    ),
  };
}

function StepUpDialog({
  server,
  open,
  twoFactor,
  onConfirmed,
  onCancel,
}: {
  server: DeployServer;
  open: boolean;
  twoFactor: boolean;
  onConfirmed: (until: number) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setCode('');
    setUseCode(false);
    setRemember(false);
    setProblem(null);
  }, [open]);

  const answer = useCode ? code.replace(/\s/g, '') : password;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!answer) return;
    setBusy(true);
    setProblem(null);
    try {
      const confirmed = await window.agentmat.deploy.stepUp({
        serverId: server.id,
        ...(useCode ? { totpCode: answer } : { password: answer }),
      });
      if (remember && !useCode) await rememberPassword(queryClient, server.id, answer);
      onConfirmed(confirmed.stepUpUntilUnixMs);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" /> Confirm it is you
            </DialogTitle>
            <DialogDescription>
              Changing who can reach {server.nickname} takes your password again. It counts for the
              next 10 minutes.
            </DialogDescription>
          </DialogHeader>
          {useCode ? (
            <div className="space-y-1.5">
              <Label htmlFor={`stepup-code-${server.id}`}>Authenticator code</Label>
              <Input
                id={`stepup-code-${server.id}`}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                className="max-w-40 font-mono tracking-widest"
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={`stepup-password-${server.id}`}>Password</Label>
              <SecretInput
                id={`stepup-password-${server.id}`}
                value={password}
                onChange={setPassword}
                placeholder="Your password on the core"
                autoFocus
              />
            </div>
          )}
          {!useCode && (
            <RememberPasswordOption
              id={`stepup-remember-${server.id}`}
              checked={remember}
              disabled={busy}
              onCheckedChange={setRemember}
            />
          )}
          {twoFactor && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto rounded-sm p-0 text-xs"
              onClick={() => {
                setUseCode((current) => !current);
                setProblem(null);
              }}
            >
              {useCode ? 'Use your password' : 'Use a code from your authenticator app'}
            </Button>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !answer}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
