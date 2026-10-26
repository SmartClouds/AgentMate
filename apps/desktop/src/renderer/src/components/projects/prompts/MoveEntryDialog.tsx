import type { Project } from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ProjectIcon } from '../ProjectIcon';

/**
 * Picks the project an entry should be re-filed under. The caller keys this on
 * the entry id, so every open starts with an empty pick rather than inheriting
 * whatever was chosen for the previous entry.
 */
export function MoveEntryDialog({
  entry,
  projects,
  pending,
  onClose,
  onMove,
}: {
  entry: PromptHistoryEntry | null;
  projects: Project[];
  pending: boolean;
  onClose: () => void;
  onMove: (targetProjectId: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState('');

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          setSelected('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to another project</DialogTitle>
          <DialogDescription>
            The entry leaves this project's history and shows up under the one you pick. Nothing
            about the prompt itself changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Project</Label>
          <Combobox
            options={projects.map((p) => ({
              value: p.id,
              label: p.name,
              keywords: p.tags,
              icon: (
                <ProjectIcon
                  iconDataUrl={p.iconDataUrl}
                  bgColor={p.iconBgColor}
                  iconColor={p.iconColor}
                  className="h-5 w-5 rounded"
                  glyphClassName="h-3 w-3"
                />
              ),
            }))}
            value={selected}
            onChange={setSelected}
            placeholder="Pick a project…"
            searchPlaceholder="Search projects…"
            emptyText="No other projects."
          />
        </div>

        <DialogFooter>
          <Button variant="soft" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={!selected || pending} onClick={() => onMove(selected)}>
            {pending ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
