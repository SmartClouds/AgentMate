import { MEDIA_VARIANTS, type MediaVariant } from '../api.js';

/**
 * The address of an imported file or one of its preview files, for the editor:
 * `studio-media://m/<videoId>/<hash>/<variant>`. The page names a video, a file and what of it;
 * the main process looks the file up itself, so no path ever comes from the page.
 */

export const MEDIA_SCHEME = 'studio-media';

export function mediaUrl(videoId: string, hash: string, variant: MediaVariant): string {
  return `${MEDIA_SCHEME}://m/${encodeURIComponent(videoId)}/${hash}/${variant}`;
}

export interface MediaAddress {
  videoId: string;
  hash: string;
  variant: MediaVariant;
}

/** Reads a media address back, or null for anything else. */
export function parseMediaUrl(url: string): MediaAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.host !== 'm') return null;
  const [, rawVideo, hash, variant] = parsed.pathname.split('/');
  if (!rawVideo || !hash || !variant) return null;
  let videoId: string;
  try {
    videoId = decodeURIComponent(rawVideo);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(videoId) || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!(MEDIA_VARIANTS as readonly string[]).includes(variant)) return null;
  return { videoId, hash, variant: variant as MediaVariant };
}

/** The content type a preview file is served with; an original keeps what its file says. */
export function mediaContentType(variant: MediaVariant): string | null {
  switch (variant) {
    case 'proxy':
      return 'video/mp4';
    case 'poster':
    case 'sprite':
      return 'image/jpeg';
    case 'peaks':
      return 'application/json';
    default:
      return null;
  }
}
