import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The status bar polls this to show who the GitHub CLI is signed in as. What matters is that a
 * dropped connection never reads as "signed out", because the bar would then tell someone who is
 * signed in to sign in again.
 */

const cli = vi.hoisted(() => ({
  available: true,
  api: vi.fn(),
}));

vi.mock('./githubCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./githubCli')>();
  return {
    ...actual,
    isGhCliAvailable: async () => cli.available,
    ghApi: cli.api,
  };
});

const { readGithubAccount } = await import('./githubAccount');

function ghFailure(stderr: string): Error {
  return Object.assign(new Error('Command failed: gh api user'), { stderr });
}

describe('readGithubAccount', () => {
  beforeEach(() => {
    cli.available = true;
    cli.api.mockReset();
  });

  it('reports a missing CLI without calling GitHub', async () => {
    cli.available = false;

    expect(await readGithubAccount()).toEqual({
      cliAvailable: false,
      authenticated: false,
      login: null,
      owners: [],
    });
    expect(cli.api).not.toHaveBeenCalled();
  });

  it('returns the login, the profile name and the organizations', async () => {
    cli.api.mockImplementation(async (path: string) =>
      path === 'user' ? { login: 'octocat', name: ' The Octocat ' } : [{ login: 'github' }],
    );

    expect(await readGithubAccount()).toEqual({
      cliAvailable: true,
      authenticated: true,
      login: 'octocat',
      name: 'The Octocat',
      owners: [
        { login: 'octocat', type: 'user' },
        { login: 'github', type: 'organization' },
      ],
    });
  });

  it('leaves the name empty when the profile has none', async () => {
    cli.api.mockImplementation(async (path: string) =>
      path === 'user' ? { login: 'octocat', name: null } : [],
    );

    expect((await readGithubAccount()).name).toBeNull();
  });

  it('still names the account when listing organizations is not allowed', async () => {
    cli.api.mockImplementation(async (path: string) => {
      if (path === 'user') return { login: 'octocat', name: null };
      throw ghFailure('HTTP 403: Resource not accessible');
    });

    const account = await readGithubAccount();

    expect(account.authenticated).toBe(true);
    expect(account.owners).toEqual([{ login: 'octocat', type: 'user' }]);
  });

  it('is not a failed check when nobody is signed in', async () => {
    cli.api.mockRejectedValue(
      ghFailure('To get started with GitHub CLI, please run:  gh auth login'),
    );

    const account = await readGithubAccount();

    expect(account).toMatchObject({ cliAvailable: true, authenticated: false, login: null });
    expect(account.checkFailed).toBe(false);
  });

  it('is not a failed check when the token was rejected', async () => {
    cli.api.mockRejectedValue(ghFailure('gh: Bad credentials (HTTP 401)'));

    expect((await readGithubAccount()).checkFailed).toBe(false);
  });

  it('marks a network failure so it is not mistaken for a sign-out', async () => {
    cli.api.mockRejectedValue(
      ghFailure('error connecting to api.github.com: TLS handshake timeout'),
    );

    const account = await readGithubAccount();

    expect(account.authenticated).toBe(false);
    expect(account.checkFailed).toBe(true);
    expect(account.error).toContain('TLS handshake timeout');
  });
});
