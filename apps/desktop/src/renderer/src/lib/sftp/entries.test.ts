import type { SftpLocalEntry, SftpRemoteEntry } from '@shared/sftpTypes';
import { describe, expect, it } from 'vitest';
import {
  entryModeKind,
  formatFullDate,
  formatShortDate,
  isHiddenEntry,
  type PaneEntry,
  selectionSummary,
  sortEntries,
  visibleEntries,
} from './entries';

function remote(name: string, extra: Partial<SftpRemoteEntry> = {}): SftpRemoteEntry {
  const isDirectory = extra.isDirectory ?? extra.kind === 'dir';
  return {
    name,
    path: `/srv/${name}`,
    kind: isDirectory ? 'dir' : 'file',
    isDirectory,
    isSymlink: false,
    size: 0,
    mtimeMs: 0,
    mode: isDirectory ? 0o755 : 0o644,
    owner: 'www',
    group: 'www',
    ...extra,
  };
}

function local(name: string, extra: Partial<SftpLocalEntry> = {}): SftpLocalEntry {
  return {
    name,
    path: `C:\\work\\${name}`,
    isDirectory: false,
    isSymlink: false,
    size: 0,
    mtimeMs: 0,
    mode: null,
    hidden: false,
    ...extra,
  };
}

const names = (entries: PaneEntry[]) => entries.map((entry) => entry.name);

describe('sortEntries', () => {
  const entries = [
    remote('file10.txt', { size: 30, mtimeMs: 3 }),
    remote('b-dir', { isDirectory: true, mtimeMs: 9 }),
    remote('file2.txt', { size: 10, mtimeMs: 1 }),
    remote('A-dir', { isDirectory: true, mtimeMs: 1 }),
    remote('File1.txt', { size: 20, mtimeMs: 2 }),
  ];

  it('puts folders first and sorts names in natural order', () => {
    expect(names(sortEntries(entries, { key: 'name', dir: 'asc' }))).toEqual([
      'A-dir',
      'b-dir',
      'File1.txt',
      'file2.txt',
      'file10.txt',
    ]);
  });

  it('keeps folders first when reversed', () => {
    expect(names(sortEntries(entries, { key: 'name', dir: 'desc' }))).toEqual([
      'b-dir',
      'A-dir',
      'file10.txt',
      'file2.txt',
      'File1.txt',
    ]);
  });

  it('sorts by size and by modified time both ways', () => {
    expect(names(sortEntries(entries, { key: 'size', dir: 'asc' })).slice(2)).toEqual([
      'file2.txt',
      'File1.txt',
      'file10.txt',
    ]);
    expect(names(sortEntries(entries, { key: 'size', dir: 'desc' })).slice(2)).toEqual([
      'file10.txt',
      'File1.txt',
      'file2.txt',
    ]);
    expect(names(sortEntries(entries, { key: 'mtime', dir: 'desc' }))).toEqual([
      'b-dir',
      'A-dir',
      'file10.txt',
      'File1.txt',
      'file2.txt',
    ]);
  });

  it('sorts by permissions and owner, falling back to the name', () => {
    const mixed = [
      remote('b', { mode: 0o600, owner: 'root' }),
      remote('a', { mode: 0o644, owner: 'root' }),
      remote('c', { mode: 0o600, owner: 'alice' }),
    ];
    expect(names(sortEntries(mixed, { key: 'mode', dir: 'asc' }))).toEqual(['b', 'c', 'a']);
    expect(names(sortEntries(mixed, { key: 'owner', dir: 'asc' }))).toEqual(['c', 'a', 'b']);
  });

  it('does not change the list it is given', () => {
    const copy = [...entries];
    sortEntries(entries, { key: 'name', dir: 'desc' });
    expect(entries).toEqual(copy);
  });
});

describe('hidden and text filters', () => {
  it('treats dot files on the server and flagged files here as hidden', () => {
    expect(isHiddenEntry(remote('.env'))).toBe(true);
    expect(isHiddenEntry(remote('env'))).toBe(false);
    expect(isHiddenEntry(local('desktop.ini', { hidden: true }))).toBe(true);
    expect(isHiddenEntry(local('.git'))).toBe(false);
  });

  it('hides hidden entries unless asked, and filters by name ignoring case', () => {
    const entries = [remote('.env'), remote('Index.html'), remote('style.css')];
    const sort = { key: 'name', dir: 'asc' } as const;
    expect(names(visibleEntries(entries, { sort, filter: '', showHidden: false }))).toEqual([
      'Index.html',
      'style.css',
    ]);
    expect(names(visibleEntries(entries, { sort, filter: '', showHidden: true }))).toEqual([
      '.env',
      'Index.html',
      'style.css',
    ]);
    expect(names(visibleEntries(entries, { sort, filter: 'INDEX', showHidden: true }))).toEqual([
      'Index.html',
    ]);
    expect(names(visibleEntries(entries, { sort, filter: '  e  ', showHidden: false }))).toEqual([
      'Index.html',
      'style.css',
    ]);
  });
});

describe('selectionSummary', () => {
  const entries = [
    remote('site', { isDirectory: true }),
    remote('a.zip', { size: 10 * 1024 * 1024 }),
    remote('b.txt', { size: 2.4 * 1024 * 1024 }),
  ];

  it('counts the selection and the bytes of its files', () => {
    expect(selectionSummary(entries, new Set(['site', 'a.zip', 'b.txt']))).toBe(
      '3 of 3 selected, 12.4 MB',
    );
    expect(selectionSummary(entries, new Set(['site']))).toBe('1 of 3 selected');
  });

  it('counts the items when nothing is selected', () => {
    expect(selectionSummary(entries, new Set())).toBe('3 items');
    expect(selectionSummary(entries.slice(0, 1), new Set())).toBe('1 item');
  });
});

describe('entryModeKind', () => {
  it('names links l whether they work or not', () => {
    expect(entryModeKind(remote('x', { isSymlink: true, kind: 'dir', isDirectory: true }))).toBe(
      'link',
    );
    expect(entryModeKind(remote('x', { kind: 'link' }))).toBe('link');
    expect(entryModeKind(remote('x', { kind: 'dir', isDirectory: true }))).toBe('dir');
    expect(entryModeKind(remote('x', { kind: 'other' }))).toBe('other');
    expect(entryModeKind(local('x'))).toBe('file');
  });
});

describe('sorting edge cases', () => {
  it('keeps names that differ only in case in a fixed order', () => {
    const order = names(sortEntries([remote('a'), remote('A')], { key: 'name', dir: 'asc' }));
    expect(names(sortEntries([remote('A'), remote('a')], { key: 'name', dir: 'asc' }))).toEqual(
      order,
    );
    expect(order).toEqual(['A', 'a']);
  });

  it('sorts entries without permissions or an owner first', () => {
    const mixed = [local('b', { mode: 0o644 }), local('a'), remote('c', { owner: null })];
    expect(names(sortEntries(mixed, { key: 'mode', dir: 'asc' }))).toEqual(['a', 'b', 'c']);
    expect(
      names(sortEntries([remote('z', { owner: 'root' }), ...mixed], { key: 'owner', dir: 'asc' })),
    ).toEqual(['a', 'b', 'c', 'z']);
  });
});

describe('entryModeKind on this computer', () => {
  it('names a local folder dir', () => {
    expect(entryModeKind(local('photos', { isDirectory: true }))).toBe('dir');
  });
});

describe('the Modified column', () => {
  const now = new Date(2026, 9, 19, 14, 2).getTime();

  it('is blank for no date', () => {
    expect(formatShortDate(0, now)).toBe('');
    expect(formatShortDate(Number.NaN, now)).toBe('');
    expect(formatFullDate(-1)).toBe('');
  });

  it('leaves the year out for this year and shows it for another', () => {
    const thisYear = formatShortDate(new Date(2026, 2, 3, 9, 5).getTime(), now);
    const otherYear = formatShortDate(new Date(2024, 2, 3, 9, 5).getTime(), now);
    expect(thisYear).not.toMatch(/2026/);
    expect(otherYear).toMatch(/2024/);
    expect(formatFullDate(now)).toMatch(/2026/);
  });
});
