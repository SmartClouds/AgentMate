import type { DockerImage } from '@shared/apiTypes';
import { Package, Spinner, Trash2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { imageLabel, shortImageId, splitReference } from './images';

/** More tags than this fold into a "+N" chip, so one heavily tagged image keeps a single line. */
const MAX_TAG_CHIPS = 3;

function TagChips({ tags, repository }: { tags: string[]; repository: string }): React.JSX.Element {
  // A tag on the row's own repository shows just the tag; one on another repository shows whole.
  const labels = tags.map((ref) => {
    const split = splitReference(ref);
    return split.repository === repository && split.tag ? split.tag : ref;
  });
  const shown = labels.slice(0, MAX_TAG_CHIPS);
  const hidden = labels.slice(MAX_TAG_CHIPS);
  return (
    <>
      {shown.map((label) => (
        <Chip key={label} className="font-mono">
          {label}
        </Chip>
      ))}
      {hidden.length > 0 && (
        <SimpleTooltip label={hidden.join(', ')}>
          <Chip tabIndex={0} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
            +{hidden.length}
          </Chip>
        </SimpleTooltip>
      )}
    </>
  );
}

/**
 * One image on this machine, flat for a `.settings-rows` list the way container rows are. An
 * image a container uses cannot be removed from here, and the disabled button says why.
 */
export function DockerImageRow({
  image,
  pending,
  onRemove,
}: {
  image: DockerImage;
  pending: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  const label = imageLabel(image);
  const repository = image.tags[0] ? splitReference(image.tags[0]).repository : null;
  const inUse = image.containers > 0;

  return (
    <li
      aria-label={label}
      className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-foreground/[0.03]"
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          image.dangling
            ? 'bg-foreground/[0.06] text-muted-foreground'
            : 'bg-primary/12 text-primary',
        )}
      >
        <Package className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {repository ? (
            <SimpleTooltip label={repository}>
              <span className="min-w-0 truncate text-sm font-medium">{repository}</span>
            </SimpleTooltip>
          ) : (
            <span className="font-mono text-sm text-muted-foreground">
              {shortImageId(image.id)}
            </span>
          )}
          {repository && <TagChips tags={image.tags} repository={repository} />}
          {image.dangling && <Chip tone="warning">Dangling</Chip>}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{shortImageId(image.id)}</span> · Created {image.createdSince}
        </p>
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {image.sizeBytes === null ? '?' : formatBytes(image.sizeBytes)}
      </span>
      <span className="flex w-24 shrink-0 justify-end">
        {inUse ? (
          <Chip tone="success" dot>
            In use · {image.containers}
          </Chip>
        ) : (
          <Chip>Unused</Chip>
        )}
      </span>
      <SimpleTooltip
        label={
          inUse
            ? `Used by ${image.containers} container${image.containers === 1 ? '' : 's'}. Remove ${image.containers === 1 ? 'it' : 'them'} first.`
            : 'Remove'
        }
        wrapTrigger
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:bg-destructive/10 hover:text-destructive"
          disabled={inUse || pending}
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          {pending ? (
            <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </SimpleTooltip>
    </li>
  );
}
