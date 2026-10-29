import type { DockerImage } from '@shared/apiTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Package, RefreshCw, Search, Sparkles } from '@/components/icons';
import {
  Chip,
  CountChip,
  EmptyState,
  GLASS_CARD,
  LoadFailure,
  PillTabs,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CleanupImagesDialog } from './CleanupImagesDialog';
import { DockerImageRow } from './DockerImageRow';
import { filterImages, type ImageFilter, imageLabel, totalBytes, unusedImages } from './images';

const FILTERS: { value: ImageFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'inUse', label: 'In use' },
  { value: 'unused', label: 'Unused' },
];

function ImageListSkeleton(): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'settings-rows')} role="status" aria-label="Loading images">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function NoMatch({ filter, search }: { filter: ImageFilter; search: string }): React.JSX.Element {
  if (search) {
    return (
      <EmptyState
        card
        size="sm"
        icon={Search}
        title="Nothing found"
        description={`No images match "${search}".`}
      />
    );
  }
  return filter === 'unused' ? (
    <EmptyState
      card
      size="sm"
      icon={Package}
      title="No unused images"
      description="Every image here is used by a container."
    />
  ) : (
    <EmptyState
      card
      size="sm"
      icon={Package}
      title="No images in use"
      description="No container on this machine was made from these images."
    />
  );
}

/**
 * Every image on this machine, which ones a container uses, and a way to remove the rest one at
 * a time or all together through the Clean up dialog. Docker sizes count shared layers once per
 * image, so totals here are an upper bound and are labelled that way.
 */
export function DockerImagesView(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ImageFilter>('all');
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const imagesQuery = useQuery({
    queryKey: queryKeys.dockerImages,
    queryFn: () => window.runova.docker.listImages(),
    // Images change far less often than containers, which refresh every 4s.
    refetchInterval: 10_000,
    meta: { silentLoading: true },
  });
  const images = imagesQuery.data ?? [];
  const unused = unusedImages(images);
  const search = query.trim();
  const visible = filterImages(images, filter, search);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.dockerImages });

  async function remove(image: DockerImage): Promise<void> {
    const label = imageLabel(image);
    const confirmed = await confirmDialog({
      title: `Remove ${label}?`,
      description: 'No container uses it. It can be pulled or built again later.',
      ...(image.tags.length > 1 ? { items: image.tags.map((name) => ({ name })) } : {}),
      confirmLabel: 'Remove image',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setPendingIds((current) => new Set(current).add(image.id));
    try {
      const result = await window.runova.docker.removeImages([{ id: image.id, tags: image.tags }]);
      const failure = result.failed[0];
      if (failure) toast.error(failure.error);
      else toast.success(`Removed ${label}.`);
      await refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(image.id);
        return next;
      });
    }
  }

  const loading = imagesQuery.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
        <SearchPill
          label="Search images"
          placeholder="Search by name, tag or ID"
          value={query}
          onValueChange={setQuery}
          className="w-full min-w-48 max-w-xs flex-1"
        />
        <PillTabs
          id="docker-image-filter"
          kind="toggle"
          size="xs"
          label="Show images"
          items={FILTERS}
          value={filter}
          onChange={setFilter}
        />
        <div role="group" aria-label="Image counts" className="flex flex-wrap items-center gap-1.5">
          <CountChip label="Images" value={images.length} loading={loading} />
          <CountChip
            label="Unused"
            value={unused.length}
            tone={unused.length > 0 ? 'warning' : 'neutral'}
            loading={loading}
          />
          {!loading && images.length > 0 && (
            <SimpleTooltip label="Shared layers are counted once per image, so the disk used can be less.">
              <Chip
                tabIndex={0}
                className="h-6 px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>Size</span>
                <span className="font-semibold tabular-nums">
                  {formatBytes(totalBytes(images))}
                </span>
              </Chip>
            </SimpleTooltip>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SimpleTooltip
            label={
              unused.length === 0
                ? 'Every image is in use'
                : `Review ${unused.length} unused image${unused.length === 1 ? '' : 's'} to remove`
            }
            wrapTrigger
          >
            <Button
              variant="soft"
              disabled={unused.length === 0}
              onClick={() => setCleanupOpen(true)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Clean up
            </Button>
          </SimpleTooltip>
          <Button
            variant="soft"
            disabled={imagesQuery.isFetching}
            aria-busy={imagesQuery.isFetching}
            onClick={() => void imagesQuery.refetch()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', imagesQuery.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <ImageListSkeleton />
      ) : imagesQuery.error && !imagesQuery.data ? (
        <LoadFailure
          message={coreErrorMessage(imagesQuery.error)}
          retry={() => void imagesQuery.refetch()}
        />
      ) : images.length === 0 ? (
        <EmptyState
          card
          size="lg"
          icon={Package}
          title="No images on this machine"
          description="Images you pull or build with Docker show up here."
        />
      ) : visible.length === 0 ? (
        <NoMatch filter={filter} search={search} />
      ) : (
        <ul aria-label="Images" className={cn(GLASS_CARD, 'settings-rows overflow-hidden')}>
          {visible.map((image) => (
            <DockerImageRow
              key={image.id}
              image={image}
              pending={pendingIds.has(image.id)}
              onRemove={() => void remove(image)}
            />
          ))}
        </ul>
      )}

      <CleanupImagesDialog
        open={cleanupOpen}
        images={unused}
        onOpenChange={setCleanupOpen}
        onDone={() => void refresh()}
      />
    </div>
  );
}
