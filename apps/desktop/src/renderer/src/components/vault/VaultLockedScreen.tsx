import type { VaultLockReason, VaultStatus } from '@shared/apiTypes';
import { vaultErrorCode, vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Lock, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { useVaultStore } from '@/stores/vaultStore';
import { ResetVaultDialog } from './ResetVaultDialog';
import { VaultAccessCard } from './VaultAccessCard';

function lockReasonText(reason: VaultLockReason | null, minutes: number): string | null {
  switch (reason) {
    case 'idle':
      return `Locked after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without activity.`;
    case 'system':
      return 'Locked when this computer locked or went to sleep.';
    case 'restore':
      return 'Locked to restore a backup. Use the master password of the vault in that backup.';
    default:
      return null;
  }
}

/** Ticks once a quarter second until `until`, returning whole seconds left (0 when free). */
function useSecondsUntil(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function VaultLockedScreen({ status }: { status: VaultStatus }): React.JSX.Element {
  const queryClient = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const lastLockReason = useVaultStore((s) => s.lastLockReason);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [corrupt, setCorrupt] = useState(false);
  const [shake, setShake] = useState(0);
  const [retryUntil, setRetryUntil] = useState(() => Date.now() + status.retryAfterMs);
  const [resetOpen, setResetOpen] = useState(false);
  const secondsLeft = useSecondsUntil(retryUntil);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function unlock(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (!password || busy || secondsLeft > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.runova.vault.unlock(password);
      if (result.ok) {
        setPassword('');
        await queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
        return;
      }
      if (result.reason === 'wrong-password') {
        setError("That password doesn't match this vault.");
        setShake((n) => n + 1);
        setPassword('');
      }
      if (result.retryAfterMs > 0) setRetryUntil(Date.now() + result.retryAfterMs);
    } catch (err) {
      setCorrupt(vaultErrorCode(err) === 'corrupt');
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
      inputRef.current?.focus();
    }
  }

  const reason = lockReasonText(lastLockReason, status.autoLockMinutes);

  return (
    <VaultAccessCard
      icon={Lock}
      title="Vault is locked"
      description={reason ?? 'Enter your master password to open it.'}
      shakeKey={shake}
    >
      <form className="space-y-3" onSubmit={unlock}>
        <Label htmlFor={inputId} className="sr-only">
          Master password
        </Label>
        <SecretInput
          ref={inputRef}
          id={inputId}
          value={password}
          onChange={setPassword}
          placeholder="Master password"
          className="h-10 pl-4"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
        />
        <div aria-live="polite" className="min-h-[1.25rem] text-sm">
          {error && (
            <p id={`${inputId}-error`} role="alert" className="text-destructive">
              {error}
              {corrupt && ' Reset it to start a new, empty vault.'}
            </p>
          )}
          {!error && secondsLeft > 0 && (
            <p className="text-muted-foreground">Too many tries. Try again in {secondsLeft}s.</p>
          )}
          {error && secondsLeft > 0 && (
            <p className="text-muted-foreground">Try again in {secondsLeft}s.</p>
          )}
        </div>
        <Button
          type="submit"
          size="lg"
          className="h-10 w-full"
          disabled={!password || busy || secondsLeft > 0}
        >
          {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
          Unlock
        </Button>
        <div className="text-center">
          <button
            type="button"
            className="cursor-pointer rounded-full px-2 py-0.5 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setResetOpen(true)}
          >
            Forgot your master password?
          </button>
        </div>
      </form>
      <ResetVaultDialog open={resetOpen} onOpenChange={setResetOpen} />
    </VaultAccessCard>
  );
}
