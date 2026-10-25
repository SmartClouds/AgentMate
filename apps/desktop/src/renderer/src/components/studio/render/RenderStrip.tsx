import { useQuery } from '@tanstack/react-query';
import { studioRenderClient } from '../client';
import { Button, cn, GLASS_CARD } from '../kit';
import { studioKeys } from '../queryKeys';
import { RenderProgress } from './RenderJobRow';
import { isActive } from './renderLabels';

/**
 * The editor's line about a render of this video that is waiting or under way, so its progress
 * stays in sight while the user keeps editing. The full list is in the render dialog.
 */
export function RenderStrip({
  videoId,
  onOpen,
}: {
  videoId: string;
  onOpen: () => void;
}): React.JSX.Element | null {
  const jobs = useQuery({
    queryKey: studioKeys.renderList(videoId),
    queryFn: () => studioRenderClient().jobs(videoId),
  });
  const active = (jobs.data ?? []).filter(isActive);
  // The oldest one runs first, so it is the one worth showing.
  const current = active.at(-1);
  if (!current) return null;
  return (
    <section
      aria-label="Render under way"
      className={cn(GLASS_CARD, 'flex items-center gap-3 px-3 py-2')}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" dir="auto">
          {current.fileName}
          {active.length > 1 && (
            <span className="font-normal text-muted-foreground">
              , and {active.length - 1} more waiting
            </span>
          )}
        </p>
        <RenderProgress job={current} />
      </div>
      <Button size="sm" variant="soft" onClick={onOpen}>
        Renders
      </Button>
    </section>
  );
}
