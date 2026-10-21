import type { GithubAccount } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { GithubAccountSegment } = await import('./GithubAccountSegment');

/**
 * The GitHub account item in the status bar. Pull requests and workflow runs go out under whatever
 * account the CLI is signed in as, so the bar names it. The cases that matter: it stays out of the
 * way when there is no CLI, signed out is a quiet prompt rather than an alarm, and a failed
 * refresh never turns a signed-in account into "sign in again".
 */

const SIGNED_IN: GithubAccount = {
  cliAvailable: true,
  authenticated: true,
  login: 'octocat',
  name: 'The Octocat',
  owners: [
    { login: 'octocat', type: 'user' },
    { login: 'github', type: 'organization' },
  ],
};

const SIGNED_OUT: GithubAccount = {
  cliAvailable: true,
  authenticated: false,
  login: null,
  owners: [],
  error: 'To get started with GitHub CLI, please run:  gh auth login',
  checkFailed: false,
};

const OFFLINE: GithubAccount = {
  cliAvailable: true,
  authenticated: false,
  login: null,
  owners: [],
  error: 'error connecting to api.github.com: TLS handshake timeout',
  checkFailed: true,
};

function setup(answer: GithubAccount | (() => Promise<GithubAccount>)) {
  const view = renderWithProviders(<GithubAccountSegment />, {
    bridge: { 'git.githubAccount': answer },
  });
  /** The first answer has landed, so "nothing is shown" means it, not "not loaded yet". */
  const settled = () =>
    waitFor(() =>
      expect(view.queryClient.getQueryState(queryKeys.githubAccount)?.status).toBe('success'),
    );
  return { ...view, settled };
}

beforeEach(() => {
  toast.info.mockClear();
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

describe('the GitHub account status bar entry', () => {
  it('stays out of the bar when the GitHub CLI is not installed', async () => {
    const { settled } = setup({
      cliAvailable: false,
      authenticated: false,
      login: null,
      owners: [],
    });
    await settled();

    expect(screen.queryByLabelText(/^GitHub/)).not.toBeInTheDocument();
  });

  it('names the account the CLI is signed in as', async () => {
    setup(SIGNED_IN);

    expect(await screen.findByLabelText('GitHub: signed in as octocat')).toHaveTextContent(
      '@octocat',
    );
  });

  it('opens the profile name, the login and the organizations', async () => {
    const { user } = setup(SIGNED_IN);

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('The Octocat')).toBeInTheDocument();
    expect(within(panel).getByText('@octocat')).toBeInTheDocument();
    expect(within(panel).getByText('github')).toBeInTheDocument();
  });

  it('shows the login once when the profile has no name', async () => {
    const { user } = setup({ ...SIGNED_IN, name: null });

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getAllByText(/octocat/)).toHaveLength(1);
  });

  it('opens the profile on GitHub', async () => {
    const { user, bridge } = setup(SIGNED_IN);

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));
    await user.click(within(await screen.findByRole('dialog')).getByText('Open profile'));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('https://github.com/octocat');
  });

  it('starts the sign-in in a terminal for another account', async () => {
    const { user } = setup(SIGNED_IN);

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));
    await user.click(within(await screen.findByRole('dialog')).getByText('Use another account'));

    expect(useTerminalStore.getState().sessions).toEqual([
      expect.objectContaining({ title: 'GitHub login', initialInput: 'gh auth login' }),
    ]);
    expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to sign in to GitHub.');
  });

  it('asks to sign in without raising an alarm when nobody is signed in', async () => {
    const { user } = setup(SIGNED_OUT);

    const item = await screen.findByLabelText('GitHub: not signed in');
    expect(item).toHaveTextContent('Not signed in');
    expect(item).not.toHaveClass('text-warning');

    await user.click(item);
    await user.click(within(await screen.findByRole('dialog')).getByText('Sign in with gh'));

    expect(useTerminalStore.getState().sessions).toEqual([
      expect.objectContaining({ initialInput: 'gh auth login' }),
    ]);
  });

  it('does not call a dropped connection a sign-out', async () => {
    setup(OFFLINE);

    const item = await screen.findByLabelText('GitHub: could not check the sign-in');
    expect(item).toHaveClass('text-warning');
    expect(screen.queryByLabelText('GitHub: not signed in')).not.toBeInTheDocument();
  });

  it('keeps the last known account, flagged, when a refresh fails', async () => {
    const answers = [SIGNED_IN, OFFLINE];
    const { user } = setup(async () => answers.shift() ?? OFFLINE);

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));
    await user.click(await screen.findByLabelText('Check the GitHub sign-in again'));

    const item = await screen.findByLabelText('GitHub: signed in as octocat, could not refresh');
    expect(item).toHaveTextContent('@octocat');
    expect(
      within(await screen.findByRole('dialog')).getByText(/TLS handshake timeout/),
    ).toBeVisible();
  });

  it('forgets the account once the CLI plainly says it is signed out', async () => {
    const answers = [SIGNED_IN, SIGNED_OUT, OFFLINE];
    const { user } = setup(async () => answers.shift() ?? OFFLINE);

    await user.click(await screen.findByLabelText('GitHub: signed in as octocat'));
    await user.click(await screen.findByLabelText('Check the GitHub sign-in again'));
    await screen.findByLabelText('GitHub: not signed in');
    await user.click(await screen.findByLabelText('Check the GitHub sign-in again'));

    // A blip after a real sign-out must not bring the old account back.
    expect(await screen.findByLabelText('GitHub: could not check the sign-in')).toBeVisible();
    expect(screen.queryByLabelText(/signed in as octocat/)).not.toBeInTheDocument();
  });

  it('recovers once a later check succeeds', async () => {
    const answers = [OFFLINE, SIGNED_IN];
    const { user } = setup(async () => answers.shift() ?? SIGNED_IN);

    await user.click(await screen.findByLabelText('GitHub: could not check the sign-in'));
    await user.click(await screen.findByLabelText('Check the GitHub sign-in again'));

    expect(await screen.findByLabelText('GitHub: signed in as octocat')).toBeInTheDocument();
  });
});
