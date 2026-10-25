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
      } else {
        void queryClient.invalidateQueries({ queryKey: studioKeys.history(event.videoId) });
      }
    });
  }, [queryClient]);
}
