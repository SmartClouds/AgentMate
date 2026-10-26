import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasGit, initGitRepo, tempDir } from '../../test/main/fixtures';

/**
 * The post-merge cleanup against real git, in the layout that broke it: the base branch open in
 * the main checkout and the merged branch in a linked worktree (how Orca and other worktree
 * managers lay a project out). Git refuses to check one branch out in two worktrees, so a plain
 * "switch to the base" failed with "'main' is open in the worktree at ...".
 */

vi.mock('../pipelines/githubActions', () => ({
  githubRepoForFolder: async () => null,
}));

const { cleanupAfterMerge } = await import('./pullRequests');

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** A bare origin, a main checkout on `main`, and a linked worktree on a merged `feature`. */
function mergedFeatureInWorktree(): { main: string; worktree: string; origin: string } {
  const seed = initGitRepo({ 'README.md': '# demo\n' });
  const origin = join(tempDir('runova-origin-'), 'origin.git');
  run(seed.dir, 'clone', '--bare', seed.dir, origin);

  const main = join(tempDir('runova-main-'), 'repo');
  run(seed.dir, 'clone', origin, main);
  run(main, 'config', 'user.name', 'Runova Test');
  run(main, 'config', 'user.email', 'test@runova.invalid');
  run(main, 'config', 'commit.gpgsign', 'false');

  const worktree = join(tempDir('runova-wt-'), 'feature');
  run(main, 'worktree', 'add', '-b', 'feature', worktree);
  writeFileSync(join(worktree, 'feature.ts'), 'export const a = 1;\n', 'utf-8');
  run(worktree, 'add', '.');
  run(worktree, 'commit', '-m', 'feat: add a feature');
  run(worktree, 'push', '-u', 'origin', 'feature');

  // What GitHub does on merge: main on the remote moves on, the local main stays behind.
  run(worktree, 'push', 'origin', 'feature:main');
  return { main, worktree, origin };
}

describe.skipIf(!hasGit())('cleanupAfterMerge in a linked worktree', () => {
  it('cleans up even though the base is open in the main checkout', async () => {
    const { main, worktree, origin } = mergedFeatureInWorktree();
    const merged = run(origin, 'rev-parse', 'main');
    expect(run(main, 'rev-parse', 'main')).not.toBe(merged);

    const steps = await cleanupAfterMerge(worktree, { base: 'main', head: 'feature' });

    expect(steps.map((step) => [step.step, step.ok])).toEqual([
      ['checkout', true],
      ['delete', true],
      ['pull', true],
    ]);
    // The worktree sits on the merged commit, detached, since main lives in the main checkout.
    expect(run(worktree, 'branch', '--show-current')).toBe('');
    expect(run(worktree, 'rev-parse', 'HEAD')).toBe(merged);
    // The main checkout got the merge.
    expect(run(main, 'rev-parse', 'HEAD')).toBe(merged);
    // And the branch is gone here and on the remote.
    expect(run(main, 'branch', '--list', 'feature')).toBe('');
    expect(run(origin, 'branch', '--list', 'feature')).toBe('');
  }, 60_000);

  it('deletes the branch even when the main checkout cannot be pulled', async () => {
    const { main, worktree, origin } = mergedFeatureInWorktree();
    // An uncommitted file in the main checkout that the merge would overwrite.
    writeFileSync(join(main, 'feature.ts'), 'export const a = 2;\n', 'utf-8');

    const steps = await cleanupAfterMerge(worktree, { base: 'main', head: 'feature' });

    expect(steps.map((step) => [step.step, step.ok])).toEqual([
      ['checkout', true],
      ['delete', true],
      ['pull', false],
    ]);
    expect(steps.at(-1)?.message).toMatch(/^Could not update main in /);
    expect(run(origin, 'branch', '--list', 'feature')).toBe('');
  }, 60_000);
});
