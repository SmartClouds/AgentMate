import type { DeployServer } from '@shared/deployTypes';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server } from '@/components/icons';
import { Chip } from '@/components/pageKit';
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
import { Label } from '@/components/ui/label';
import { applyPicks, chosenServers } from '@/lib/deploy/railServers';

/**
 * Picks which saved servers the Deploy page lists. Nothing changes until Save. A server picked
 * now joins the end of the rail, and the ones already there keep their places.
 */

function PickForm({
  servers,
  chosenIds,
  onSave,
  onCancel,
}: {
  servers: DeployServer[];
  chosenIds: string[];
  onSave: (ids: string[]) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const id = useId();
  const navigate = useNavigate();
  // The form lives inside the dialog's content, which closing unmounts: every open starts over
  // from what the rail shows right now.
  const shown = chosenServers(servers, chosenIds).map((server) => server.id);
  const [picked, setPicked] = useState(() => new Set(shown));
  const changed = picked.size !== shown.length || shown.some((serverId) => !picked.has(serverId));

  function toggle(serverId: string, on: boolean): void {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(serverId);
      else next.delete(serverId);
      return next;
    });
  }

  return (
    <div className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Choose servers to show</DialogTitle>
        <DialogDescription>
          Deploy lists only the servers you pick here. Servers you save in Remote stay out of Deploy
          until you pick them.
        </DialogDescription>
      </DialogHeader>
      {servers.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border/70 p-4 text-sm text-muted-foreground">
          <p>You have no saved servers yet. Save one in Remote, then pick it here.</p>
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => {
              onCancel();
              navigate('/remote');
            }}
          >
            <Server /> Open Remote
          </Button>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-col divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/70">
          {servers.map((server) => (
            <li key={server.id}>
              <Label
                htmlFor={`${id}-${server.id}`}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 font-normal transition-colors hover:bg-foreground/[0.04]"
              >
                <Checkbox
                  id={`${id}-${server.id}`}
                  checked={picked.has(server.id)}
                  onCheckedChange={(checked) => toggle(server.id, checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {server.nickname}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {server.username}@{server.host}:{server.port}
                  </span>
                </span>
                {server.dev && <Chip tone="warning">Development</Chip>}
              </Label>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" variant="soft" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!changed}
          onClick={() => onSave(applyPicks(chosenIds, servers, picked))}
        >
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ChooseServersDialog({
  open,
  onOpenChange,
  servers,
  chosenIds,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every saved server, chosen or not. */
  servers: DeployServer[];
  /** The ids Deploy lists now, in the rail's order. */
  chosenIds: string[];
  onSave: (ids: string[]) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <PickForm
          servers={servers}
          chosenIds={chosenIds}
          onCancel={() => onOpenChange(false)}
          onSave={(ids) => {
            onSave(ids);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
