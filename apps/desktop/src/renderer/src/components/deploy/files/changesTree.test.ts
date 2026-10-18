import { describe, expect, it } from 'vitest';
import {
  filterCounts,
  filterFiles,
  folderOf,
  groupByFolder,
  limitGroups,
  selectionState,
} from './changesTree';
import { pending, snapshot } from './testing/fixtures';

/** The pending changes as the list shows them: filtered, searched, grouped by folder, capped. */

const FILES = [
  pending('index.html', 'modified'),
  pending('css/site.css', 'added'),
  pending('css/print.css', 'deleted'),
  pending('img/logo.png', 'added'),
];

describe('folderOf', () => {
  it('takes the folder part of a path, and empty for the top folder', () => {
    expect(folderOf('css/vendor/a.css')).toBe('css/vendor');
    expect(folderOf('index.html')).toBe('');
  });
});

describe('filterCounts and filterFiles', () => {
  it('counts each kind of change and the left-out files', () => {
    const counts = filterCounts(
      snapshot({ files: FILES, leftOut: [{ path: '.env', reason: 'hardDenied' }] }),
    );
    expect(counts).toEqual({ all: 4, added: 2, modified: 1, deleted: 1, leftOut: 1 });
  });

  it('filters by kind and by a search that ignores case', () => {
    expect(filterFiles(FILES, 'added', '').map((file) => file.path)).toEqual([
      'css/site.css',
      'img/logo.png',
    ]);
    expect(filterFiles(FILES, 'all', 'CSS').map((file) => file.path)).toEqual([
      'css/site.css',
      'css/print.css',
    ]);
    expect(filterFiles(FILES, 'deleted', ' print ').map((file) => file.path)).toEqual([
      'css/print.css',
    ]);
    expect(filterFiles(FILES, 'leftOut', '')).toEqual([]);
  });
});

describe('groupByFolder and limitGroups', () => {
  it('groups by folder with the top folder first and the rest sorted', () => {
    const groups = groupByFolder([
      pending('z/a'),
      pending('top.txt'),
      pending('a/b'),
      pending('a/c'),
    ]);
    expect(groups.map((group) => [group.folder, group.files.length])).toEqual([
      ['', 1],
      ['a', 2],
      ['z', 1],
    ]);
  });

  it('caps the rows shown and says how many wait', () => {
    const groups = groupByFolder(FILES);
    const limited = limitGroups(groups, 2);
    expect(limited.hidden).toBe(2);
    expect(limited.groups.flatMap((group) => group.files.map((file) => file.path))).toEqual([
      'index.html',
      'css/site.css',
    ]);
    expect(limitGroups(groups, 10).hidden).toBe(0);
  });
});

describe('selectionState', () => {
  it('says whether all, none or some of a set of files are ticked', () => {
    const files = FILES.slice(0, 2);
    expect(selectionState(files, new Set())).toBe(true);
    expect(selectionState(files, new Set(['index.html', 'css/site.css']))).toBe(false);
    expect(selectionState(files, new Set(['index.html']))).toBe('indeterminate');
    expect(selectionState([], new Set())).toBe(false);
  });
});
