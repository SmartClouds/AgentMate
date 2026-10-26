import { describe, expect, it } from 'vitest';
import {
  baseName,
  folderChain,
  joinRemote,
  normalizeRemote,
  parentOf,
  partPathFor,
} from './remotePath';
import { PART_FILE } from './types';

describe('remote paths', () => {
  it('normalizes trailing and doubled slashes but keeps the root', () => {
    expect(normalizeRemote('/srv//site/')).toBe('/srv/site');
    expect(normalizeRemote('/')).toBe('/');
    expect(joinRemote('/srv/site', 'css', '../js/a.js')).toBe('/srv/site/js/a.js');
  });

  it('finds the parent and the name', () => {
    expect(parentOf('/srv/site/a.css')).toBe('/srv/site');
    expect(parentOf('/srv')).toBe('/');
    expect(parentOf('/')).toBeNull();
    expect(baseName('/srv/site/my file.txt')).toBe('my file.txt');
  });

  it('lists every folder from the top down', () => {
    expect(folderChain('/srv/site/css')).toEqual(['/srv', '/srv/site', '/srv/site/css']);
    expect(folderChain('/')).toEqual([]);
  });

  it('names a part file next to the target, without a leading dot', () => {
    expect(partPathFor('/srv/a.css', 'deadbeef')).toBe('/srv/a.css.runova-deadbeef.part');
    const random = partPathFor('/srv/a.css');
    expect(random).toMatch(PART_FILE);
    expect(baseName(random).startsWith('.')).toBe(false);
  });
});
