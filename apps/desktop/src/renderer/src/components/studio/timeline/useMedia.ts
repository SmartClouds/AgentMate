import { type MediaView, mediaUrl } from '@agentmat/studio';
import { useQuery } from '@tanstack/react-query';
import { studioMediaClient } from '../client';
import { studioKeys } from '../queryKeys';

/** The video's imported files, kept fresh by `media-changed` events. */
export function useMedia(videoId: string) {
  return useQuery({
    queryKey: studioKeys.media(videoId),
    queryFn: () => studioMediaClient().list(videoId),
  });
}

export interface Peaks {
  perSecond: number;
  peaks: number[];
}

/** A file's waveform, once its preview files are made. */
export function usePeaks(videoId: string, media: MediaView | undefined) {
  const hash = media?.hash ?? '';
  return useQuery({
    queryKey: studioKeys.peaks(videoId, hash),
    enabled: !!media?.ready.peaks,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<Peaks> => {
      const response = await fetch(mediaUrl(videoId, hash, 'peaks'));
      if (!response.ok) throw new Error('The waveform is not ready.');
      return (await response.json()) as Peaks;
    },
  });
}
