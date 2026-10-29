import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Auto-fix commits with `add -A` on the user's own checkout, so before an agent starts the tree
 * has to be clean and on the run's branch: otherwise the user's unrelated work would be swept
 * into the fix and pushed. Every refusal says what to do about it.
 */

interface GitCall {
  cwd: string;
  args: string[];
}

const fake = vi.hoisted(() => ({
  calls: [] as GitCall[],
  branch: 'main',
  status: '',
  head: 'aaa1111',
  /** Commands that fail, by their first argument, with what git printed. */
  fails: new Map<string, string>(),
  ancestor: true,
  /** `pull --ff-only` brings the run's commit in. */
  pullBringsIt: true,
  pushes: [] as string[],
  commitMakes: 'bbb2222',
}));

vi.mock('../../git/plumbing', () => ({
  currentBranch: async () => fake.branch,
  git: async (cwd: string, args: string[]) => {
    fake.calls.push({ cwd, args });
    const failure = fake.fails.get(args[0]);
    if (failure !== undefined) throw Object.assign(new Error('git failed'), { stderr: failure });
    switch (args[0]) {
      case 'status':
        return fake.status;
      case 'rev-parse':
        return `${fake.head}\n`;
      case 'merge-base':
        if (!fake.ancestor) throw Object.assign(new Error('not ancestor'), { stderr: '' });
        return '';
      case 'pull':
        if (fake.pullBringsIt) fake.ancestor = true;
        return '';
      case 'commit':
        fake.head = fake.commitMakes;
        fake.status = '';
        return '';
      default:
        return '';
    }
  },
  pushCurrentBranch: async (cwd: string, branch: string) => {
    const failure = fake.fails.get('push');
    if (failure !== undefined) throw Object.assign(new Error('push failed'), { stderr: failure });
    fake.pushes.push(`${cwd}:${branch}`);
    return '';
  },
}));

const { autoFixCommitMessage, commitAutoFix, preflightAutoFix } = await import('./git');

beforeEach(() => {
  fake.calls = [];
  fake.branch = 'main';
  fake.status = '';
  fake.head = 'aaa1111';
  fake.fails = new Map();
  fake.ancestor = true;
  fake.pullBringsIt = true;
  fake.pushes = [];
  fake.commitMakes = 'bbb2222';
});

const ran = (command: string) => fake.calls.filter((call) => call.args[0] === command);

describe('preflightAutoFix', () => {
  it('passes on a clean tree on the run branch and remembers HEAD', async () => {
    await expect(preflightAutoFix('/work/shop', 'main', 'abc')).resolves.toEqual({
      ok: true,
      baseSha: 'aaa1111',
    });
    expect(ran('merge-base')[0].args).toEqual(['merge-base', '--is-ancestor', 'abc', 'HEAD']);
  });

  it('refuses another branch and names both', async () => {
    fake.branch = 'feature/cart';
    const result = await preflightAutoFix('/work/shop', 'main', 'abc');
    expect(result).toEqual({
      ok: false,
      blocker: 'wrong-branch',
      message:
        'The project is on feature/cart, but the run is on main. Switch to main, then press Retry.',
    });
  });

  it('refuses a detached HEAD', async () => {
    fake.branch = '';
    const result = await preflightAutoFix('/work/shop', 'main', 'abc');
    expect(result).toMatchObject({ ok: false, blocker: 'wrong-branch' });
    if (!result.ok) expect(result.message).toMatch(/^The project is not on a branch/);
  });

  it('refuses uncommitted changes so they stay out of the fix', async () => {
    fake.status = ' M src/cart.ts\n';
    const result = await preflightAutoFix('/work/shop', 'main', 'abc');
    expect(result).toMatchObject({ ok: false, blocker: 'dirty-tree' });
    if (!result.ok) expect(result.message).toMatch(/uncommitted changes/);
  });

  it('fast-forwards when the checkout is behind the commit the run tested', async () => {
    fake.ancestor = false;
    await expect(preflightAutoFix('/work/shop', 'main', 'abc')).resolves.toMatchObject({
      ok: true,
    });
    expect(ran('pull')[0].args).toEqual(['pull', '--ff-only']);
  });

  it('refuses when even a fast-forward does not bring the commit in', async () => {
    fake.ancestor = false;
    fake.pullBringsIt = false;
    const result = await preflightAutoFix('/work/shop', 'main', 'abcdef1234567');
    expect(result).toMatchObject({ ok: false, blocker: 'behind' });
    if (!result.ok) expect(result.message).toContain('abcdef1');
  });

  it('refuses when the pull itself fails, as on a diverged branch', async () => {
    fake.ancestor = false;
    fake.fails.set('pull', 'fatal: Not possible to fast-forward, aborting.');
    const result = await preflightAutoFix('/work/shop', 'main', 'abc');
    expect(result).toMatchObject({ ok: false, blocker: 'behind' });
  });
});

describe('commitAutoFix', () => {
  const input = { branch: 'main', baseSha: 'aaa1111', message: 'fix(ci): CI' };

  it('commits everything the agent changed and pushes it', async () => {
    fake.status = ' M src/cart.ts\n?? src/cart.test.ts\n';
    await expect(commitAutoFix('/work/shop', input)).resolves.toEqual({
      kind: 'pushed',
      sha: 'bbb2222',
    });
    expect(ran('add')[0].args).toEqual(['add', '-A']);
    expect(ran('commit')[0].args).toEqual(['commit', '-m', 'fix(ci): CI']);
    expect(fake.pushes).toEqual(['/work/shop:main']);
  });

  it('pushes a commit the agent made itself without committing again', async () => {
    fake.head = 'ccc3333';
    await expect(commitAutoFix('/work/shop', input)).resolves.toEqual({
      kind: 'pushed',
      sha: 'ccc3333',
    });
    expect(ran('commit')).toEqual([]);
  });

  it('reports no change when the tree is clean and HEAD did not move', async () => {
    await expect(commitAutoFix('/work/shop', input)).resolves.toEqual({ kind: 'no-change' });
    expect(fake.pushes).toEqual([]);
  });

  it('refuses to commit on a branch the agent switched to', async () => {
    fake.branch = 'oops';
    fake.status = ' M a.ts\n';
    await expect(commitAutoFix('/work/shop', input)).resolves.toMatchObject({
      kind: 'blocked',
      blocker: 'commit-failed',
    });
    expect(ran('commit')).toEqual([]);
  });

  it('passes on what git said when the commit fails, as with a hook', async () => {
    fake.status = ' M a.ts\n';
    fake.fails.set('commit', 'husky - pre-commit hook exited with code 1\n');
    await expect(commitAutoFix('/work/shop', input)).resolves.toEqual({
      kind: 'blocked',
      blocker: 'commit-failed',
      message:
        'The commit failed: husky - pre-commit hook exited with code 1. Commit it yourself, or fix the cause and press Retry.',
    });
  });

  it('says the push was refused, with git first line', async () => {
    fake.status = ' M a.ts\n';
    fake.fails.set('push', ' ! [rejected] main -> main (fetch first)\nerror: failed to push\n');
    await expect(commitAutoFix('/work/shop', input)).resolves.toEqual({
      kind: 'blocked',
      blocker: 'push-failed',
      message:
        'The push was refused: ! [rejected] main -> main (fetch first). Pull the branch, then press Retry to push the fix.',
    });
  });
});

describe('autoFixCommitMessage', () => {
  it('says which workflow and run it fixes, and which try it is', () => {
    expect(
      autoFixCommitMessage({ workflowName: 'CI', runNumber: 7, attempt: 2, maxAttempts: 3 }),
    ).toBe('fix(ci): repair CI failure from run #7 (auto-fix 2/3)');
  });

  it('leaves out the run number when it is unknown', () => {
    expect(
      autoFixCommitMessage({ workflowName: 'Build', runNumber: null, attempt: 1, maxAttempts: 1 }),
    ).toBe('fix(ci): repair Build failure (auto-fix 1/1)');
  });
});
