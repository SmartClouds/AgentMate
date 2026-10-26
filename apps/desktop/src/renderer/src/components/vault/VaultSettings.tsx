import {
  type AppSettings,
  VAULT_AUTO_LOCK_CHOICES,
  VAULT_CLIPBOARD_CLEAR_CHOICES,
} from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Key, Trash2, Vault } from '@/components/icons';
import { SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { ChangeMasterPasswordDialog } from './ChangeMasterPasswordDialog';
import { ResetVaultDialog } from './ResetVaultDialog';

type VaultSettingsKeys = Pick<
  AppSettings,
  'vaultAutoLockMinutes' | 'vaultClipboardClearSeconds' | 'vaultLockOnSystemLock'
>;

function minutesLabel(minutes: number): string {
  if (minutes === 0) return 'Never';
  return minutes === 60 ? '1 hour' : `${minutes} min`;
}

function secondsLabel(seconds: number): string {
  if (seconds === 0) return 'Never';
  return seconds === 60 ? '1 min' : `${seconds}s`;
}

function Choices({
  label,
  hint,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  hint: string;
  options: readonly number[];
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(SEGMENT_TRACK, 'max-w-full flex-wrap')}
      >
        {options.map((option) => {
          const checked = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={checked}
              data-value={option}
              onClick={() => onChange(option)}
              className={cn(segmentClass(checked), 'px-3 text-xs')}
            >
              {format(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The Vault section of Settings. Changes save as they are made and apply to a vault that is
 * already open.
 */
export function VaultSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<VaultSettingsKeys>({
    vaultAutoLockMinutes: settings.vaultAutoLockMinutes,
    vaultClipboardClearSeconds: settings.vaultClipboardClearSeconds,
    vaultLockOnSystemLock: settings.vaultLockOnSystemLock,
  });
  const [changeOpen, setChangeOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    setValues({
      vaultAutoLockMinutes: settings.vaultAutoLockMinutes,
      vaultClipboardClearSeconds: settings.vaultClipboardClearSeconds,
      vaultLockOnSystemLock: settings.vaultLockOnSystemLock,
    });
  }, [
    settings.vaultAutoLockMinutes,
    settings.vaultClipboardClearSeconds,
    settings.vaultLockOnSystemLock,
  ]);

  const statusQuery = useQuery({
    queryKey: queryKeys.vaultStatus,
    queryFn: () => window.runova.vault.status(),
    meta: { silentLoading: true },
  });
  const state = statusQuery.data?.state;

  async function save(patch: Partial<VaultSettingsKeys>): Promise<void> {
    const previous = values;
    setValues({ ...values, ...patch });
    try {
      await window.runova.settings.update(patch);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
    } catch {
      setValues(previous);
      toast.error('Could not save the vault setting');
    }
  }

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Vault className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>Vault</CardTitle>
          <CardDescription>
            How long the vault stays open, and how long a copied password stays on the clipboard.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Choices
          label="Lock after"
          hint="Minutes without using the vault before it locks itself."
          options={VAULT_AUTO_LOCK_CHOICES}
          value={values.vaultAutoLockMinutes}
          format={minutesLabel}
          onChange={(vaultAutoLockMinutes) => void save({ vaultAutoLockMinutes })}
        />
        <Choices
          label="Clear copied values after"
          hint="Only cleared if the clipboard still holds what the vault copied."
          options={VAULT_CLIPBOARD_CLEAR_CHOICES}
          value={values.vaultClipboardClearSeconds}
          format={secondsLabel}
          onChange={(vaultClipboardClearSeconds) => void save({ vaultClipboardClearSeconds })}
        />
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">
              Lock when this computer locks or sleeps
            </span>
            <span className="block text-xs text-muted-foreground">
              Covers stepping away without waiting for the timer.
            </span>
          </span>
          <Switch
            aria-label="Lock when this computer locks or sleeps"
            checked={values.vaultLockOnSystemLock}
            onCheckedChange={(vaultLockOnSystemLock) => void save({ vaultLockOnSystemLock })}
          />
        </label>

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          <SimpleTooltip
            label={state === 'unlocked' ? null : 'Unlock the vault first to change its password'}
            wrapTrigger
          >
            <Button
              variant="soft"
              disabled={state !== 'unlocked'}
              onClick={() => setChangeOpen(true)}
            >
              <Key className="h-3.5 w-3.5" />
              Change master password
            </Button>
          </SimpleTooltip>
          <Button
            variant="danger"
            disabled={state === 'uninitialized'}
            onClick={() => setResetOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Reset vault
          </Button>
        </div>
      </CardContent>
      <ChangeMasterPasswordDialog open={changeOpen} onOpenChange={setChangeOpen} />
      <ResetVaultDialog open={resetOpen} onOpenChange={setResetOpen} />
    </Card>
  );
}
