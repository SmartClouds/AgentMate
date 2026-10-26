import type { VideoSummary } from '@runova/studio';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { studioClient } from '../client';
import { NewVideoDialog } from '../home/NewVideoDialog';
import { VideoGrid } from '../home/VideoGrid';
import { Button, Plus, SECTION_HEADING } from '../kit';
import { studioKeys } from '../queryKeys';
import { ProjectStorageCard } from '../storage/ProjectStorageCard';
import { useStudioEvents } from '../useStudioEvents';
import { SceneNetworkCard } from './SceneNetworkCard';

export interface ProjectStudioSectionProps {
  projectId: string;
  onOpen: (video: VideoSummary) => void;
}

/** A project's Studio tab: its videos and the folder they are kept in. */
export function ProjectStudioSection({
  projectId,
  onOpen,
}: ProjectStudioSectionProps): React.JSX.Element {
  useStudioEvents();
  const [creating, setCreating] = useState(false);
  const videos = useQuery({
    queryKey: studioKeys.videoList(projectId),
    queryFn: () => studioClient().list({ projectId }),
  });

  return (
    <div className="space-y-2">
      <ProjectStorageCard projectId={projectId} />
      <SceneNetworkCard projectId={projectId} />
      <div className="flex items-center gap-2 px-1 pt-1">
        <h3 className={SECTION_HEADING}>Videos</h3>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> New video
        </Button>
      </div>
      <VideoGrid
        videos={videos.data}
        loading={videos.isLoading}
        error={videos.error}
        onRetry={() => void videos.refetch()}
        onOpen={onOpen}
        emptyDescription="Make a video for this project: a launch teaser, a feature walkthrough or a short for social media."
        emptyAction={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New video
          </Button>
        }
      />
      <NewVideoDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        onCreated={onOpen}
      />
    </div>
  );
}
