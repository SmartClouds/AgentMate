import type { VideoSummary } from '@agentmat/studio';
import { useQueryClient } from '@tanstack/react-query';
import { studioClient } from '../client';
import { errorMessage, formatWhen } from '../format';
import {
  Button,
  Chip,
  Clapperboard,
  cn,
  confirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisVertical,
  FolderOpen,
  GLASS_CARD,
  Notice,
  persianTextProps,
  SimpleTooltip,
  Trash2,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';

export interface VideoCardProps {
  video: VideoSummary;
  /** The linked project's name, when the card should say which project it belongs to. */
  projectName?: string | null;
  onOpen: (video: VideoSummary) => void;
}

/** One video in the library: open it, find its folder, move it, or take it off the list. */
export function VideoCard({ video, projectName, onOpen }: VideoCardProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: studioKeys.videos });
  const titleProps = persianTextProps(video.title);

  async function locate() {
    const folder = await studioClient().pickFolder();
    if (!folder) return;
    try {
      await studioClient().locate(video.id, folder);
      toast.success('Found it. The video opens from its new place.');
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function move() {
    const toRoot = await studioClient().pickFolder();
    if (!toRoot) return;
    try {
      const result = await studioClient().move(video.id, toRoot);
      await refresh();
      const removeOld = await confirmDialog({
        title: 'Video moved',
        description: `It now lives in ${result.video.folder}. The old copy is still in ${result.oldFolder}.`,
        confirmLabel: 'Move old copy to the trash',
        cancelLabel: 'Keep it',
        variant: 'destructive',
      });
      if (removeOld) await studioClient().trashOldFolder(result.oldFolder);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove "${video.title}" from Studio?`,
      description:
        'Its folder and files stay where they are. You can add it back with Add existing folder.',
      confirmLabel: 'Remove from library',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await studioClient().removeFromLibrary(video.id);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <article className={cn(GLASS_CARD, 'flex flex-col gap-3 p-3')} aria-label={video.title}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Clapperboard className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            disabled={video.missing}
            onClick={() => onOpen(video)}
            className="block max-w-full cursor-pointer truncate text-left text-sm font-semibold hover:underline disabled:cursor-default disabled:no-underline"
          >
            <span dir={titleProps.dir} className={titleProps.className}>
              {video.title}
            </span>
          </button>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {video.lastOpenedAt
              ? `Opened ${formatWhen(video.lastOpenedAt)}`
              : `Created ${formatWhen(video.createdAt)}`}
          </p>
        </div>
        <DropdownMenu>
          <SimpleTooltip label="More">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${video.title}`}>
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </SimpleTooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={video.missing}
              onSelect={() => void studioClient().revealVideo(video.id)}
            >
              <FolderOpen /> Open folder
            </DropdownMenuItem>
            <DropdownMenuItem disabled={video.missing} onSelect={() => void move()}>
              <FolderOpen /> Move to another folder...
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void remove()}>
              <Trash2 /> Remove from library
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {projectName !== undefined && (
          <Chip tone={video.linkedProjectId ? 'primary' : 'neutral'}>
            {video.linkedProjectId ? (projectName ?? 'Removed project') : 'Standalone'}
          </Chip>
        )}
      </div>
      {video.missing && (
        <Notice
          tone="warning"
          size="sm"
          action={
            <Button size="xs" variant="outline" onClick={() => void locate()}>
              Locate
            </Button>
          }
        >
          The folder is gone. It may have been moved or renamed.
        </Notice>
      )}
    </article>
  );
}
