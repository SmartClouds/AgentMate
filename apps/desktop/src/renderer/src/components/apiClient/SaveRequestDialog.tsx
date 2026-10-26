import type { ApiTreeNode } from '@runova/core';
import type { ApiCollectionSummary } from '@shared/apiClientTypes';
import { useEffect, useMemo, useState } from 'react';
import { Folder, FolderPlus, FolderTree, Save, TriangleAlert } from '@/components/icons';
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
import { cn } from '@/lib/utils';

export type SaveDestination =
  | { collectionId: string; parentId: string | null }
  | { newCollectionName: string; parentId: null };

interface SaveRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  collections: ApiCollectionSummary[];
  onSave: (destination: SaveDestination, name: string) => Promise<void>;
}

interface Place {
  key: string;
  collectionId: string;
  parentId: string | null;
  label: string;
  depth: number;
}

function folderPlaces(collectionId: string, nodes: ApiTreeNode[], depth: number): Place[] {
  return nodes.flatMap((node) =>
    node.kind === 'folder'
      ? [
          {
            key: `${collectionId}/${node.id}`,
            collectionId,
            parentId: node.id,
            label: node.name,
            depth,
          },
          ...folderPlaces(collectionId, node.children ?? [], depth + 1),
        ]
      : [],
  );
}

/** Asks where a new request goes: a name, and a collection or one of its folders. */
export function SaveRequestDialog({
  open,
  onOpenChange,
  initialName,
  collections,
  onSave,
}: SaveRequestDialogProps): React.JSX.Element {
  const places = useMemo(
    () =>
      collections
        .filter((c) => !c.error)
        .flatMap((c): Place[] => [
          { key: c.id, collectionId: c.id, parentId: null, label: c.name, depth: 0 },
          ...folderPlaces(c.id, c.tree, 1),
        ]),
    [collections],
  );

  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCollection, setNewCollection] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSelected(places[0]?.key ?? null);
    setCreating(places.length === 0);
    setNewCollection('');
    setError(null);
  }, [open, initialName, places]);

  const place = places.find((p) => p.key === selected) ?? null;
  const canSave =
    name.trim().length > 0 && (creating ? newCollection.trim().length > 0 : place !== null);

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const destination: SaveDestination = creating
        ? { newCollectionName: newCollection.trim(), parentId: null }
        : { collectionId: place!.collectionId, parentId: place!.parentId };
      await onSave(destination, name.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-3 border-b border-border/70 px-6 py-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Save className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 space-y-1 pr-8">
            <DialogTitle className="text-base">Save request</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Pick a collection or a folder to keep it in.
            </DialogDescription>
          </div>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="flex min-h-0 flex-col gap-4 px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="api-save-name" className="text-xs font-semibold">
                Name
              </Label>
              <Input
                id="api-save-name"
                aria-label="Request name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>

            <div className="flex min-h-0 flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold">Save to</Label>
                {places.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCreating((value) => !value)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
                  >
                    <FolderPlus className="h-3 w-3" />
                    {creating ? 'Pick an existing one' : 'New collection'}
                  </button>
                )}
              </div>

              {creating ? (
                <Input
                  aria-label="New collection name"
                  placeholder="e.g. Payments API"
                  value={newCollection}
                  onChange={(event) => setNewCollection(event.target.value)}
                />
              ) : (
                <div
                  role="listbox"
                  aria-label="Collections and folders"
                  className="max-h-64 overflow-y-auto rounded-lg border border-border p-1"
                >
                  {places.map((p) => (
                    <div
                      key={p.key}
                      role="option"
                      tabIndex={0}
                      aria-selected={p.key === selected}
                      onClick={() => setSelected(p.key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(p.key);
                        }
                      }}
                      style={{ paddingLeft: `${0.5 + p.depth * 1}rem` }}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                        p.key === selected
                          ? 'bg-primary/12 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      )}
                    >
                      {p.depth === 0 ? (
                        <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{p.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <DialogFooter className="items-center border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
            <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
              {creating
                ? 'A new collection will be created'
                : place
                  ? `Saving to ${place.label}`
                  : 'Pick where to save it'}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="soft" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSave || saving} className="min-w-20">
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
