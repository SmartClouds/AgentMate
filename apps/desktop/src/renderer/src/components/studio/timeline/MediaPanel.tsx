import {
  type Aspect,
  FLICKS_PER_SECOND,
  type ImportResult,
  type MediaView,
  mediaUrl,
} from '@agentmat/studio';
import { useState } from 'react';
import { pathForFile, studioMediaClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  cn,
  FolderPlus,
  GLASS_CARD,
  ImageIcon,
  Plus,
  SimpleTooltip,
  Skeleton,
  Sparkles,
  TriangleAlert,
  toast,
  Video,
} from '../kit';
import { GenerateDialog } from './GenerateDialog';
import { TIMELINE_MEDIA } from './Timeline';

/**
 * The video's imported files: import by button or by dropping files here, then drag one onto a
 * track or add it at the playhead. Each file is copied into the video, so the video keeps working
 * when the original moves.
 */

export interface MediaPanelProps {
  videoId: string;
  media: MediaView[] | undefined;
  loading: boolean;
  onAdd: (file: MediaView) => void;
  /** The video's shape, for generated pictures and clips. */
  aspect: Aspect;
}

const KIND_LABEL: Record<MediaView['kind'], string> = {
  video: 'Video',
  audio: 'Sound',
  image: 'Picture',
};

function length(file: MediaView): string {
  if (file.duration === null) return KIND_LABEL[file.kind];
  const s = Math.round(file.duration / FLICKS_PER_SECOND);
  return `${KIND_LABEL[file.kind]}, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Tells the user what an import did. */
export function reportImport(result: ImportResult | null): void {
  if (!result) return;
  if (result.imported.length > 0) {
    toast.success(
      result.imported.length === 1
        ? `Imported ${result.imported[0]?.name}.`
        : `Imported ${result.imported.length} files.`,
    );
  }
  for (const skipped of result.skipped) {
    const name = skipped.path.split(/[\\/]/).pop() ?? skipped.path;
    toast.error(`${name} was not imported: ${skipped.reason}`);
  }
}

export function MediaPanel({
  videoId,
  media,
  loading,
  onAdd,
  aspect,
}: MediaPanelProps): React.JSX.Element {
  const [over, setOver] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const run = async (task: () => Promise<ImportResult | null>) => {
    setImporting(true);
    try {
      reportImport(await task());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };
  return (
    <section
      aria-label="Media"
      className={cn(GLASS_CARD, 'flex min-h-0 flex-col gap-2 p-2', over && 'ring-2 ring-primary')}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const paths = [...event.dataTransfer.files].map(pathForFile).filter(Boolean);
        if (paths.length === 0) return;
        event.preventDefault();
        void run(() => studioMediaClient().importFiles(videoId, paths));
      }}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Media</h3>
        <Button
          size="xs"
          variant="soft"
          className="ml-auto"
          disabled={importing}
          onClick={() => void run(() => studioMediaClient().pickAndImport(videoId))}
        >
          <FolderPlus /> {importing ? 'Importing...' : 'Import'}
        </Button>
        <Button size="xs" variant="soft" onClick={() => setGenerating(true)}>
          <Sparkles /> Generate
        </Button>
      </div>
      {/* Mounted only while open: the timeline redraws this panel as it scrolls. */}
      {generating && (
        <GenerateDialog videoId={videoId} open onOpenChange={setGenerating} aspect={aspect} />
      )}
      {loading ? (
        <div className="space-y-1.5" aria-busy="true" aria-label="Loading media">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (media?.length ?? 0) === 0 ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">
          Import video, sound or pictures, or drop files here. Then drag one onto a track.
        </p>
      ) : (
        <ul className="min-h-0 space-y-1 overflow-y-auto">
          {media?.map((file) => (
            <li
              key={file.hash}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(TIMELINE_MEDIA, file.hash);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              className="flex cursor-grab items-center gap-2 rounded-md bg-foreground/[0.03] p-1.5"
              aria-label={file.name}
            >
              <div className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded bg-black/60 text-white/70">
                {file.ready.poster ? (
                  <img
                    alt=""
                    src={mediaUrl(videoId, file.hash, 'poster')}
                    className="h-full w-full object-cover"
                  />
                ) : file.kind === 'image' ? (
                  <ImageIcon className="h-4 w-4" />
                ) : (
                  <Video className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium" dir="auto">
                  {file.name}
                </p>
                <p className="text-[11px] text-muted-foreground">{length(file)}</p>
              </div>
              {file.preparing && <Chip tone="neutral">Preparing</Chip>}
              {file.problem && (
                <SimpleTooltip label={file.problem}>
                  <span className="text-warning" role="img" aria-label="Preview problem">
                    <TriangleAlert className="h-3.5 w-3.5" />
                  </span>
                </SimpleTooltip>
              )}
              <SimpleTooltip label="Add at the playhead">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Add ${file.name} at the playhead`}
                  onClick={() => onAdd(file)}
                >
                  <Plus />
                </Button>
              </SimpleTooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
