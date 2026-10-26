import type { Project } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatImageSize, type ImageSize, ImageView } from '@/components/editor/ImageView';
import { ExternalLink, FileText, ImageIcon, RefreshCw } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { WorkspaceFileTab } from '@/stores/workspaceStore';

/** An image file opened from the explorer or the changes panel, shown instead of its bytes. */
export function ImageFileTab({
  project,
  tab,
  onEditSource,
}: {
  project: Project;
  tab: WorkspaceFileTab;
  /** Set for an SVG, whose source is worth editing by hand. */
  onEditSource?: () => void;
}): React.JSX.Element {
  const image = useQuery({
    queryKey: queryKeys.workspaceImage(tab.path),
    queryFn: () => window.runova.fs.readImage(tab.path),
    meta: { silentLoading: true },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [size, setSize] = useState<ImageSize | null>(null);

  const relative = tab.path.startsWith(project.folderPath)
    ? tab.path.slice(project.folderPath.length).replace(/^[\\/]/, '')
    : tab.path;
  const parts = relative.split(/[\\/]/);
  const name = parts.pop() ?? relative;
  const dir = parts.join('/');
  const caption = [formatImageSize(size), image.data ? formatBytes(image.data.bytes) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-[3rem] shrink truncate text-xs font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground [direction:rtl]">
            <bdi>{dir}</bdi>
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {caption ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{caption}</span>
        ) : null}
        {onEditSource ? (
          <SimpleTooltip label="Edit the source">
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label="Edit the source"
              onClick={onEditSource}
            >
              <FileText />
            </Button>
          </SimpleTooltip>
        ) : null}
        <SimpleTooltip label="Reload from disk">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Reload from disk"
            onClick={() => {
              setSize(null);
              void image.refetch();
            }}
          >
            <RefreshCw className={cn('h-2.5 w-2.5', image.isFetching && 'animate-spin')} />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Open in its default app">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open in its default app"
            onClick={() => void window.runova.shell.openPath(tab.path)}
          >
            <ExternalLink />
          </Button>
        </SimpleTooltip>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {image.isPending ? (
          <div className="flex h-full items-center justify-center p-6">
            <Skeleton className="h-full w-full max-w-2xl rounded-xl" />
          </div>
        ) : image.isError ? (
          <EmptyState
            size="sm"
            icon={ImageIcon}
            title="This image could not be opened"
            description={
              image.error instanceof Error
                ? image.error.message
                : 'It may have been moved or deleted.'
            }
            className="h-full"
          />
        ) : (
          <ImageView src={image.data.dataUrl} alt={name} onSize={setSize} />
        )}
      </div>
    </div>
  );
}
