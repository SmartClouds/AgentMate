import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestNode } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceTests, listWorkspaceFiles } from './discovery';

/** Real folders on disk, read the way the Tests panel reads a project. */

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runova-discovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function files(entries: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }
}

function outline(nodes: TestNode[], indent = ''): string[] {
  return nodes.flatMap((node) => [
    `${indent}${node.kind} ${node.name}`,
    ...outline(node.children, `${indent}  `),
  ]);
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('discoverWorkspaceTests', () => {
  it('finds tests across ecosystems in a folder that is not a git repository', async () => {
    await files({
      'web/package.json': JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }),
      'web/src/math.test.ts': "describe('math', () => {\n  it('adds', () => {});\n});\n",
      'web/node_modules/dep/package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
      'web/node_modules/dep/index.test.js': "it('never read', () => {});\n",
      'api/pyproject.toml': '[tool.pytest.ini_options]\n',
      'api/tests/test_users.py': 'def test_lists():\n    pass\n',
      'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
      'svc/calc/calc_test.go': 'package calc\n\nfunc TestAdd(t *testing.T) {}\n',
      'README.md': '# hi\n',
    });
    const discovery = await discoverWorkspaceTests(root);
    expect(discovery.projects.map((project) => project.id)).toEqual([
      'pytest:api',
      'go:svc',
      'vitest:web',
    ]);
    expect(outline(discovery.tree)).toEqual([
      'project pytest · api',
      '  file tests/test_users.py',
      '    test test_lists',
      'project Go · svc',
      '  file calc/calc_test.go',
      '    test TestAdd',
      'project Vitest · web',
      '  file src/math.test.ts',
      '    suite math',
      '      test adds',
    ]);
    expect(discovery.truncated).toBe(false);
  });

  it.skipIf(!hasGit)('leaves out files git ignores', async () => {
    await files({
      'package.json': JSON.stringify({ devDependencies: { vitest: '1' } }),
      '.gitignore': 'generated/\n',
      'src/kept.test.ts': "it('kept', () => {});\n",
      'generated/dropped.test.ts': "it('dropped', () => {});\n",
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const discovery = await discoverWorkspaceTests(root);
    expect(outline(discovery.tree)).toEqual([
      'project Vitest',
      '  file src/kept.test.ts',
      '    test kept',
    ]);
  });

  it('keeps going past files it cannot read and very large files', async () => {
    await files({
      'package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
      'a.test.js': "it('small', () => {});\n",
      'huge.test.js': `it('huge', () => {});\n${'//'.repeat(400_000)}\n`,
    });
    const discovery = await discoverWorkspaceTests(root);
    expect(outline(discovery.tree)).toEqual(['project Jest', '  file a.test.js', '    test small']);
  });

  it('marks the discovery truncated when the file cap is hit', async () => {
    await files({
      'package.json': JSON.stringify({ devDependencies: { vitest: '1' } }),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`t/${i}.test.ts`, `it('t${i}', () => {});\n`]),
      ),
    });
    const discovery = await discoverWorkspaceTests(root, { maxTestFiles: 5 });
    expect(discovery.truncated).toBe(true);
    expect(discovery.tree[0].children).toHaveLength(5);
  });

  it('returns no projects for an empty folder', async () => {
    expect(await discoverWorkspaceTests(root)).toEqual({
      projects: [],
      tree: [],
      truncated: false,
    });
  });
});

describe('listWorkspaceFiles', () => {
  it('walks with forward slashes and skips dependency and build folders', async () => {
    await files({
      'src/a.ts': '',
      'node_modules/x/b.ts': '',
      '.git/config': '',
      'target/debug/c.rs': '',
      'nested/deeper/d.py': '',
    });
    const listed = await listWorkspaceFiles(root, { preferGit: false });
    expect(listed.files.sort()).toEqual(['nested/deeper/d.py', 'src/a.ts']);
  });
});
