import { coreErrorCode, coreErrorMessage } from '@shared/coreErrors';
import type { DeployAccess, DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
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
 * Upgrading every package and rebooting need a fresh step-up. The Overview tries first without
 * one (a step-up from the last ten minutes still counts); when the core says it needs one, this
 * uses the password the computer was asked to remember, if it has one, and otherwise asks for the
 * password, or a code from the authenticator app, and tries again with it.
 */

export interface Proof {
  password?: string;
  totpCode?: string;
}

export interface ProofStepUp {
  /** Runs `work`, asking for the password and running it again when the core wants a step-up. */
  run: <T>(work: (proof?: Proof) => Promise<T>, what: string) => Promise<T | undefined>;
  dialog: React.ReactNode;
}

interface Asking {
  what: string;
  attempt: (proof: Proof) => Promise<unknown>;
  settle: (value: { ok: true; result: unknown } | { ok: false }) => void;
}

export function useProofStepUp(server: DeployServer): ProofStepUp {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<Asking | null>(null);
  const serverId = server.id;
  const access = queryClient.getQueryData<DeployAccess>(queryKeys.deployAccess(serverId));
  const twoFactor = access?.user?.twoFactorEnabled ?? false;

  const run = useCallback(
    async <T,>(work: (proof?: Proof) => Promise<T>, what: string): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        if (coreErrorCode(error) !== 'stepUpRequired') throw error;
      }
      if ((await stepUpWithSavedPassword(serverId)) !== null) {
        try {
          return await work();
        } catch (error) {
          if (coreErrorCode(error) !== 'stepUpRequired') throw error;
        }
      }
      const answer = await new Promise<{ ok: true; result: unknown } | { ok: false }>((settle) =>
        setAsking({ what, attempt: work, settle }),
      );
      return answer.ok ? (answer.result as T) : undefined;
    },
    [serverId],
  );

  return {
    run,
    dialog: (
      <ProofDialog
        server={server}
        asking={asking}
        twoFactor={twoFactor}
        onDone={(value) => {
          asking?.settle(value);
          setAsking(null);
        }}
      />
    ),
  };
}

function ProofDialog({
  server,
  asking,
  twoFactor,
  onDone,
}: {
  server: DeployServer;
  asking: Asking | null;
  twoFactor: boolean;
  onDone: (value: { ok: true; result: unknown } | { ok: false }) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const open = asking !== null;
  const opened = useRef(open);

  useEffect(() => {
    if (open && !opened.current) {
      setPassword('');
      setCode('');
      setUseCode(false);
      setRemember(false);
      setProblem(null);
    }
    opened.current = open;
  }, [open]);

  const answer = useCode ? code.replace(/\s/g, '') : password;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!asking || !answer) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await asking.attempt(useCode ? { totpCode: answer } : { password: answer });
      if (remember && !useCode) await rememberPassword(queryClient, server.id, answer);
      onDone({ ok: true, result });
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onDone({ ok: false })}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" /> Confirm it is you
            </DialogTitle>
            <DialogDescription>
              {asking?.what ?? 'This'} on {server.nickname} takes your password again. It counts for
              the next 10 minutes.
            </DialogDescription>
          </DialogHeader>
          {useCode ? (
            <div className="space-y-1.5">
              <Label htmlFor={`proof-code-${server.id}`}>Authenticator code</Label>
              <Input
                id={`proof-code-${server.id}`}
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
              <Label htmlFor={`proof-password-${server.id}`}>Password</Label>
              <SecretInput
                id={`proof-password-${server.id}`}
                value={password}
                onChange={setPassword}
                placeholder="Your password on the core"
                autoFocus
              />
            </div>
          )}
          {!useCode && (
            <RememberPasswordOption
              id={`proof-remember-${server.id}`}
              checked={remember}
              disabled={busy}
              onCheckedChange={setRemember}
            />
          )}
          {twoFactor && (
            <button
              type="button"
              className="cursor-pointer text-xs text-primary underline-offset-4 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setUseCode((current) => !current);
                setProblem(null);
              }}
            >
              {useCode ? 'Use your password' : 'Use a code from your authenticator app'}
            </button>
          )}
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
              onClick={() => onDone({ ok: false })}
            >
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
