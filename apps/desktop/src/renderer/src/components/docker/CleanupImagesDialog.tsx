import type { DockerImage } from '@shared/apiTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleInfo, Spinner } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
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
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { imageLabel, shortImageId, totalBytes } from './images';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function ImageGroup({
  title,
  selectAllLabel,
  images,
  selected,
  failures,
  disabled,
  onToggle,
  onToggleAll,
}: {
  title: string;
  selectAllLabel: string;
  images: DockerImage[];
  selected: Set<string>;
  failures: Map<string, string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}): React.JSX.Element | null {
  if (images.length === 0) return null;
  const ticked = images.filter((image) => selected.has(image.id)).length;
  const all = ticked === images.length;
  return (
    <section aria-label={title} className="space-y-1">
      <div className="flex items-center gap-2.5 px-2 py-1">
        <Checkbox
          aria-label={selectAllLabel}
          checked={all ? true : ticked > 0 ? 'indeterminate' : false}
          disabled={disabled}
          onCheckedChange={() => onToggleAll(!all)}
        />
        <p className={cn(SECTION_HEADING, 'flex-1')}>
          {title} <span className="tabular-nums">({images.length})</span>
        </p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(totalBytes(images))}
        </span>
      </div>
      <ul className="settings-rows rounded-lg bg-foreground/[0.03]">
        {images.map((image) => {
          const label = imageLabel(image);
          const failure = failures.get(image.id);
          return (
            <li key={image.id} className="px-2 py-1.5">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  aria-label={label}
                  checked={selected.has(image.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => onToggle(image.id, checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-foreground">{label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {image.tags.length > 1 && `${image.tags.slice(1).join(', ')} · `}
                    {image.dangling ? `${shortImageId(image.id)} · ` : ''}
                    Created {image.createdSince}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {image.sizeBytes === null ? 'Size unknown' : formatBytes(image.sizeBytes)}
                </span>
              </label>
              {failure && (
                <p role="alert" className="mt-1 pl-7 text-xs text-destructive">
                  {failure}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Removes images no container uses, after the user has seen each one. Dangling images (left
 * nameless by a newer build or pull) start ticked since nothing can refer to them; tagged ones
 * are opt-in, because a tag is often kept on purpose to start a container from later.
 */
export function CleanupImagesDialog({
  open,
  images,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  /** The unused images. */
  images: DockerImage[];
  onOpenChange: (open: boolean) => void;
  /** After any removal went through, so the list behind the dialog can catch up. */
  onDone: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [removing, setRemoving] = useState(false);

  // A fresh pick each time the dialog opens. Not on every refetch of `images`, which would undo
  // what the user ticked while the list refreshed underneath.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the opening resets the pick.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(images.filter((image) => image.dangling).map((image) => image.id)));
    setFailures(new Map());
  }, [open]);

  const dangling = images.filter((image) => image.dangling);
  const tagged = images.filter((image) => !image.dangling);
  const picked = images.filter((image) => selected.has(image.id));
  const freed = formatBytes(totalBytes(picked));

  function toggle(ids: string[], on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    try {
      const result = await window.runova.docker.removeImages(
        picked.map((image) => ({ id: image.id, tags: image.tags })),
      );
      if (result.removed.length > 0) onDone();
      if (result.failed.length === 0) {
        toast.success(`Removed ${plural(result.removed.length, 'image')}, freeing up to ${freed}.`);
        onOpenChange(false);
        return;
      }
      if (result.removed.length > 0) {
        toast.success(`Removed ${result.removed.length} of ${plural(picked.length, 'image')}.`);
      }
      setFailures(new Map(result.failed.map((failure) => [failure.id, failure.error])));
      setSelected(new Set(result.failed.map((failure) => failure.id)));
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !removing && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clean up unused images</DialogTitle>
          <DialogDescription>
            No container on this machine uses these. Removed images can be pulled or built again
            later.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-2 min-h-0 space-y-3 overflow-y-auto px-2">
          <ImageGroup
            title="Dangling images"
            selectAllLabel="Select all dangling images"
            images={dangling}
            selected={selected}
            failures={failures}
            disabled={removing}
            onToggle={(id, on) => toggle([id], on)}
            onToggleAll={(on) =>
              toggle(
                dangling.map((image) => image.id),
                on,
              )
            }
          />
          <ImageGroup
            title="Unused tagged images"
            selectAllLabel="Select all unused tagged images"
            images={tagged}
            selected={selected}
            failures={failures}
            disabled={removing}
            onToggle={(id, on) => toggle([id], on)}
            onToggleAll={(on) =>
              toggle(
                tagged.map((image) => image.id),
                on,
              )
            }
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <p role="status">
              Frees up to{' '}
              <span className="font-semibold tabular-nums text-foreground">{freed}</span>
            </p>
            <SimpleTooltip label="Layers shared with images you keep stay on disk, so the real saving can be smaller.">
              <span
                tabIndex={0}
                className="flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CircleInfo className="h-3 w-3" aria-label="About this estimate" />
              </span>
            </SimpleTooltip>
          </div>
          <div className="flex gap-2">
            <Button variant="soft" disabled={removing} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removing || picked.length === 0}
              aria-busy={removing}
              onClick={() => void remove()}
            >
              {removing && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              {removing ? 'Removing…' : `Remove ${plural(picked.length, 'image')}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
