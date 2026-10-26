import { useEffect, useState } from 'react';
import { ExternalLink, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { closeImageViewer, useImageViewerStore } from '@/stores/imageViewerStore';

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

/**
 * Full-size view of an image file, opened from a terminal's image preview. It starts fitted to
 * the window; when that had to shrink it, clicking the image switches to actual pixels
 * (scrollable) and back. Mount once near the app root.
 */
export function ImageViewerHost(): React.JSX.Element {
  const path = useImageViewerStore((state) => state.path);
  /** Undefined while loading, null when the file can't be shown. */
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  /** Whether fitting to the window had to shrink the image, i.e. there is a bigger view to zoom to. */
  const [shrunk, setShrunk] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setUrl(undefined);
    setSize(null);
    setActualSize(false);
    setShrunk(false);
    void window.runova.terminalClipboard
      .previewImage(path, true)
      .catch(() => null)
      .then((next) => {
        if (!cancelled) setUrl(next);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && closeImageViewer()}>
      {/* Centered with margins rather than the usual left-50% offset, which would cap how wide
          the dialog can grow to half the window and crop the image. */}
      <DialogContent
        // Focus the dialog itself rather than its first button, which would open showing a
        // focus ring on "Open in default app". Escape and Tab still work from there.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="inset-0 m-auto h-fit w-fit min-w-80 max-w-[calc(100vw-4rem)] max-h-[calc(100vh-4rem)] translate-x-0 translate-y-0 gap-3 p-3"
      >
        <DialogHeader className="flex-row items-center gap-3 pr-10">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
            <DialogTitle className="truncate text-sm">{path ? fileName(path) : ''}</DialogTitle>
            <DialogDescription className="text-xs">
              {size ? `${size.width} × ${size.height}` : ' '}
            </DialogDescription>
          </div>
          {path && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.runova.shell.openPath(path)}
            >
              <ExternalLink />
              Open in default app
            </Button>
          )}
        </DialogHeader>
        <div className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-6rem)] overflow-auto rounded-lg">
          {url === undefined && (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <Spinner className="h-5 w-5 animate-spin" />
            </div>
          )}
          {url === null && (
            <div className="flex h-48 items-center justify-center px-6 text-sm text-muted-foreground">
              This image is no longer available.
            </div>
          )}
          {url && (
            <img
              src={url}
              alt={path ? fileName(path) : ''}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight, clientWidth, clientHeight } =
                  event.currentTarget;
                setSize({ width: naturalWidth, height: naturalHeight });
                setShrunk(naturalWidth > clientWidth || naturalHeight > clientHeight);
              }}
              onClick={() => shrunk && setActualSize((value) => !value)}
              className={cn(
                'block',
                actualSize
                  ? 'max-w-none cursor-zoom-out'
                  : 'max-h-[calc(100vh-10rem)] max-w-[calc(100vw-6rem)] object-contain',
                shrunk && !actualSize && 'cursor-zoom-in',
              )}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
