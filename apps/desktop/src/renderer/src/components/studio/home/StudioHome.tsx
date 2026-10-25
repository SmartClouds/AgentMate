import type { VideoSummary } from '@agentmat/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { listProjects, studioClient } from '../client';
import { errorMessage } from '../format';
import {
  appQueryKeys,
  Button,
  Combobox,
  FolderPlus,
  Plus,
  SEGMENT_TRACK,
  segmentClass,
  TOOLBAR,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { NewVideoDialog } from './NewVideoDialog';
import { VideoGrid } from './VideoGrid';

type Filter = 'all' | 'standalone' | 'project';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All videos' },
  { value: 'standalone', label: 'Standalone' },
  { value: 'project', label: 'By project' },
];

/** Studio's library: every video, standalone or made for a project. */
export function StudioHome({
  onOpen,
}: {
  onOpen: (video: VideoSummary) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [projectId, setProjectId] = useState('');
  const [creating, setCreating] = useState(false);

  const projects = useQuery({ queryKey: appQueryKeys.projects, queryFn: listProjects });
  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name] as const)),
    [projects.data],
  );
  const listFilter =
    filter === 'standalone' ? null : filter === 'project' ? projectId || undefined : undefined;
  const videos = useQuery({
    queryKey: studioKeys.videoList(listFilter),
    queryFn: () =>
      studioClient().list(listFilter === undefined ? undefined : { projectId: listFilter }),
  });

  async function addExisting() {
    const folder = await studioClient().pickFolder();
    if (!folder) return;
    try {
      const video = await studioClient().addExisting(folder);
      await queryClient.invalidateQueries({ queryKey: studioKeys.videos });
      toast.success(`Added "${video.title}" to the library.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className={TOOLBAR}>
        <div className={SEGMENT_TRACK} role="radiogroup" aria-label="Show">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={filter === option.value}
              className={segmentClass(filter === option.value)}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {filter === 'project' && (
          <Combobox
            ariaLabel="Project"
            className="w-56"
            placeholder="Choose a project"
            options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={projectId}
            onChange={setProjectId}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => void addExisting()}>
            <FolderPlus /> Add existing folder
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus /> New video
          </Button>
        </div>
      </div>
      <VideoGrid
        videos={videos.data}
        loading={videos.isLoading}
        error={videos.error}
        onRetry={() => void videos.refetch()}
        onOpen={onOpen}
        projectNames={projectNames}
        emptyAction={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New video
          </Button>
        }
      />
      <NewVideoDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={filter === 'project' && projectId ? projectId : null}
        onCreated={onOpen}
      />
    </div>
  );
}
