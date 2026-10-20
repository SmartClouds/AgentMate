import { describe, expect, it } from 'vitest';
import { searchFiles, toAbsolutePath } from './fileSearch';

/**
 * What the explorer's search box puts at the top. The order is the whole feature: a name that
 * matches beats a folder that happens to contain the letters.
 */

const FILES = [
  'README.md',
  'apps/desktop/src/renderer/src/stores/workspaceStore.ts',
  'apps/desktop/src/renderer/src/stores/workspaceStore.test.ts',
  'apps/desktop/src/renderer/src/components/workspace/git/GitPanel.tsx',
  'apps/desktop/src/main/ipc/explorer.ts',
  'packages/core/src/workspace/fileOps.ts',
  'docs/store.md',
];

function paths(query: string): string[] {
  return searchFiles(FILES, query).hits.map((hit) => hit.path);
}

describe('searchFiles', () => {
  it('finds nothing for an empty query', () => {
    expect(searchFiles(FILES, '   ')).toEqual({ hits: [], total: 0 });
  });

  it('puts the exact file name first', () => {
    expect(paths('store.md')[0]).toBe('docs/store.md');
  });

  it('prefers a name match over a folder match', () => {
    expect(paths('fileOps')[0]).toBe('packages/core/src/workspace/fileOps.ts');
    expect(paths('workspacestore')[0]).toBe(
      'apps/desktop/src/renderer/src/stores/workspaceStore.ts',
    );
  });

  it('ignores case and spaces', () => {
    expect(paths('git panel')[0]).toBe(
      'apps/desktop/src/renderer/src/components/workspace/git/GitPanel.tsx',
    );
  });

  it('matches scattered letters when nothing matches outright', () => {
    expect(paths('gtpnl')[0]).toBe(
      'apps/desktop/src/renderer/src/components/workspace/git/GitPanel.tsx',
    );
  });

  it('matches a folder and a name together when the query has a slash', () => {
    expect(paths('ipc/explorer')).toEqual(['apps/desktop/src/main/ipc/explorer.ts']);
  });

  it('marks the letters that matched', () => {
    const [hit] = searchFiles(['src/stores/workspaceStore.ts'], 'workspacestore').hits;
    const marked = hit.ranges.map(([from, to]) => hit.path.slice(from, to)).join('');
    expect(marked).toBe('workspaceStore');
  });

  it('counts every match but hands back only the first few', () => {
    const many = Array.from({ length: 30 }, (_, index) => `src/thing${index}.ts`);
    const result = searchFiles(many, 'thing', { limit: 5 });
    expect(result.total).toBe(30);
    expect(result.hits).toHaveLength(5);
  });

  it('says where each hit sits in the list it was given', () => {
    const [hit] = searchFiles(FILES, 'fileOps').hits;
    expect(FILES[hit.index]).toBe(hit.path);
  });

  it('orders equal matches the same way every time', () => {
    const first = paths('workspacestore');
    expect(paths('workspacestore')).toEqual(first);
    expect(first).toEqual([
      'apps/desktop/src/renderer/src/stores/workspaceStore.ts',
      'apps/desktop/src/renderer/src/stores/workspaceStore.test.ts',
    ]);
  });
});

/**
 * Patterns are opt-in: `*.md` is a glob, `/regex/` is a regular expression, and anything else
 * is searched as before. The other callers of searchFiles do not turn this on.
 */
describe('searchFiles with patterns', () => {
  const TREE = [
    'README.md',
    'notesmd',
    'notes.mdx',
    'archive.md.bak',
    'my notes.md',
    'docs/store.md',
    'docs/guide/intro.md',
    'drafts/notes(1).md',
    'src/index.ts',
    'src/app.test.ts',
    'src/components/Button.tsx',
    'src/components/Button.test.tsx',
  ];

  function matches(query: string): string[] {
    return searchFiles(TREE, query, { patterns: true })
      .hits.map((hit) => hit.path)
      .sort();
  }

  function marked(path: string, query: string): string {
    const [hit] = searchFiles([path], query, { patterns: true }).hits;
    return hit.ranges.map(([from, to]) => hit.path.slice(from, to)).join('');
  }

  describe('globs', () => {
    it('finds every file with an extension, in any folder', () => {
      expect(matches('*.md')).toEqual([
        'README.md',
        'docs/guide/intro.md',
        'docs/store.md',
        'drafts/notes(1).md',
        'my notes.md',
      ]);
    });

    it('ignores case', () => {
      expect(matches('*.MD')).toEqual(matches('*.md'));
      expect(matches('readme.*')).toEqual(['README.md']);
    });

    it('takes the dot literally and the whole name, not a piece of it', () => {
      expect(matches('*.md')).not.toContain('notesmd');
      expect(matches('*.md')).not.toContain('notes.mdx');
      expect(matches('*.md')).not.toContain('archive.md.bak');
    });

    it('lets ? stand for exactly one character that is not a slash', () => {
      expect(matches('index.t?')).toEqual(['src/index.ts']);
      expect(matches('index.?')).toEqual([]);
      expect(matches('docs?store.md')).toEqual([]);
    });

    it('stops * at a folder boundary', () => {
      expect(matches('docs/*.md')).toEqual(['docs/store.md']);
    });

    it('lets ** run through folders, or through none', () => {
      expect(matches('docs/**/*.md')).toEqual(['docs/guide/intro.md', 'docs/store.md']);
      expect(matches('docs/**')).toEqual(['docs/guide/intro.md', 'docs/store.md']);
    });

    it('finds a folder in the pattern at any depth', () => {
      expect(matches('components/*.tsx')).toEqual([
        'src/components/Button.test.tsx',
        'src/components/Button.tsx',
      ]);
    });

    it('does not read a folder name in the middle of a word', () => {
      expect(matches('ocs/*.md')).toEqual([]);
    });

    it('takes brackets and other regex characters literally', () => {
      expect(matches('*(1).md')).toEqual(['drafts/notes(1).md']);
      expect(matches('*.[md]')).toEqual([]);
    });

    it('keeps spaces, since file names have them', () => {
      expect(matches('my *.md')).toEqual(['my notes.md']);
    });

    it('matches the parts in between the wildcards', () => {
      expect(matches('*.test.*')).toEqual(['src/app.test.ts', 'src/components/Button.test.tsx']);
    });

    it('marks the fixed parts of the pattern, not the wildcards', () => {
      expect(marked('docs/store.md', '*.md')).toBe('.md');
      expect(marked('docs/store.md', 'st*.md')).toBe('st.md');
    });
  });

  describe('regular expressions', () => {
    it('reads what sits between two slashes as a regular expression', () => {
      expect(matches('/\\.test\\.tsx?$/')).toEqual([
        'src/app.test.ts',
        'src/components/Button.test.tsx',
      ]);
    });

    it('ignores case', () => {
      expect(matches('/^readme/')).toEqual(['README.md']);
    });

    it('matches against the whole path, folders included', () => {
      expect(matches('/^docs\\/.*\\.md$/')).toEqual(['docs/guide/intro.md', 'docs/store.md']);
    });

    it('supports alternation and groups', () => {
      expect(matches('/\\.(mdx|bak)$/')).toEqual(['archive.md.bak', 'notes.mdx']);
    });

    it('marks what the expression matched', () => {
      expect(marked('docs/store.md', '/stor./')).toBe('store');
    });

    it('marks nothing for an expression that matches the empty string', () => {
      const [hit] = searchFiles(['a.md'], '/^/', { patterns: true }).hits;
      expect(hit.ranges).toEqual([]);
    });

    it('reports an expression that cannot be compiled, and finds nothing', () => {
      expect(searchFiles(TREE, '/(/', { patterns: true })).toEqual({
        hits: [],
        total: 0,
        invalid: true,
      });
    });

    it('does not flag an ordinary search as invalid', () => {
      expect(searchFiles(TREE, 'store', { patterns: true }).invalid).toBeUndefined();
      expect(searchFiles(TREE, '*.md', { patterns: true }).invalid).toBeUndefined();
    });
  });

  describe('everything else', () => {
    it('still searches by name when the query has no wildcard', () => {
      expect(searchFiles(TREE, 'store', { patterns: true }).hits[0]?.path).toBe('docs/store.md');
      expect(searchFiles(TREE, 'ipc/store', { patterns: true }).hits).toEqual([]);
    });

    it('treats a wildcard as plain text when patterns are not asked for', () => {
      expect(searchFiles(TREE, '*.md')).toEqual({ hits: [], total: 0 });
    });

    it('lists shorter paths first, then alphabetical', () => {
      const [first, second] = searchFiles(TREE, '*.md', { patterns: true }).hits;
      expect(first.path).toBe('README.md');
      expect(second.path).toBe('my notes.md');
    });

    it('counts every match but hands back only the first few', () => {
      const many = Array.from({ length: 30 }, (_, index) => `src/thing${index}.ts`);
      const result = searchFiles(many, 'thing*.ts', { limit: 5, patterns: true });
      expect(result.total).toBe(30);
      expect(result.hits).toHaveLength(5);
    });

    it('says where each hit sits in the list it was given', () => {
      const [hit] = searchFiles(TREE, 'index.*', { patterns: true }).hits;
      expect(TREE[hit.index]).toBe(hit.path);
      expect(hit.nameStart).toBe('src/'.length);
    });
  });
});

describe('toAbsolutePath', () => {
  it('uses the separator the project root came with', () => {
    expect(toAbsolutePath('E:\\work\\app', 'src/index.ts')).toBe('E:\\work\\app\\src\\index.ts');
    expect(toAbsolutePath('/home/me/app/', 'src/index.ts')).toBe('/home/me/app/src/index.ts');
  });
});
