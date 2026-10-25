import { describe, expect, it } from 'vitest';
import { mediaContentType, mediaUrl, parseMediaUrl } from './url.js';

const HASH = 'a'.repeat(64);

describe('media addresses', () => {
  it('round-trips a video, a file and a variant', () => {
    const url = mediaUrl('v1', HASH, 'proxy');
    expect(url).toBe(`studio-media://m/v1/${HASH}/proxy`);
    expect(parseMediaUrl(url)).toEqual({ videoId: 'v1', hash: HASH, variant: 'proxy' });
  });

  it('refuses anything that is not exactly a media address', () => {
    for (const url of [
      'not a url',
      `studio-scene://m/v1/${HASH}/proxy`,
      `studio-media://x/v1/${HASH}/proxy`,
      `studio-media://m/v1/${HASH}`,
      `studio-media://m/v1/${HASH}/secret`,
      'studio-media://m/v1/../../etc/proxy',
      `studio-media://m/${'x'.repeat(65)}/${HASH}/proxy`,
      `studio-media://m/%E0%A4%A/${HASH}/proxy`,
      `studio-media://m/v1/${HASH.toUpperCase()}/proxy`,
    ]) {
      expect(parseMediaUrl(url), url).toBeNull();
    }
  });

  it('names the content type of each preview file', () => {
    expect(mediaContentType('proxy')).toBe('video/mp4');
    expect(mediaContentType('poster')).toBe('image/jpeg');
    expect(mediaContentType('sprite')).toBe('image/jpeg');
    expect(mediaContentType('peaks')).toBe('application/json');
    expect(mediaContentType('original')).toBeNull();
  });
});
