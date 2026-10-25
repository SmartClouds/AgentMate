import type { RenderJobView } from '@agentmat/studio';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { studioClient } from './client';
import { studioKeys } from './queryKeys';

/** Keeps Studio's lists fresh when the service reports a change (another window, an AI edit). */
export function useStudioEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return studioClient().onEvent((event) => {
      if (event.type === 'library-changed') {
        void queryClient.invalidateQueries({ queryKey: studioKeys.videos });
      } else if (event.type === 'video-changed') {
        void queryClient.invalidateQueries({ queryKey: studioKeys.history(event.videoId) });
      } else if (event.type === 'generation-changed') {
        void queryClient.invalidateQueries({ queryKey: studioKeys.generations(event.videoId) });
      } else if (event.type === 'render-changed') {
        void queryClient.invalidateQueries({ queryKey: studioKeys.renders });
      } else if (event.type === 'render-progress') {
        // Progress comes a few times a second: patched into the lists instead of refetching them.
        queryClient.setQueriesData<RenderJobView[]>({ queryKey: studioKeys.renders }, (jobs) =>
          jobs?.map((job) =>
            job.id === event.jobId
              ? { ...job, phase: event.phase, done: event.done, total: event.total }
              : job,
          ),
        );
      }
      // Output lines are for the run's own progress card, which listens for them itself.
    });
  }, [queryClient]);
}
