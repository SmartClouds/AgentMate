import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import { indexProjectFiles } from './fileIndex';

/**
 * The list behind the explorer's search box. In a repository git decides what is in it, so
 * .gitignore is what keeps build output out; anywhere else the walk has to judge for itself.
 */

function write(root: string, path: string, content = 'x'): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

describe('indexProjectFiles', () => {
  it.runIf(hasGit())('lists tracked and new files, and leaves ignored ones out', async () => {
    const repo = initGitRepo({
      'README.md': '# demo\n',
      'src/index.ts': 'export const a = 1;\n',
      '.gitignore': '/dist/\n',
    });
    write(repo.dir, 'dist/bundle.js');
    write(repo.dir, 'src/new.ts');
    write(repo.dir, 'node_modules/left-pad/index.js');

    const index = await indexProjectFiles(repo.dir);

    expect(index.files).toContain('README.md');
    expect(index.files).toContain('src/index.ts');
    expect(index.files).toContain('src/new.ts');
    expect(index.files).not.toContain('dist/bundle.js');
    expect(index.files.some((path) => path.includes('node_modules'))).toBe(false);
    expect(index.truncated).toBe(false);
  });

  it.runIf(hasGit())('lists a conflicted file once', async () => {
    const repo = initGitRepo({ 'shared.txt': 'base\n' });
    repo.git('checkout', '-b', 'other');
    writeFileSync(join(repo.dir, 'shared.txt'), 'theirs\n', 'utf-8');
    repo.commitAll('theirs');
    repo.git('checkout', 'main');
    writeFileSync(join(repo.dir, 'shared.txt'), 'ours\n', 'utf-8');
    repo.commitAll('ours');
    try {
      repo.git('merge', 'other');
    } catch {
      // The conflict is the point: the file now sits in the index three times over.
    }

    const index = await indexProjectFiles(repo.dir);

    expect(index.files.filter((path) => path === 'shared.txt')).toHaveLength(1);
  });

  it('walks a folder that is not a repository, skipping generated folders', async () => {
    const dir = tempDir('runova-index-');
    writeTree(dir, {
      'app.js': 'x',
      'lib/util.js': 'x',
      'lib/deep/inner/thing.js': 'x',
      'dist/app.min.js': 'x',
      'node_modules/pkg/index.js': 'x',
    });

    const index = await indexProjectFiles(dir);

    expect(index.files.sort()).toEqual(['app.js', 'lib/deep/inner/thing.js', 'lib/util.js']);
  });

  it('reports the folder the paths are relative to, resolved', async () => {
    const dir = tempDir('runova-index-root-');
    writeTree(dir, { 'lib/a.txt': 'x' });

    const index = await indexProjectFiles(join(dir, 'lib', '..'));

    expect(index.root).toBe(dir);
    expect(index.files).toEqual(['lib/a.txt']);
  });
});
