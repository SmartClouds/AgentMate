import { describe, expect, it } from 'vitest';
import type { TextSearchFileMatches, TextSearchRequest } from '../../shared/apiTypes';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { ripgrepPath } from './ripgrepPath';
import { cancelTextSearch, runTextSearch } from './textSearch';

/** Runs the real bundled ripgrep against a small project on disk. */

const PLAIN: TextSearchRequest = { query: '', matchCase: false, wholeWord: false, regex: false };

function project(files: Record<string, string>): string {
  return writeTree(tempDir('runova-search-'), files);
}

async function search(
  folder: string,
  request: Partial<TextSearchRequest>,
  options: {
    ownerId?: string;
    requestId?: string;
    limits?: Parameters<typeof runTextSearch>[0]['limits'];
  } = {},
) {
  const batches: TextSearchFileMatches[][] = [];
  const summary = await runTextSearch({
    ownerId: options.ownerId ?? 'window',
    requestId: options.requestId ?? 'r1',
    folder,
    request: { ...PLAIN, ...request },
    onBatch: (files) => batches.push(files),
    limits: options.limits,
  });
  const files = batches.flat();
  const byPath = new Map<string, number[]>();
  for (const file of files) {
    byPath.set(file.path, [...(byPath.get(file.path) ?? []), ...file.matches.map((m) => m.line)]);
  }
  return { summary, batches, files, byPath };
}

describe.skipIf(!ripgrepPath())('runTextSearch', () => {
  it('finds matching lines with paths relative to the project', async () => {
    const folder = project({
      'src/app.ts': 'const a = 1;\nexport function needle() {}\n',
      'README.md': 'no match here\n',
    });
    const { summary, byPath, files } = await search(folder, { query: 'needle' });
    expect(byPath.get('src/app.ts')).toEqual([2]);
    expect(files[0].matches[0]).toMatchObject({
      line: 2,
      column: 17,
      text: 'export function needle() {}',
    });
    expect(summary).toMatchObject({
      requestId: 'r1',
      matches: 1,
      files: 1,
      truncated: false,
      cancelled: false,
    });
  });

  it('respects .gitignore even outside a repository', async () => {
    const folder = project({
      '.gitignore': 'dist/\n',
      'dist/bundle.js': 'needle\n',
      'src/a.ts': 'needle\n',
      'node_modules/pkg/index.js': 'needle\n',
    });
    const { byPath } = await search(folder, { query: 'needle' });
    expect([...byPath.keys()]).toEqual(['src/a.ts']);
  });

  it('applies the case, whole word and pattern options', async () => {
    const folder = project({ 'a.txt': 'Needle\nneedles\nneedle\n' });
    expect((await search(folder, { query: 'needle' })).byPath.get('a.txt')).toEqual([1, 2, 3]);
    expect(
      (await search(folder, { query: 'needle', matchCase: true })).byPath.get('a.txt'),
    ).toEqual([2, 3]);
    expect(
      (await search(folder, { query: 'needle', wholeWord: true })).byPath.get('a.txt'),
    ).toEqual([1, 3]);
    expect((await search(folder, { query: 'need.e$', regex: true })).byPath.get('a.txt')).toEqual([
      1, 3,
    ]);
    // Without the pattern option a dot is only a dot.
    expect((await search(folder, { query: 'need.e' })).files).toEqual([]);
  });

  it('stops at the match cap and says so', async () => {
    const folder = project({ 'a.txt': 'hit\n'.repeat(50) });
    const { summary, files } = await search(
      folder,
      { query: 'hit' },
      { limits: { maxMatches: 10 } },
    );
    expect(summary.truncated).toBe(true);
    expect(files.flatMap((file) => file.matches)).toHaveLength(10);
  });

  it('stops at the file cap', async () => {
    const tree = Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`f${at}.txt`, 'hit\n']));
    const { summary, byPath } = await search(
      project(tree),
      { query: 'hit' },
      { limits: { maxFiles: 5 } },
    );
    expect(summary.truncated).toBe(true);
    expect(byPath.size).toBe(5);
  });

  it('sends results in batches as they come', async () => {
    const tree = Object.fromEntries(
      Array.from({ length: 30 }, (_, at) => [`f${at}.txt`, 'hit\n'.repeat(10)]),
    );
    const { batches, summary } = await search(
      project(tree),
      { query: 'hit' },
      { limits: { flushMatches: 50 } },
    );
    expect(summary.matches).toBe(300);
    expect(batches.length).toBeGreaterThan(1);
  });

  it('explains a pattern that does not parse', async () => {
    const folder = project({ 'a.txt': 'x\n' });
    const { summary } = await search(folder, { query: 'foo(', regex: true });
    expect(summary.error).toMatch(/regular expression/i);
    expect(summary.error).not.toContain('\n');
  });

  it('cancels the previous search when the same window starts another', async () => {
    const tree = Object.fromEntries(
      Array.from({ length: 400 }, (_, at) => [`f${at}.txt`, 'hit\n'.repeat(200)]),
    );
    const folder = project(tree);
    const first = search(
      folder,
      { query: 'hit' },
      { requestId: 'old', limits: { maxMatches: 1_000_000, maxFiles: 10_000 } },
    );
    const second = search(folder, { query: 'zzz' }, { requestId: 'new' });
    const [old, fresh] = await Promise.all([first, second]);
    expect(old.summary.cancelled).toBe(true);
    expect(fresh.summary.cancelled).toBe(false);
  });

  it('can be cancelled by its id', async () => {
    const tree = Object.fromEntries(
      Array.from({ length: 400 }, (_, at) => [`f${at}.txt`, 'hit\n'.repeat(200)]),
    );
    const running = search(
      project(tree),
      { query: 'hit' },
      { requestId: 'stop-me', limits: { maxMatches: 1_000_000, maxFiles: 10_000 } },
    );
    expect(cancelTextSearch('stop-me')).toBe(true);
    expect((await running).summary.cancelled).toBe(true);
    expect(cancelTextSearch('stop-me')).toBe(false);
  });

  it('reports a missing ripgrep instead of failing', async () => {
    const summary = await runTextSearch({
      ownerId: 'w',
      requestId: 'r',
      folder: tempDir(),
      request: { ...PLAIN, query: 'x' },
      onBatch: () => undefined,
      rgPath: null,
    });
    expect(summary.unavailable).toBe(true);
  });
});
