import type { VaultExportFormat } from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Spinner, TriangleAlert } from '@/components/icons';
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
import { cn } from '@/lib/utils';

const FORMATS: { value: VaultExportFormat; label: string; hint: string }[] = [
  {
    value: 'runova',
    label: 'Runova CSV',
    hint: 'Every field of every entry type. Imports back into Runova exactly.',
  },
  {
    value: 'bitwarden',
    label: 'Bitwarden CSV',
    hint: 'For moving to Bitwarden or another manager that reads its format.',
  },
];

export function VaultExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const passwordId = useId();
  const [format, setFormat] = useState<VaultExportFormat>('runova');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportVault(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.runova.vault.exportCsv(password, format);
      if (result.ok) {
        toast.success('Vault exported', {
          description: 'Keep the file somewhere safe and delete it when you are done.',
        });
        setPassword('');
        onOpenChange(false);
      } else if (result.reason === 'wrong-password') {
        setError("That password doesn't match this vault.");
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
      onOpenChange={(next) => {
        if (!next) setPassword('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export the vault</DialogTitle>
          <DialogDescription>Save every entry to a CSV file.</DialogDescription>
        </DialogHeader>
        <form id="vault-export-form" className="space-y-4" onSubmit={exportVault}>
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
            The file holds every password in plain text. Anyone who can open it can read them, so
            don't leave it in Downloads or a synced folder.
          </p>

          <div role="radiogroup" aria-label="File format" className="space-y-2">
            {FORMATS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2',
                  format === option.value ? 'border-primary/50 bg-primary/5' : 'border-border/70',
                )}
              >
                <input
                  type="radio"
                  name="vault-export-format"
                  checked={format === option.value}
                  onChange={() => setFormat(option.value)}
                  className="mt-1 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="block text-sm">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={passwordId}>Master password</Label>
            <SecretInput id={passwordId} value={password} onChange={setPassword} />
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
          <Button type="submit" form="vault-export-form" disabled={!password || busy}>
            {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
