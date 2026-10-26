import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
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
import { queryKeys } from '@/lib/queryKeys';

const CONFIRM_WORD = 'RESET';

export function ResetVaultDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  async function reset(): Promise<void> {
    setBusy(true);
    try {
      await window.runova.vault.reset();
      await queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
      toast.success('Vault reset', {
        description: 'The old vault file was set aside. You can create a new vault now.',
      });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not reset the vault', { description: vaultErrorMessage(error) });
    } finally {
      setBusy(false);
      setTyped('');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset the vault?</DialogTitle>
          <DialogDescription>
            Without the master password nothing in the vault can be opened, by you or by Runova.
            Resetting sets the current vault file aside in Runova's data folder and starts an empty
            vault.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={inputId} className="text-sm font-normal">
            Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed.trim() !== CONFIRM_WORD || busy}
            onClick={() => void reset()}
          >
            Reset vault
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
