import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasGit, initGitRepo } from '../../test/main/fixtures';
import {
  BRANCH_NAME_PATTERN,
  createBranch,
  currentBranch,
  detectDefaultBranch,
  isGitLockBusy,
  isGitRepo,
  listBranches,
  parseStatusPorcelain,
  primaryRemote,
  readCommitSubjects,
  readStatus,
  readTagInfo,
  recentDays,
  renameBranch,
  git as runGit,
  runGitOp,
  safeBranchName,
  TAG_NAME_PATTERN,
} from './plumbing';

/**
 * The git layer the whole Git panel is built on. Two halves:
 *
 * The parsing and validation helpers are pure, and the name checks in particular are a security
 * boundary: a branch name that starts with a dash is read by git as an option, which turns a
 * checkout into running a command of the attacker's choosing.
 *
 * The rest talks to a real `git` in a temp repository, because the whole point of this module is
 * agreeing with git's actual output rather than with a mock of it.
 */

const git = hasGit();

describe('parseStatusPorcelain', () => {
  // Fields come back NUL separated, which is what stops git from octal-quoting non-ASCII names.
  const entry = (status: string, path: string): string => `${status} ${path}\0`;

  it('reads the two status columns and the path', () => {
    const output = `${entry('M ', 'src/app.ts')}${entry(' M', 'README.md')}${entry('??', 'new.txt')}`;

    expect(parseStatusPorcelain(output)).toEqual([
      { x: 'M', y: ' ', path: 'src/app.ts' },
      { x: ' ', y: 'M', path: 'README.md' },
      { x: '?', y: '?', path: 'new.txt' },
    ]);
  });

  it('skips the second path of a rename and of a copy', () => {
    // A rename is written as two fields: the new path, then the old one. Treating the old path as
    // its own entry would show the file twice in the panel.
    const renamed = `R  after.ts\0before.ts\0`;
    const copied = `C  copy.ts\0origin.ts\0`;

    expect(parseStatusPorcelain(renamed + copied)).toEqual([
      { x: 'R', y: ' ', path: 'after.ts' },
      { x: 'C', y: ' ', path: 'copy.ts' },
    ]);
  });

  it('handles a rename recorded in the worktree column', () => {
    expect(parseStatusPorcelain(` R after.ts\0before.ts\0`)).toEqual([
      { x: ' ', y: 'R', path: 'after.ts' },
    ]);
  });

  it('keeps spaces and non-ASCII characters in paths', () => {
    const output = `${entry('M ', 'src/my folder/файл ру.ts')}${entry('??', 'docs/نمونه.md')}`;

    expect(parseStatusPorcelain(output).map((change) => change.path)).toEqual([
      'src/my folder/файл ру.ts',
      'docs/نمونه.md',
    ]);
  });

  it('reads a conflict as both columns being unmerged', () => {
    expect(parseStatusPorcelain(entry('UU', 'conflict.ts'))).toEqual([
      { x: 'U', y: 'U', path: 'conflict.ts' },
    ]);
  });

  it('returns nothing for empty output or trailing separators', () => {
    expect(parseStatusPorcelain('')).toEqual([]);
    expect(parseStatusPorcelain('\0\0')).toEqual([]);
    // Too short to be a status line at all.
    expect(parseStatusPorcelain('M\0')).toEqual([]);
  });
});

describe('safeBranchName', () => {
  it('collapses whitespace into dashes', () => {
    expect(safeBranchName('  feature   new thing  ')).toBe('feature-new-thing');
  });

  it.each([
    ['--upload-pack=calc.exe', 'anything git would read as an option'],
    ['-x', 'a single leading dash'],
    ['feature..old', 'the range operator'],
    ['feature~1', 'a revision suffix'],
    ['branch@{upstream}', 'a reflog selector'],
    ['bad:name', 'a colon'],
    ['what?', 'a glob character'],
    ['back\\slash', 'a backslash'],
    ['.hidden', 'a leading dot'],
    ['', 'nothing at all'],
    ['   ', 'only whitespace'],
  ])('refuses %j (%s)', (name) => {
    expect(() => safeBranchName(name)).toThrow();
  });

  it.each(['main', 'feature/login', 'release-1.2.3', 'user_name/fix', 'v2'])(
    'accepts %j',
    (name) => {
      expect(safeBranchName(name)).toBe(name);
    },
  );
});

describe('name patterns', () => {
  it('lets a branch start only with a letter or digit', () => {
    expect(BRANCH_NAME_PATTERN.test('1-fix')).toBe(true);
    expect(BRANCH_NAME_PATTERN.test('-fix')).toBe(false);
    expect(BRANCH_NAME_PATTERN.test('/fix')).toBe(false);
  });

  it('allows the npm style of package tag', () => {
    // Monorepos tag packages as @acme/web@1.4.0, so the pattern has to take @ and +.
    expect(TAG_NAME_PATTERN.test('@acme/web@1.4.0')).toBe(true);
    expect(TAG_NAME_PATTERN.test('v1.2.3+build.5')).toBe(true);
    expect(TAG_NAME_PATTERN.test('-v1.2.3')).toBe(false);
    expect(TAG_NAME_PATTERN.test('v1 2')).toBe(false);
  });
});

describe('recentDays', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills a trailing window that ends today, oldest first', () => {
    // Local dates, not UTC: the grid has to match the calendar the user is looking at.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 15, 30));

    const grid = recentDays(new Map([['2026-09-16', 4]]), 3);

    expect(grid).toEqual([
      { date: '2026-09-15', count: 0 },
      { date: '2026-09-16', count: 4 },
      { date: '2026-09-17', count: 0 },
    ]);
  });

  it('pads single-digit months and days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 9, 0));

    expect(recentDays(new Map(), 2).map((day) => day.date)).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('draws an empty grid from an empty map', () => {
    const grid = recentDays(new Map(), 84);

    expect(grid).toHaveLength(84);
    expect(grid.every((day) => day.count === 0)).toBe(true);
  });

  it('ignores counts outside the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17));

    const grid = recentDays(new Map([['2020-01-01', 99]]), 2);

    expect(grid.some((day) => day.count === 99)).toBe(false);
  });
});

describe('runGitOp', () => {
  it('reports success with the command output', async () => {
    expect(await runGitOp(async () => 'done')).toEqual({ ok: true, message: 'done' });
  });

  it('turns a thrown error into a failure a dialog can show', async () => {
    const result = await runGitOp(async () => {
      throw new Error('fatal: not a git repository');
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a git repository');
  });
});

describe.skipIf(!git)('against a real repository', () => {
  it('reads the branch, the clean state and then the dirty state', async () => {
    const repo = initGitRepo({ 'README.md': '# demo\n' });

    expect(await isGitRepo(repo.dir)).toBe(true);
    expect(await currentBranch(repo.dir)).toBe('main');

    const clean = await readStatus(repo.dir);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.files).toEqual([]);
    expect(clean.hasRemote).toBe(false);

    writeFileSync(join(repo.dir, 'README.md'), '# demo\nchanged\n', 'utf-8');
    writeFileSync(join(repo.dir, 'untracked.txt'), 'new\n', 'utf-8');

    const dirty = await readStatus(repo.dir);
    const paths = dirty.files.map((file) => file.path).sort();
    expect(paths).toEqual(['README.md', 'untracked.txt']);
  });

  it('says a plain folder is not a repository', async () => {
    const repo = initGitRepo();
    const outside = join(repo.dir, '..');

    expect(await isGitRepo(join(outside, 'definitely-not-here'))).toBe(false);
  });

  it('creates, lists and renames branches', async () => {
    const repo = initGitRepo();

    await createBranch(repo.dir, 'feature/login');
    expect(await currentBranch(repo.dir)).toBe('feature/login');

    const branches = await listBranches(repo.dir);
    expect(branches.map((branch) => branch.name).sort()).toEqual(['feature/login', 'main']);
    expect(branches.find((branch) => branch.name === 'feature/login')?.local).toBe(true);

    // The last argument says whether to rename the branch on the remote too, and there is
    // no remote here.
    await renameBranch(repo.dir, 'feature/login', 'feature/signin', false);
    expect(await currentBranch(repo.dir)).toBe('feature/signin');
  });

  it('refuses an option-shaped branch name before git ever sees it', async () => {
    const repo = initGitRepo();

    await expect(createBranch(repo.dir, '--upload-pack=calc.exe')).rejects.toThrow(
      /Invalid branch name/,
    );
  });

  it('falls back to the checked-out branch with no remote to ask', async () => {
    const repo = initGitRepo();

    expect(await primaryRemote(repo.dir)).toBeNull();
    expect(await detectDefaultBranch(repo.dir)).toBe('main');
  });

  it('reads tags and the commit subjects since the last one', async () => {
    const repo = initGitRepo();
    repo.git('tag', 'v1.0.0');
    writeFileSync(join(repo.dir, 'feature.ts'), 'export const a = 1;\n', 'utf-8');
    repo.commitAll('feat: add a feature');
    writeFileSync(join(repo.dir, 'fix.ts'), 'export const b = 2;\n', 'utf-8');
    repo.commitAll('fix: correct a mistake');

    const tags = await readTagInfo(repo.dir);
    expect(tags.latestTag).toBe('v1.0.0');
    expect(tags.recentTags).toEqual(['v1.0.0']);
    expect(tags.commitsSinceLatestTag).toBe(2);

    const subjects = await readCommitSubjects(repo.dir, 'v1.0.0');
    expect(subjects).toContain('feat: add a feature');
    expect(subjects).toContain('fix: correct a mistake');
    // The tagged commit itself is already released, so it is not in the list.
    expect(subjects).not.toContain('first commit');
  });
});

describe.skipIf(!git)('the environment git() runs with', () => {
  afterEach(() => {
    delete process.env.AGENTMATE_GIT_ENV_PROBE;
  });

  it('is read at call time, so a PATH or proxy set after startup reaches git', async () => {
    const repo = initGitRepo();
    // An alias that prints a variable, run by the git child itself.
    const probe = ['-c', 'alias.probe=!echo "$AGENTMATE_GIT_ENV_PROBE"', 'probe'];

    process.env.AGENTMATE_GIT_ENV_PROBE = 'set-after-import';

    expect((await runGit(repo.dir, probe)).trim()).toBe('set-after-import');
  });

  it('still turns credential prompts off', async () => {
    const repo = initGitRepo();
    const probe = ['-c', 'alias.probe=!echo "$GIT_TERMINAL_PROMPT"', 'probe'];

    expect((await runGit(repo.dir, probe)).trim()).toBe('0');
  });
});

describe('isGitLockBusy', () => {
  it('spots git refusing to run because another process holds a lock', () => {
    const indexLock = {
      stderr:
        "fatal: Unable to create 'E:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
    };
    const refLock = {
      stderr:
        "error: cannot lock ref 'HEAD': Unable to create 'E:/repo/.git/HEAD.lock': File exists.",
    };

    expect(isGitLockBusy(indexLock)).toBe(true);
    expect(isGitLockBusy(refLock)).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isGitLockBusy({ stderr: 'fatal: not a git repository' })).toBe(false);
    expect(isGitLockBusy(new Error('spawn git ENOENT'))).toBe(false);
    expect(isGitLockBusy(null)).toBe(false);
  });
});

describe.skipIf(!git)('git() while another process holds the index lock', () => {
  // The version bump's commit used to fail at random: a `git status` from the repo watcher, an
  // editor or an agent held .git/index.lock for a moment, and `git add` gave up on the spot.

  it('waits for a lock that goes away and then runs', async () => {
    const repo = initGitRepo();
    writeFileSync(join(repo.dir, 'package.json'), '{ "version": "1.1.0" }\n', 'utf-8');
    const lock = join(repo.dir, '.git', 'index.lock');
    writeFileSync(lock, '', 'utf-8');
    const release = setTimeout(() => rmSync(lock, { force: true }), 250);

    try {
      await runGit(repo.dir, ['add', '-A']);
      await runGit(repo.dir, ['commit', '-m', 'chore(release): bump version to 1.1.0']);
    } finally {
      clearTimeout(release);
    }

    expect(repo.git('status', '--porcelain').trim()).toBe('');
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe(
      'chore(release): bump version to 1.1.0',
    );
  });

  it("gives up with git's own message when the lock never goes away", async () => {
    const repo = initGitRepo();
    writeFileSync(join(repo.dir, 'package.json'), '{ "version": "1.1.0" }\n', 'utf-8');
    writeFileSync(join(repo.dir, '.git', 'index.lock'), '', 'utf-8');

    await expect(runGit(repo.dir, ['add', '-A'])).rejects.toMatchObject({
      stderr: expect.stringMatching(/index\.lock'?: File exists/),
    });
  });
});
