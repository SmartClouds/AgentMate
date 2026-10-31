import { useEffect, useState } from 'react';
import { X } from '@/components/icons';

export function fileLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

/**
 * A file attached to a message box: a thumbnail for an image, the file's name for anything else,
 * with a button to take it off again.
 */
export function AttachmentChip({
  path,
  onRemove,
}: {
  path: string;
  onRemove: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const label = fileLabel(path);
  useEffect(() => {
    let live = true;
    void window.runova.terminalClipboard
      .previewImage(path, false)
      .then((url) => {
        if (live) setPreview(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <div
      title={path}
      className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-border bg-muted"
    >
      {preview ? (
        <img src={preview} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center break-all p-1 text-center text-[9px] text-muted-foreground">
          {label}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
