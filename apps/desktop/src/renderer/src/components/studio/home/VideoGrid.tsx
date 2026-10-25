import type { VideoSummary } from '@agentmat/studio';
import { errorMessage } from '../format';
import { CARD_GRID, CatalogCardShimmer, Clapperboard, EmptyState, LoadFailure } from '../kit';
import { VideoCard } from './VideoCard';

export interface VideoGridProps {
  videos: VideoSummary[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (video: VideoSummary) => void;
  /** Project names by id, for the chip on each card; leave out to hide the chip. */
  projectNames?: Map<string, string>;
  /** What the empty state offers, usually a New video button. */
  emptyAction?: React.ReactNode;
  emptyDescription?: string;
}

/** The library's cards, with a shimmer per card while loading. */
export function VideoGrid({
  videos,
  loading,
  error,
  onRetry,
  onOpen,
  projectNames,
  emptyAction,
  emptyDescription = 'Make your first one: write a brief, get a scenario, and edit it into a video.',
}: VideoGridProps): React.JSX.Element {
  if (error)
    return (
      <LoadFailure message={`Your videos did not load. ${errorMessage(error)}`} retry={onRetry} />
    );
  if (loading || !videos) {
    return (
      <div className="@container/grid">
        <div className={CARD_GRID} aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 6 }, (_, i) => (
            <CatalogCardShimmer key={i} />
          ))}
        </div>
      </div>
    );
  }
  if (videos.length === 0) {
    return (
      <EmptyState
        card
        icon={Clapperboard}
        title="No videos yet"
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }
  return (
    <div className="@container/grid">
      <div className={CARD_GRID}>
        {videos.map((video) => (
          <VideoCard
            key={video.id}
            video={video}
            onOpen={onOpen}
            projectName={
              projectNames
                ? video.linkedProjectId
                  ? (projectNames.get(video.linkedProjectId) ?? null)
                  : null
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
