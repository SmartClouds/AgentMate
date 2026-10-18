import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import {
  attachFolderToRemote,
  cloneIntoFolder,
  cloneOrAttach,
  describeCloneError,
  githubCredentialArgs,
} from './cloneRepo';
import { git as runGit } from './plumbing';

// No gh sign-in here: every clone goes through plain git against a local bare repo.
vi.mock('./githubCli', () => ({
  runGh: vi.fn(async () => {
    throw new Error('gh: not logged in');
  }),
}));

const git = hasGit();

/** A bare repo with one commit on main, standing in for the GitHub remote. */
function bareRemote(files: Record<string, string> = { 'README.md': '# remote\n' }): string {
  const source = initGitRepo(files);
  const bare = join(tempDir('agentmate-bare-'), 'remote.git');
  source.git('clone', '--bare', source.dir, bare);
  return bare;
}

describe('describeCloneError', () => {
  it('maps the common failures to something actionable', () => {
    expect(describeCloneError({ stderr: 'remote: Repository not found.' })).toMatch(/not found/i);
    expect(
      describeCloneError({
        stderr:
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      }),
    ).toMatch(/gh auth login/);
    expect(describeCloneError({ killed: true, stderr: "Cloning into '.'...\n" })).toMatch(
      /too long/,
    );
  });

  it('skips git\'s "Cloning into" banner and reports the actual reason', () => {
    expect(
      describeCloneError({
        stderr:
          "Cloning into '.'...\nfatal: unable to access 'x': Could not resolve host: github.com\n",
      }),
    ).toBe("fatal: unable to access 'x': Could not resolve host: github.com");
    expect(describeCloneError({ stderr: "Cloning into '.'...\n" })).toMatch(/Clone failed/);
  });

  it('points an ssh key failure at the sign-in fix too', () => {
    expect(
      describeCloneError({ stderr: 'git@github.com: Permission denied (publickey).' }),
    ).toMatch(/gh auth login/);
  });
});

describe('githubCredentialArgs', () => {
  it('adds nothing when gh is not signed in', async () => {
    expect(await githubCredentialArgs()).toEqual([]);
  });
});

describe.skipIf(!git)('cloneIntoFolder', () => {
  it('clones into a folder that does not exist yet', async () => {
    const remote = bareRemote();
    const folder = join(tempDir(), 'new-project');

    const outcome = await cloneIntoFolder(folder, remote);

    expect(outcome).toMatchObject({ ok: true, mode: 'cloned' });
    // core.autocrlf on Windows may check it out with CRLF.
    expect(readFileSync(join(folder, 'README.md'), 'utf-8').trimEnd()).toBe('# remote');
  });

  it('refuses a folder with files in it', async () => {
    const folder = writeTree(tempDir(), { 'notes.txt': 'mine\n' });

    const outcome = await cloneIntoFolder(folder, bareRemote());

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not empty/);
    expect(readFileSync(join(folder, 'notes.txt'), 'utf-8')).toBe('mine\n');
  });

  it('leaves the folder empty after a failed clone, so a retry is not blocked', async () => {
    const folder = tempDir();

    const outcome = await cloneIntoFolder(folder, join(tempDir(), 'missing.git'));

    expect(outcome.ok).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe.skipIf(!git)('attachFolderToRemote', () => {
  it('keeps every local file and shows differences as changes', async () => {
    const remote = bareRemote({ 'README.md': '# remote\n', 'src/app.ts': 'export {};\n' });
    const folder = writeTree(tempDir(), {
      'README.md': '# local edit\n',
      'src/app.ts': 'export {};\n',
      'local-only.txt': 'keep me\n',
    });

    const outcome = await attachFolderToRemote(folder, remote);

    expect(outcome).toMatchObject({ ok: true, mode: 'attached' });
    expect(readFileSync(join(folder, 'README.md'), 'utf-8')).toBe('# local edit\n');
    expect(readFileSync(join(folder, 'local-only.txt'), 'utf-8')).toBe('keep me\n');

    expect((await runGit(folder, ['branch', '--show-current'])).trim()).toBe('main');
    expect((await runGit(folder, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim()).toBe(
      'origin/main',
    );
    const status = await runGit(folder, ['status', '--porcelain']);
    expect(status).toContain(' M README.md');
    expect(status).toContain('?? local-only.txt');
    expect(status).not.toContain('src/app.ts');
  });

  it('removes the .git it created when the fetch fails', async () => {
    const folder = writeTree(tempDir(), { 'README.md': '# local\n' });

    const outcome = await attachFolderToRemote(folder, join(tempDir(), 'missing.git'));

    expect(outcome.ok).toBe(false);
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(readdirSync(folder)).toEqual(['README.md']);
  });

  it('connects origin to a remote with no commits yet', async () => {
    const bare = join(tempDir(), 'empty.git');
    mkdirSync(bare);
    await runGit(bare, ['init', '--bare']);
    const folder = writeTree(tempDir(), { 'README.md': '# local\n' });

    const outcome = await attachFolderToRemote(folder, bare);

    expect(outcome).toMatchObject({ ok: true, mode: 'attached' });
    expect(outcome.message).toMatch(/no commits/);
    expect((await runGit(folder, ['remote', 'get-url', 'origin'])).trim()).toBe(bare);
  });
});

describe.skipIf(!git)('cloneOrAttach', () => {
  it('asks before touching a folder that has files', async () => {
    const folder = writeTree(tempDir(), { 'README.md': '# local\n' });

    const outcome = await cloneOrAttach(folder, bareRemote(), false);

    expect(outcome).toMatchObject({ ok: false, needsAttachConfirm: true });
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });

  it('clones into an empty folder and skips one that is already a repo', async () => {
    const remote = bareRemote();
    const empty = tempDir();
    writeFileSync(join(empty, 'Thumbs.db'), '');

    expect(await cloneOrAttach(empty, remote, false)).toMatchObject({ ok: true, mode: 'cloned' });
    expect(await cloneOrAttach(empty, remote, false)).toMatchObject({ ok: true, mode: 'skipped' });
  });
});
