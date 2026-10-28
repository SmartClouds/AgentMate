import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { WorktreeInfo } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateWorktreeResult,
  GitOpResult,
  SuggestGitTextResult,
  WorktreeDefaults,
  WorktreeMergePreflight,
  WorktreeMergeResult,
  WorktreeRemovePreflight,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The worktree handlers against real repositories: what the Workspace sees in its rail and
 * panel, and what lands on disk and in worktrees.json when the user creates, merges and
 * removes one.
 */

const headless = vi.hoisted(() => ({
  runHeadlessCliPrompt: vi.fn(),
  cancelHeadlessPrompt: vi.fn(() => true),
}));
vi.mock('../cli/headlessPrompt', () => headless);

const userData = useTempUserData();
const PROJECT_ID = 'p1';
let repo: ReturnType<typeof initGitRepo>;

expectChannelsCovered(IPC.worktrees, [IPC.worktrees.onChanged]);

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function saved(): WorktreeInfo[] {
  return JSON.parse(readFileSync(userData.dataFile('worktrees.json'), 'utf8'));
}

async function create(branch: string, extra: Partial<{ base: string; path: string }> = {}) {
  const result = await invoke<CreateWorktreeResult>(IPC.worktrees.create, {
    projectId: PROJECT_ID,
    branch,
    mode: 'new',
    base: extra.base ?? 'main',
    path: extra.path ?? join(tempDir('runova-wt-'), 'tree'),
  });
  if (!result.ok) throw new Error(result.error);
  return result.worktree;
}

beforeEach(async () => {
  repo = initGitRepo({ 'README.md': '# demo\n', '.gitignore': '.env\n' });
  userData.writeData('projects.json', [
    {
      id: PROJECT_ID,
      name: 'Demo',
      folderPath: repo.dir,
      createdAt: '2026-01-01T00:00:00Z',
      worktreeSetup: { command: 'pnpm install', copyGlobs: null },
    },
  ]);
  headless.runHeadlessCliPrompt.mockReset();
  await loadIpc(
    () => import('./worktrees'),
    (module) => module.registerWorktreeHandlers(),
  );
});

describe.runIf(hasGit())('worktree handlers', () => {
  describe('defaults and paths', () => {
    it('reports the branches and what a new worktree starts with', async () => {
      repo.git('branch', 'dev');
      const defaults = await invoke<WorktreeDefaults>(IPC.worktrees.defaults, PROJECT_ID);
      expect(defaults).toMatchObject({
        isRepo: true,
        defaultBranch: 'main',
        currentBranch: 'main',
        copyGlobs: ['.env', '.env.*'],
        setupCommand: 'pnpm install',
      });
      expect(defaults.branches.map((b) => b.name)).toEqual(['dev', 'main']);
    });

    it('says so when the project is not a repository', async () => {
      userData.writeData('projects.json', [
        { id: PROJECT_ID, name: 'Plain', folderPath: tempDir(), createdAt: '2026-01-01' },
      ]);
      expect((await invoke<WorktreeDefaults>(IPC.worktrees.defaults, PROJECT_ID)).isRepo).toBe(
        false,
      );
      expect(await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID)).toEqual([]);
    });

    it('suggests a folder next to the repository, numbered when taken', async () => {
      const expected = join(dirname(repo.dir), `${basename(repo.dir)}.worktrees`, 'feat-auth');
      expect(await invoke(IPC.worktrees.suggestPath, PROJECT_ID, 'feat/Auth')).toBe(expected);
      writeTree(expected, { 'x.txt': 'x' });
      expect(await invoke(IPC.worktrees.suggestPath, PROJECT_ID, 'feat/Auth')).toBe(
        `${expected}-2`,
      );
      rmSync(dirname(expected), { recursive: true, force: true });
    });

    it('uses the base folder from Settings', async () => {
      const base = tempDir('runova-base-');
      userData.writeData('settings.json', { worktrees: { baseDir: base } });
      expect(await invoke(IPC.worktrees.suggestPath, PROJECT_ID, 'x')).toBe(
        join(base, basename(repo.dir), 'x'),
      );
    });

    it('lets the user pick a folder', async () => {
      queueDialog('showOpenDialog', { canceled: false, filePaths: ['D:\\trees'] });
      expect(await invoke(IPC.worktrees.pickLocation, 'C:\\start')).toBe('D:\\trees');
      queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
      expect(await invoke(IPC.worktrees.pickLocation, null)).toBeNull();
    });
  });

  describe('create and list', () => {
    it('creates a worktree, remembers it and lists it with its status', async () => {
      const worktree = await create('feat');
      expect(worktree).toMatchObject({
        projectId: PROJECT_ID,
        branch: 'feat',
        baseBranch: 'main',
        createdByApp: true,
        missing: false,
        status: { changes: 0, ahead: 0, behind: 0, merged: true, unpushed: null },
      });
      expect(worktree.id).toMatch(/^wt-/);
      expect(saved()).toEqual([expect.objectContaining({ id: worktree.id, branch: 'feat' })]);

      const listed = await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID);
      expect(listed.map((w) => w.id)).toEqual([worktree.id]);
    });

    it('puts it at the suggested spot when no path is given', async () => {
      const result = await invoke<CreateWorktreeResult>(IPC.worktrees.create, {
        projectId: PROJECT_ID,
        branch: 'auto',
        mode: 'new',
        base: null,
        path: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expected = join(dirname(repo.dir), `${basename(repo.dir)}.worktrees`, 'auto');
      expect(samePath(result.worktree.path, expected)).toBe(true);
      await invoke(IPC.worktrees.remove, {
        projectId: PROJECT_ID,
        worktreeId: result.worktree.id,
        force: true,
        deleteBranch: false,
      });
      rmSync(dirname(expected), { recursive: true, force: true });
    });

    it('reports a readable error instead of throwing', async () => {
      repo.git('branch', 'taken');
      const result = await invoke<CreateWorktreeResult>(IPC.worktrees.create, {
        projectId: PROJECT_ID,
        branch: 'taken',
        mode: 'new',
        base: 'main',
        path: join(tempDir(), 't'),
      });
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/already exists/) });
    });

    it('refuses a worktree scope as the project', async () => {
      const worktree = await create('feat');
      const result = await invoke<CreateWorktreeResult>(IPC.worktrees.create, {
        projectId: `${PROJECT_ID}~${worktree.id}`,
        branch: 'nested',
        mode: 'new',
        base: 'main',
        path: join(tempDir(), 'n'),
      });
      expect(result.ok).toBe(false);
    });

    it('picks up worktrees made outside Runova', async () => {
      const path = join(tempDir(), 'outside');
      repo.git('worktree', 'add', '-b', 'cli-made', path);
      const [listed] = await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID);
      expect(listed).toMatchObject({ branch: 'cli-made', createdByApp: false, baseBranch: 'main' });
      expect(samePath(listed?.path ?? '', path)).toBe(true);
      // The id sticks, so the worktree keeps its workspace across lists.
      const [again] = await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID);
      expect(again?.id).toBe(listed?.id);
    });

    it('flags a worktree whose folder was deleted, and prune clears it', async () => {
      const worktree = await create('feat');
      rmSync(worktree.path, { recursive: true, force: true });
      const [listed] = await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID);
      expect(listed).toMatchObject({ id: worktree.id, missing: true, status: null });

      expect(await invoke<GitOpResult>(IPC.worktrees.prune, PROJECT_ID)).toMatchObject({
        ok: true,
      });
      expect(await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID)).toEqual([]);
      expect(saved()).toEqual([]);
    });

    it('forgets a worktree removed with git directly', async () => {
      const worktree = await create('feat');
      // --force because the fixture's git skips the system config: where that config turns on
      // autocrlf, the app's checkout has CRLF files that this git reads as modified.
      repo.git('worktree', 'remove', '--force', worktree.path);
      expect(await invoke<WorktreeInfo[]>(IPC.worktrees.list, PROJECT_ID)).toEqual([]);
    });
  });

  describe('local files', () => {
    it('previews and copies local files into a new worktree', async () => {
      writeTree(repo.dir, { '.env': 'SECRET=1' });
      expect(await invoke(IPC.worktrees.previewCopy, PROJECT_ID, null)).toEqual(['.env']);
      expect(await invoke(IPC.worktrees.previewCopy, PROJECT_ID, ['*.md'])).toEqual([]);

      const worktree = await create('feat');
      expect(await invoke(IPC.worktrees.copyFiles, PROJECT_ID, worktree.id, ['.env'])).toEqual([
        '.env',
      ]);
      expect(readFileSync(join(worktree.path, '.env'), 'utf8')).toBe('SECRET=1');
    });
  });

  describe('remove', () => {
    it('reports what would be lost', async () => {
      const worktree = await create('feat');
      writeTree(worktree.path, { 'a.txt': 'a' });
      expect(
        await invoke<WorktreeRemovePreflight>(
          IPC.worktrees.removePreflight,
          PROJECT_ID,
          worktree.id,
        ),
      ).toEqual({
        branch: 'feat',
        baseBranch: 'main',
        missing: false,
        changes: 1,
        ahead: 0,
        unpushed: null,
        merged: true,
      });
    });

    it('removes the folder and the record, and deletes the branch when asked', async () => {
      const worktree = await create('feat');
      const result = await invoke<GitOpResult>(IPC.worktrees.remove, {
        projectId: PROJECT_ID,
        worktreeId: worktree.id,
        force: false,
        deleteBranch: true,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(worktree.path)).toBe(false);
      expect(saved()).toEqual([]);
      expect(repo.git('branch', '--list', 'feat').trim()).toBe('');
    });

    it('keeps uncommitted work unless forced', async () => {
      const worktree = await create('feat');
      writeTree(worktree.path, { 'wip.txt': 'x' });
      const input = { projectId: PROJECT_ID, worktreeId: worktree.id, deleteBranch: false };
      expect(await invoke<GitOpResult>(IPC.worktrees.remove, { ...input, force: false })).toEqual({
        ok: false,
        message: expect.stringMatching(/uncommitted/),
      });
      expect(saved()).toHaveLength(1);
      expect((await invoke<GitOpResult>(IPC.worktrees.remove, { ...input, force: true })).ok).toBe(
        true,
      );
    });
  });

  describe('merge', () => {
    it('merges a finished branch into its base', async () => {
      const worktree = await create('feat');
      writeTree(worktree.path, { 'feature.txt': 'x' });
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['-C', worktree.path, 'add', '.'], { stdio: 'pipe' });
      execFileSync('git', ['-C', worktree.path, 'commit', '-m', 'feature'], { stdio: 'pipe' });

      expect(
        await invoke<WorktreeMergePreflight>(IPC.worktrees.mergePreflight, PROJECT_ID, worktree.id),
      ).toEqual({ ok: true });
      expect(
        await invoke<WorktreeMergeResult>(IPC.worktrees.merge, PROJECT_ID, worktree.id),
      ).toMatchObject({ ok: true });
      expect(existsSync(join(repo.dir, 'feature.txt'))).toBe(true);
    });

    it('brings the base into the worktree', async () => {
      const worktree = await create('feat');
      writeTree(repo.dir, { 'main.txt': 'x' });
      repo.commitAll('main moved');
      expect(
        await invoke<WorktreeMergeResult>(IPC.worktrees.mergeBaseIn, PROJECT_ID, worktree.id),
      ).toMatchObject({ ok: true });
      expect(existsSync(join(worktree.path, 'main.txt'))).toBe(true);
    });
  });

  describe('branch suggestions', () => {
    it('turns a task into a clean branch name', async () => {
      headless.runHeadlessCliPrompt.mockResolvedValue({
        ok: true,
        text: '`Feat/Add Login Page`\nsome chatter',
        cliName: 'Claude Code',
      });
      const result = await invoke<SuggestGitTextResult>(
        IPC.worktrees.suggestBranch,
        PROJECT_ID,
        'Add a login page with email and password',
        'req-1',
      );
      expect(result).toEqual({ ok: true, text: 'feat/add-login-page', cliName: 'Claude Code' });
      const [prompt, cwd, options] = headless.runHeadlessCliPrompt.mock.calls[0] ?? [];
      expect(prompt).toContain('Add a login page with email and password');
      expect(cwd).toBe(repo.dir);
      expect(options).toMatchObject({ requestId: 'req-1' });
    });

    it('passes a failure through and can be cancelled', async () => {
      headless.runHeadlessCliPrompt.mockResolvedValue({
        ok: false,
        text: '',
        cliName: null,
        error: 'No CLI installed.',
      });
      expect(
        await invoke<SuggestGitTextResult>(IPC.worktrees.suggestBranch, PROJECT_ID, 'x', 'r'),
      ).toMatchObject({ ok: false, error: 'No CLI installed.' });
      expect(await invoke(IPC.worktrees.cancelSuggestBranch, 'r')).toBe(true);
    });
  });
});
