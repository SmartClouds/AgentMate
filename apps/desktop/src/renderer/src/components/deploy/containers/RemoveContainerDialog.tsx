import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useState } from 'react';
import { Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

/**
 * Removing a container from a server (E06 AC2). Its anonymous volumes can go with it, which only
 * an Admin may ask for, and then the container's name has to be typed out first: the data in a
 * volume cannot be brought back.
 */

export interface RemoveChoice {
  removeVolumes: boolean;
  force: boolean;
}

export function RemoveContainerDialog({
  container,
  canRemoveVolumes,
  onCancel,
  onRemove,
}: {
  container: ContainerSummary | null;
  canRemoveVolumes: boolean;
  onCancel: () => void;
  onRemove: (choice: RemoveChoice) => Promise<boolean>;
}): React.JSX.Element {
  const [volumes, setVolumes] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const open = container !== null;

  useEffect(() => {
    if (open) {
      setVolumes(false);
      setTyped('');
      setBusy(false);
    }
  }, [open]);

  const running = container?.state === 'running' || container?.state === 'restarting';
  const confirmed = !volumes || typed === container?.name;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!container || !confirmed) return;
    setBusy(true);
    const done = await onRemove({ removeVolumes: volumes, force: running });
    if (!done) setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Remove {container?.name}?</DialogTitle>
            <DialogDescription>
              {running
                ? 'It is running, so it is stopped first. Then the container and anything written inside it are gone.'
                : 'The container and anything written inside it are gone. Its image stays.'}
            </DialogDescription>
          </DialogHeader>
          {canRemoveVolumes && (
            <label
              className="flex cursor-pointer items-start gap-2.5 text-sm"
              htmlFor="remove-volumes"
            >
              <Checkbox
                id="remove-volumes"
                checked={volumes}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setVolumes(checked === true);
                  setTyped('');
                }}
              />
              <span>
                Also remove its volumes
                <span className="block text-xs text-muted-foreground">
                  The anonymous volumes it created. Named volumes, such as a database's, stay.
                </span>
              </span>
            </label>
          )}
          {volumes && container && (
            <div className="space-y-1.5 rounded-xl bg-destructive/[0.05] p-3 ring-1 ring-inset ring-destructive/30">
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <TriangleAlert className="h-3.5 w-3.5" /> Data in those volumes cannot be brought
                back.
              </p>
              <Label htmlFor="remove-confirm" className="text-xs">
                Type <span className="font-mono font-semibold">{container.name}</span> to confirm
              </Label>
              <Input
                id="remove-confirm"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              {volumes ? 'Remove with its volumes' : 'Remove the container'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
