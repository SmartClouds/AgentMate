import { describe, expect, it } from 'vitest';
import { newId, safeFolderName, videoFolderName } from './names.js';

describe('newId', () => {
  it('makes short ids that are safe in a file name and unique enough', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{16}$/);
  });
});

describe('videoFolderName', () => {
  it('names a folder after the title and the id', () => {
    expect(videoFolderName('Launch film', 'abcdef1234567890')).toBe('Launch-film-abcdef12');
  });

  it('keeps Persian titles readable', () => {
    expect(videoFolderName('معرفی محصول', 'abcdef1234567890')).toBe('معرفی-محصول-abcdef12');
  });

  it('removes characters Windows does not allow in a name', () => {
    expect(videoFolderName('a<b>c:d"e/f\g|h?i*j', 'abcdef1234567890')).toBe('abcdefghij-abcdef12');
    expect(videoFolderName('tab\there\u0001', 'abcdef1234567890')).toBe('tab-here-abcdef12');
  });

  it('trims dots and spaces Windows would drop from the end', () => {
    expect(videoFolderName('  ...My video...  ', 'abcdef1234567890')).toBe('My-video-abcdef12');
  });

  it('falls back to "video" when nothing usable is left', () => {
    expect(videoFolderName('???', 'abcdef1234567890')).toBe('video-abcdef12');
    expect(videoFolderName('', 'abcdef1234567890')).toBe('video-abcdef12');
  });

  it('avoids the names Windows reserves for devices', () => {
    expect(videoFolderName('CON', 'abcdef1234567890')).toBe('CON_-abcdef12');
    expect(videoFolderName('lpt1', 'abcdef1234567890')).toBe('lpt1_-abcdef12');
  });

  it('keeps long titles to a short name without cutting a character in half', () => {
    const name = videoFolderName('😀'.repeat(60), 'abcdef1234567890');
    expect([...name.split('-')[0]!]).toHaveLength(40);
  });
});

describe('safeFolderName', () => {
  it('uses the fallback when nothing usable is left', () => {
    expect(safeFolderName('My App', 'project')).toBe('My-App');
    expect(safeFolderName('***', 'project')).toBe('project');
  });

  it('never lets a backslash or a slash make a subfolder', () => {
    expect(safeFolderName('a' + String.fromCharCode(92) + 'b/c', 'video')).toBe('abc');
    expect(safeFolderName('..' + String.fromCharCode(92) + '..', 'video')).toBe('video');
  });
});
