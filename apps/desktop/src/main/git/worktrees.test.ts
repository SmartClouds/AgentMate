import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import { checkoutBranch, deleteBranch, listBranches } from './plumbing';
import {
  addWorktree,
  copyFiles,
  listCopyCandidates,
  listWorktrees,
  mergeBaseIntoWorktree,
  mergeIntoBase,
  mergePreflight,
  pruneWorktrees,
  removeWorktree,
  worktreeStatus,
} from './worktrees';

/** git prints forward slashes on Windows, and a temp path can differ in case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).toLowerCase();
  return norm(a) === norm(b);
}

/** A repo plus an empty spot beside it for worktrees. */
function setup(files?: Record<string, string>) {
  const repo = initGitRepo(files);
  const trees = tempDir('runova-trees-');
  return { repo, trees, at: (name: string) => join(trees, name) };
}

describe.runIf(hasGit())('git worktrees', () => {
  describe('listWorktrees', () => {
    it('lists the main checkout first, with its branch', async () => {
      const { repo } = setup();
      const [main, ...rest] = await listWorktrees(repo.dir);
      expect(samePath(main?.path ?? '', repo.dir)).toBe(true);
      expect(main?.branch).toBe('main');
      expect(rest).toEqual([]);
    });
  });

  describe('addWorktree', () => {
    it('creates a new branch from a base in its own folder', async () => {
      const { repo, at } = setup();
      const entry = await addWorktree(repo.dir, {
        path: at('feat'),
        branch: 'feat/auth',
        mode: 'new',
        base: 'main',
      });
      expect(samePath(entry.path, at('feat'))).toBe(true);
      expect(entry.branch).toBe('feat/auth');
      expect(existsSync(join(at('feat'), 'README.md'))).toBe(true);
      expect((await listWorktrees(repo.dir)).map((w) => w.branch)).toEqual(['main', 'feat/auth']);
    });

    it('finds the new worktree when its folder is reached through a link', async () => {
      // Git lists the real folder. A temp folder is often reached another way: /var is a link
      // to /private/var on macOS, and Windows can hand out an 8.3 short name like RUNNER~1.
      const { repo, trees } = setup();
      const linked = tempDir('runova-trees-link-');
      rmSync(linked, { recursive: true, force: true });
      symlinkSync(trees, linked, 'junction');
      const entry = await addWorktree(repo.dir, {
        path: join(linked, 'feat'),
        branch: 'feat/linked',
        mode: 'new',
        base: 'main',
      });
      expect(entry.branch).toBe('feat/linked');
      expect(existsSync(join(trees, 'feat', 'README.md'))).toBe(true);
    });

    it('checks out an existing branch', async () => {
      const { repo, at } = setup();
      repo.git('branch', 'fix-login');
      const entry = await addWorktree(repo.dir, {
        path: at('fix'),
        branch: 'fix-login',
        mode: 'existing',
        base: null,
      });
      expect(entry.branch).toBe('fix-login');
    });

    it('explains why it cannot use a branch name that is taken', async () => {
      const { repo, at } = setup();
      repo.git('branch', 'taken');
      await expect(
        addWorktree(repo.dir, { path: at('x'), branch: 'taken', mode: 'new', base: 'main' }),
      ).rejects.toThrow(/already exists/);
    });

    it('explains that a branch is already checked out somewhere else', async () => {
      const { repo, at } = setup();
      await expect(
        addWorktree(repo.dir, { path: at('x'), branch: 'main', mode: 'existing', base: null }),
      ).rejects.toThrow(/already checked out/);
    });

    it('refuses a folder that already has files in it', async () => {
      const { repo, at } = setup();
      writeTree(at('busy'), { 'keep.txt': 'mine' });
      await expect(
        addWorktree(repo.dir, { path: at('busy'), branch: 'b', mode: 'new', base: 'main' }),
      ).rejects.toThrow(/already exists/);
      expect(readFileSync(join(at('busy'), 'keep.txt'), 'utf8')).toBe('mine');
    });

    it('refuses names git would read as an option', async () => {
      const { repo, at } = setup();
      await expect(
        addWorktree(repo.dir, { path: at('x'), branch: '--evil', mode: 'new', base: 'main' }),
      ).rejects.toThrow(/Invalid branch name/);
    });
  });

  describe('worktreeStatus', () => {
    it('counts changes and commits ahead of and behind the base', async () => {
      const { repo, at } = setup();
      const path = at('feat');
      await addWorktree(repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });

      expect(await worktreeStatus(path, 'main')).toEqual({
        changes: 0,
        ahead: 0,
        behind: 0,
        merged: true,
        unpushed: null,
      });

      writeTree(path, { 'a.txt': 'a' });
      initGitRepoCommit(path, 'work');
      writeTree(path, { 'b.txt': 'b', 'README.md': 'changed' });
      writeTree(repo.dir, { 'main.txt': 'm' });
      repo.commitAll('main moved on');

      expect(await worktreeStatus(path, 'main')).toEqual({
        changes: 2,
        ahead: 1,
        behind: 1,
        merged: false,
        unpushed: null,
      });
    });

    it('returns null for a folder that is gone', async () => {
      expect(await worktreeStatus(join(tempDir(), 'nope'), 'main')).toBeNull();
    });
  });

  describe('removeWorktree and pruneWorktrees', () => {
    it('removes a clean worktree and its folder', async () => {
      const { repo, at } = setup();
      const path = at('feat');
      await addWorktree(repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });
      await removeWorktree(repo.dir, path, { force: false });
      expect(existsSync(path)).toBe(false);
      expect(await listWorktrees(repo.dir)).toHaveLength(1);
    });

    it('will not throw away uncommitted work unless forced', async () => {
      const { repo, at } = setup();
      const path = at('feat');
      await addWorktree(repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });
      writeTree(path, { 'wip.txt': 'unsaved' });
      await expect(removeWorktree(repo.dir, path, { force: false })).rejects.toThrow(/uncommitted/);
      expect(existsSync(join(path, 'wip.txt'))).toBe(true);
      await removeWorktree(repo.dir, path, { force: true });
      expect(existsSync(path)).toBe(false);
    });

    it('treats a worktree whose folder was deleted by hand as prunable, then prunes it', async () => {
      const { repo, at } = setup();
      const path = at('feat');
      await addWorktree(repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });
      rmSync(path, { recursive: true, force: true });
      expect((await listWorktrees(repo.dir))[1]?.prunable).toBe(true);
      await pruneWorktrees(repo.dir);
      expect(await listWorktrees(repo.dir)).toHaveLength(1);
    });

    it('counts a worktree that is already gone as removed', async () => {
      const { repo, at } = setup();
      const path = at('feat');
      await addWorktree(repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });
      rmSync(path, { recursive: true, force: true });
      await expect(removeWorktree(repo.dir, path, { force: false })).resolves.toBeUndefined();
      expect(await listWorktrees(repo.dir)).toHaveLength(1);
    });
  });

  describe('merging back', () => {
    async function withFeature() {
      const ctx = setup();
      const path = ctx.at('feat');
      await addWorktree(ctx.repo.dir, { path, branch: 'feat', mode: 'new', base: 'main' });
      writeTree(path, { 'feature.txt': 'new' });
      initGitRepoCommit(path, 'feature');
      return { ...ctx, path };
    }

    it('is ready when both sides are clean and the main checkout is on the base', async () => {
      const { repo, path } = await withFeature();
      expect(await mergePreflight(repo.dir, path, 'feat', 'main')).toEqual({ ok: true });
    });

    it('names each thing in the way', async () => {
      const { repo, path } = await withFeature();
      writeTree(path, { 'wip.txt': 'x' });
      expect(await mergePreflight(repo.dir, path, 'feat', 'main')).toEqual({
        ok: false,
        blocker: { kind: 'worktree-dirty', changes: 1 },
      });
      rmSync(join(path, 'wip.txt'));

      writeTree(repo.dir, { 'README.md': 'edited in main' });
      expect(await mergePreflight(repo.dir, path, 'feat', 'main')).toEqual({
        ok: false,
        blocker: { kind: 'main-dirty', changes: 1 },
      });
      repo.git('checkout', '--', 'README.md');

      repo.git('checkout', '-b', 'dev');
      expect(await mergePreflight(repo.dir, path, 'feat', 'main')).toEqual({
        ok: false,
        blocker: { kind: 'main-not-on-base', current: 'dev' },
      });
      repo.git('checkout', 'main');
    });

    it('says when there is nothing to merge', async () => {
      const { repo, at } = setup();
      const path = at('empty');
      await addWorktree(repo.dir, { path, branch: 'empty', mode: 'new', base: 'main' });
      expect(await mergePreflight(repo.dir, path, 'empty', 'main')).toEqual({
        ok: false,
        blocker: { kind: 'nothing-to-merge' },
      });
    });

    it('merges the branch into the base in the main checkout', async () => {
      const { repo, path } = await withFeature();
      const result = await mergeIntoBase(repo.dir, 'feat', 'main');
      expect(result).toEqual({ ok: true, message: expect.any(String) });
      expect(existsSync(join(repo.dir, 'feature.txt'))).toBe(true);
      expect((await worktreeStatus(path, 'main'))?.merged).toBe(true);
    });

    it('backs out of a conflicting merge and lists the files', async () => {
      const { repo, path } = await withFeature();
      writeTree(path, { 'README.md': 'feature side' });
      initGitRepoCommit(path, 'feature readme');
      writeTree(repo.dir, { 'README.md': 'main side' });
      repo.commitAll('main readme');

      expect(await mergeIntoBase(repo.dir, 'feat', 'main')).toEqual({
        ok: false,
        conflicts: ['README.md'],
      });
      // Nothing half-merged is left behind in the main checkout.
      expect(repo.git('status', '--porcelain').trim()).toBe('');
      expect(readFileSync(join(repo.dir, 'README.md'), 'utf8')).toBe('main side');

      // Bringing the base in on the worktree's side leaves the conflict there to resolve.
      expect(await mergeBaseIntoWorktree(path, 'main')).toEqual({
        ok: false,
        conflicts: ['README.md'],
      });
    });
  });

  describe('branches in other worktrees', () => {
    it('reports which worktree a branch is checked out in', async () => {
      const { repo, at } = setup();
      await addWorktree(repo.dir, { path: at('feat'), branch: 'feat', mode: 'new', base: 'main' });
      const feat = (await listBranches(repo.dir)).find((b) => b.name === 'feat');
      expect(samePath(feat?.worktreePath ?? '', at('feat'))).toBe(true);
      const main = (await listBranches(repo.dir)).find((b) => b.name === 'main');
      expect(main?.worktreePath).toBeUndefined();
    });

    it('explains checkout and delete of a branch another worktree has', async () => {
      const { repo, at } = setup();
      await addWorktree(repo.dir, { path: at('feat'), branch: 'feat', mode: 'new', base: 'main' });
      await expect(checkoutBranch(repo.dir, 'feat')).rejects.toThrow(/open in the worktree/);
      await expect(
        deleteBranch(repo.dir, 'feat', { deleteRemote: false, force: true }),
      ).rejects.toThrow(/open in the worktree/);
    });
  });

  describe('local files', () => {
    it('finds untracked and ignored files that match, skipping ignored folders', async () => {
      const { repo } = setup({
        'README.md': '#',
        '.gitignore': '.env\nnode_modules/\n',
      });
      writeTree(repo.dir, {
        '.env': 'SECRET=1',
        '.env.local': 'X=1',
        'apps/web/.env': 'Y=1',
        'node_modules/pkg/.env': 'no',
        'scratch.txt': 'no',
      });
      expect((await listCopyCandidates(repo.dir, ['.env', '.env.*'])).sort()).toEqual([
        '.env',
        '.env.local',
        'apps/web/.env',
      ]);
    });

    it('copies files across, keeping folders and never overwriting', async () => {
      const from = tempDir();
      const to = tempDir();
      writeTree(from, { '.env': 'A', 'apps/web/.env': 'B' });
      writeTree(to, { '.env': 'already here' });
      expect(await copyFiles(from, to, ['.env', 'apps/web/.env'])).toEqual(['apps/web/.env']);
      expect(readFileSync(join(to, '.env'), 'utf8')).toBe('already here');
      expect(readFileSync(join(to, 'apps/web/.env'), 'utf8')).toBe('B');
    });

    it('refuses a path that leaves the folder', async () => {
      const from = tempDir();
      const to = tempDir();
      writeFileSync(join(from, 'a'), 'x');
      await expect(copyFiles(from, to, ['../a'])).rejects.toThrow(/outside/);
    });
  });
});

/** Commits everything in a worktree, which has no helper of its own from `initGitRepo`. */
function initGitRepoCommit(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', message], { stdio: 'pipe' });
}
