import type { DeployRegistryCredential } from '@shared/deployRegistryTypes';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { FakeBridge } from '../../../../../test/renderer/runovaBridge';
import { useAppsAccess } from '../apps/hooks';
import { SERVER, signedIn } from '../security/testing/fixtures';

/** The Registries view (E08) through every state: shimmer, empty, lists, each add flow, step-up. */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { RegistriesPanel } = await import('./RegistriesPanel');

const GITHUB: DeployRegistryCredential = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'github',
  source: 'packagesToken',
  registry: 'ghcr.io',
  username: 'octocat',
  scopes: ['read:packages'],
  broaderScopes: [],
  savedAt: 1,
  checkedAt: 1,
  locked: false,
};
const GH_CLI: DeployRegistryCredential = {
  ...GITHUB,
  id: '22222222-2222-4222-8222-222222222222',
  source: 'ghCli',
  registry: 'ghcr.io',
  broaderScopes: ['repo', 'workflow'],
};
const STORED = {
  id: '55555555-5555-4555-8555-555555555555',
  registry: 'docker.io',
  username: 'hubber',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

function Panel(): React.JSX.Element {
  const access = useAppsAccess(SERVER.id);
  if (access.pending) return <p>loading</p>;
  return <RegistriesPanel server={SERVER} access={access} onBack={() => undefined} />;
}

function renderPanel(bridge: Record<string, unknown> = {}, roles = ['owner']) {
  return renderWithProviders(
    <>
      <Panel />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'deploy.access': signedIn(roles),
        'deployRegistry.list': [],
        'deployRegistry.serverList': [],
        ...bridge,
      },
    },
  );
}

describe('RegistriesPanel', () => {
  it('shimmers while the sign-ins load', async () => {
    renderPanel({ 'deployRegistry.list': () => new Promise(() => undefined) });
    await waitFor(() =>
      expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(1),
    );
  });

  it('says what an empty view means', async () => {
    renderPanel();
    expect(
      await screen.findByText(/No sign-ins yet. Public images pull without one./),
    ).toBeVisible();
    expect(screen.getByText(/Nothing is stored on Production/)).toBeVisible();
  });

  it('lists both kinds, marks broad scopes in words and labels what the server stores', async () => {
    renderPanel({ 'deployRegistry.list': [GH_CLI], 'deployRegistry.serverList': [STORED] });
    const local = await screen.findByRole('listitem', { name: 'GitHub Container Registry' });
    expect(within(local).getByText(/GitHub CLI sign-in/)).toBeVisible();
    expect(within(local).getByText('Broad scopes')).toBeVisible();
    const stored = screen.getByRole('listitem', { name: 'Docker Hub, stored on this server' });
    expect(within(stored).getByText(/stored on this server/)).toBeVisible();
    expect(within(stored).getByText(/not used yet/)).toBeVisible();
  });

  it('saves a packages-only token after GitHub checked it', async () => {
    const user = userEvent.setup();
    const { bridge } = renderPanel({
      'deployRegistry.checkGithubToken': {
        username: 'octocat',
        scopes: ['read:packages'],
        canPull: true,
        broaderScopes: [],
        problem: null,
      },
      'deployRegistry.saveGithubToken': GITHUB,
    });
    await user.click(await screen.findByRole('button', { name: /GitHub packages token/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub packages token/ });
    await user.click(within(dialog).getByRole('button', { name: /Open GitHub's token page/ }));
    const url = new URL(
      (bridge as FakeBridge).$fn('shell.openExternal').mock.calls[0][0] as string,
    );
    expect(url.searchParams.get('scopes')).toBe('read:packages');

    await user.type(within(dialog).getByLabelText('Token'), 'ghp_packagesOnly0123');
    expect(within(dialog).getByRole('button', { name: /Save token/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: /Check with GitHub/ }));
    expect(await within(dialog).findByText(/Pulls packages as octocat/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: /Save token/ }));

    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.saveGithubToken')).toHaveBeenCalledWith({
        token: 'ghp_packagesOnly0123',
        acceptBroaderScopes: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/packages token is saved/));
  });

  it('holds a broader token back until the warning is accepted', async () => {
    const user = userEvent.setup();
    const { bridge } = renderPanel({
      'deployRegistry.checkGithubToken': {
        username: 'octocat',
        scopes: ['repo', 'workflow', 'read:packages'],
        canPull: true,
        broaderScopes: ['repo', 'workflow'],
        problem: null,
      },
      'deployRegistry.saveGithubToken': GITHUB,
    });
    await user.click(await screen.findByRole('button', { name: /GitHub packages token/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub packages token/ });
    await user.type(within(dialog).getByLabelText('Token'), 'ghp_broad');
    await user.click(within(dialog).getByRole('button', { name: /Check with GitHub/ }));
    const warning = await within(dialog).findByRole('group', { name: 'Broader scopes' });
    expect(within(warning).getByText(/read and change every repository/)).toBeVisible();
    const save = within(dialog).getByRole('button', { name: /Save token/ });
    expect(save).toBeDisabled();
    await user.click(within(warning).getByRole('checkbox'));
    await user.click(save);

    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.saveGithubToken')).toHaveBeenCalledWith({
        token: 'ghp_broad',
        acceptBroaderScopes: true,
      }),
    );
  });

  it('shows the fix for a token that cannot pull', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.checkGithubToken': {
        username: null,
        scopes: [],
        canPull: false,
        broaderScopes: [],
        problem: 'This is a fine-grained token. Create a classic token with just read:packages.',
      },
    });
    await user.click(await screen.findByRole('button', { name: /GitHub packages token/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub packages token/ });
    await user.type(within(dialog).getByLabelText('Token'), 'github_pat_x');
    await user.click(within(dialog).getByRole('button', { name: /Check with GitHub/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/classic token/);
    expect(within(dialog).getByRole('button', { name: /Save token/ })).toBeDisabled();
  });

  it('offers the gh refresh command when the gh sign-in lacks packages', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.githubCliStatus': {
        available: true,
        username: 'octocat',
        scopes: ['repo', 'workflow'],
        canPull: false,
        broaderScopes: ['repo', 'workflow'],
        problem: 'The GitHub CLI sign-in cannot read packages yet.',
      },
    });
    await user.click(await screen.findByRole('button', { name: /Use the gh sign-in/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub CLI sign-in/ });
    expect(
      await within(dialog).findByText('gh auth refresh -h github.com -s read:packages'),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Use this sign-in/ })).toBeDisabled();
  });

  it('uses the gh sign-in only with the warning accepted', async () => {
    const user = userEvent.setup();
    const { bridge } = renderPanel({
      'deployRegistry.githubCliStatus': {
        available: true,
        username: 'octocat',
        scopes: ['repo', 'workflow', 'read:packages'],
        canPull: true,
        broaderScopes: ['repo', 'workflow'],
        problem: null,
      },
      'deployRegistry.saveGithubCli': GH_CLI,
    });
    await user.click(await screen.findByRole('button', { name: /Use the gh sign-in/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub CLI sign-in/ });
    const use = await within(dialog).findByRole('button', { name: /Use this sign-in/ });
    expect(use).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(use);
    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.saveGithubCli')).toHaveBeenCalledWith({
        acceptBroaderScopes: true,
      }),
    );
  });

  it('checks a Docker Hub sign-in while typing and saves it', async () => {
    const user = userEvent.setup();
    const { bridge } = renderPanel({ 'deployRegistry.saveCredential': GITHUB });
    await user.click(await screen.findByRole('button', { name: /Docker Hub/ }));
    const dialog = await screen.findByRole('dialog', { name: /Docker Hub/ });
    await user.type(within(dialog).getByLabelText('User name'), 'a:b');
    await user.type(within(dialog).getByLabelText('Access token or password'), 'dckr_pat_x');
    await user.click(within(dialog).getByRole('button', { name: /Save sign-in/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/colon/);

    await user.clear(within(dialog).getByLabelText('User name'));
    await user.type(within(dialog).getByLabelText('User name'), 'hubber');
    await user.click(within(dialog).getByRole('button', { name: /Save sign-in/ }));
    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.saveCredential')).toHaveBeenCalledWith({
        kind: 'dockerhub',
        username: 'hubber',
        secret: 'dckr_pat_x',
      }),
    );
  });

  it('removes a sign-in after asking', async () => {
    const user = userEvent.setup();
    const { bridge } = renderPanel({ 'deployRegistry.list': [GITHUB] });
    await user.click(await screen.findByRole('button', { name: 'Remove the sign-in for ghcr.io' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.remove')).toHaveBeenCalledWith(GITHUB.id),
    );
  });

  it('stores a sign-in on the server after a step-up', async () => {
    const user = userEvent.setup();
    const serverSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('[core:stepUpRequired] Confirm your password'))
      .mockResolvedValue({ ...STORED, registry: 'ghcr.io' });
    renderPanel({ 'deployRegistry.list': [GITHUB], 'deployRegistry.serverSave': serverSave });
    await user.click(await screen.findByRole('button', { name: /Store a credential/ }));
    const dialog = await screen.findByRole('dialog', { name: /Store a credential on Production/ });
    expect(within(dialog).getByLabelText('Credential')).toHaveTextContent(/from this computer/);
    await user.click(within(dialog).getByRole('button', { name: /Store on the server/ }));
    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(proof).getByLabelText('Password'), 'correct horse');
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(serverSave).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        credentialId: GITHUB.id,
        password: 'correct horse',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/stored on Production/));
  });

  it('an Operator sees what is stored but cannot change it', async () => {
    renderPanel({ 'deployRegistry.serverList': [STORED] }, ['operator']);
    expect(await screen.findByRole('button', { name: /Store a credential/ })).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: 'Remove the stored credential for docker.io' }),
    ).toBeDisabled();
  });

  it('a Viewer is told who sees the stored ones', async () => {
    renderPanel({}, ['viewer']);
    expect(await screen.findByText(/shown to Operators and above/)).toBeVisible();
  });

  it('removes a stored credential after asking and a step-up', async () => {
    const user = userEvent.setup();
    const serverRemove = vi
      .fn()
      .mockRejectedValueOnce(new Error('[core:stepUpRequired] Confirm your password'))
      .mockResolvedValue(undefined);
    renderPanel({
      'deployRegistry.serverList': [STORED],
      'deployRegistry.serverRemove': serverRemove,
    });
    await user.click(
      await screen.findByRole('button', { name: 'Remove the stored credential for docker.io' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(proof).getByLabelText('Password'), 'pw');
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(serverRemove).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        credentialId: STORED.id,
        password: 'pw',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Removed the stored/));
  });

  it('types a credential in for the server and checks it first', async () => {
    const user = userEvent.setup();
    const serverSave = vi.fn().mockResolvedValue({ ...STORED, registry: 'quay.io' });
    renderPanel({ 'deployRegistry.serverSave': serverSave });
    await user.click(await screen.findByRole('button', { name: /Store a credential/ }));
    const dialog = await screen.findByRole('dialog', { name: /Store a credential on Production/ });
    expect(within(dialog).getByLabelText('Credential')).toHaveTextContent('Type one in');
    await user.type(within(dialog).getByLabelText('Registry host'), 'not a host');
    await user.click(within(dialog).getByRole('button', { name: /Store on the server/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/registry host/);
    await user.clear(within(dialog).getByLabelText('Registry host'));
    await user.type(within(dialog).getByLabelText('Registry host'), 'Quay.io');
    await user.type(within(dialog).getByLabelText('User name'), 'robot');
    await user.type(within(dialog).getByLabelText('Token or password'), 'quay-token');
    await user.click(within(dialog).getByRole('button', { name: /Store on the server/ }));
    await waitFor(() =>
      expect(serverSave).toHaveBeenCalledWith({
        serverId: SERVER.id,
        registry: 'quay.io',
        username: 'robot',
        secret: 'quay-token',
      }),
    );
  });

  it('shows what the server said when storing fails', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.list': [GITHUB],
      'deployRegistry.serverSave': () =>
        Promise.reject(new Error('This server already stores 50.')),
    });
    await user.click(await screen.findByRole('button', { name: /Store a credential/ }));
    const dialog = await screen.findByRole('dialog', { name: /Store a credential on Production/ });
    await user.click(within(dialog).getByRole('button', { name: /Store on the server/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already stores 50/);
  });

  it('says when gh is not there', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.githubCliStatus': {
        available: false,
        username: null,
        scopes: [],
        canPull: false,
        broaderScopes: [],
        problem: 'The GitHub CLI (gh) is not installed on this computer.',
      },
    });
    await user.click(await screen.findByRole('button', { name: /Use the gh sign-in/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub CLI sign-in/ });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not installed/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a failed save keeps the custom registry dialog open with the reason', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.saveCredential': () => Promise.reject(new Error('The vault is locked.')),
    });
    await user.click(await screen.findByRole('button', { name: /Custom registry/ }));
    const dialog = await screen.findByRole('dialog', { name: /Custom registry/ });
    await user.type(within(dialog).getByLabelText('Registry host'), 'bad host');
    await user.type(within(dialog).getByLabelText('User name'), 'ci');
    await user.type(within(dialog).getByLabelText('Access token or password'), 'secret-1');
    await user.click(within(dialog).getByRole('button', { name: /Save sign-in/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/registry host/);
    await user.clear(within(dialog).getByLabelText('Registry host'));
    await user.type(within(dialog).getByLabelText('Registry host'), 'registry.example.com');
    await user.click(within(dialog).getByRole('button', { name: /Save sign-in/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/vault is locked/);
  });

  it('a GitHub refusal shows in the token dialog', async () => {
    const user = userEvent.setup();
    renderPanel({
      'deployRegistry.checkGithubToken': () =>
        Promise.reject(new Error('GitHub did not accept this token.')),
    });
    await user.click(await screen.findByRole('button', { name: /GitHub packages token/ }));
    const dialog = await screen.findByRole('dialog', { name: /GitHub packages token/ });
    await user.type(within(dialog).getByLabelText('Token'), 'ghp_revoked');
    await user.click(within(dialog).getByRole('button', { name: /Check with GitHub/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/did not accept/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a locked sign-in as locked', async () => {
    renderPanel({ 'deployRegistry.list': [{ ...GITHUB, locked: true }] });
    expect(await screen.findByText('Locked by the passkey')).toBeVisible();
    expect(screen.getByText(/Packages-only token/)).toBeVisible();
  });
});
