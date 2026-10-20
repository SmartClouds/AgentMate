import { describe, expect, it } from 'vitest';
import { isValidEntryName, nextFreeName } from './sftpNames';

/**
 * Names in the SFTP file manager (E25): "Keep both" picks the next free `name (N).ext`, and a
 * name typed for a new folder or a rename must be one entry, never a path.
 */

describe('nextFreeName', () => {
  it('counts up before the extension, the way file managers do', () => {
    const taken = new Set(['report.pdf']);
    expect(nextFreeName('report.pdf', taken)).toBe('report (1).pdf');
    taken.add('report (1).pdf');
    expect(nextFreeName('report.pdf', taken)).toBe('report (2).pdf');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(nextFreeName('.env', new Set(['.env']))).toBe('.env (1)');
    expect(nextFreeName('.config.json', new Set(['.config.json']))).toBe('.config (1).json');
  });

  it('adds the number at the end of a name with no extension', () => {
    expect(nextFreeName('Makefile', new Set(['Makefile']))).toBe('Makefile (1)');
    expect(nextFreeName('notes.', new Set(['notes.']))).toBe('notes. (1)');
  });

  it('keeps a .tar compound extension together and splits other names at the last dot', () => {
    expect(nextFreeName('a.tar.gz', new Set(['a.tar.gz']))).toBe('a (1).tar.gz');
    expect(nextFreeName('site.v2.tar.zst', new Set(['site.v2.tar.zst']))).toBe(
      'site.v2 (1).tar.zst',
    );
    expect(nextFreeName('photo.2024.jpg', new Set(['photo.2024.jpg']))).toBe('photo.2024 (1).jpg');
  });

  it('carries on from a number the name already has', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf']);
    expect(nextFreeName('report (1).pdf', taken)).toBe('report (2).pdf');
  });

  it('gives the name back as it is when nothing has it yet', () => {
    expect(nextFreeName('fresh.txt', new Set(['other.txt']))).toBe('fresh.txt');
  });

  it('takes a predicate, for a case-insensitive folder or a lookup that is not a set', () => {
    const lower = new Set(['readme.md', 'readme (1).md']);
    expect(nextFreeName('README.md', (candidate) => lower.has(candidate.toLowerCase()))).toBe(
      'README (2).md',
    );
  });

  it('gives up rather than looping forever when every name is taken', () => {
    expect(() => nextFreeName('a.txt', () => true)).toThrow(/free name/);
  });
});

describe('isValidEntryName', () => {
  it('rejects names that are empty, special or a path', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'nul\0byte', '/', 'x/']) {
      expect(isValidEntryName(name)).toBe(false);
    }
  });

  it('rejects a name longer than a file system allows (255 bytes of UTF-8)', () => {
    expect(isValidEntryName('a'.repeat(255))).toBe(true);
    expect(isValidEntryName('a'.repeat(256))).toBe(false);
    // 128 two-byte letters are 256 bytes.
    expect(isValidEntryName('é'.repeat(128))).toBe(false);
  });

  it('accepts ordinary names, dot files and unicode', () => {
    for (const name of ['index.html', '.htaccess', '...', 'my file (1).txt', 'گزارش.pdf', '日本']) {
      expect(isValidEntryName(name)).toBe(true);
    }
  });
});
