import type { DockerHubRepository, DockerHubTag, DockerImage } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The Docker Hub view. It uses the Docker Hub sign-in deploys already use, so someone without
 * one is offered the same sign-in form here. Signed in, it lists their repositories, shows a
 * repository's tags on demand, and pulls a tag to this machine.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { DockerHubView } = await import('./DockerHubView');

const SIGNED_IN = { state: 'signedIn', username: 'hubber' } as const;

function repository(overrides: Partial<DockerHubRepository>): DockerHubRepository {
  return {
    namespace: 'hubber',
    name: 'api',
    description: 'The shop API',
    isPrivate: false,
    starCount: 4,
    pullCount: 12_300,
    lastUpdated: Date.now() - 3 * 86_400_000,
    ...overrides,
  };
}

const api = repository({});
const secret = repository({ name: 'secret', description: '', isPrivate: true });

const TAGS: DockerHubTag[] = [
  {
    name: '1.4',
    sizeBytes: 54 * 1024 ** 2,
    lastPushed: Date.now() - 86_400_000,
    digest: 'sha256:new',
    platforms: ['linux/amd64', 'linux/arm64'],
  },
  {
    name: '1.3',
    sizeBytes: 52 * 1024 ** 2,
    lastPushed: Date.now() - 10 * 86_400_000,
    digest: 'sha256:old',
    platforms: ['linux/amd64'],
  },
];

const LOCAL: DockerImage[] = [
  {
    id: 'sha256:l1',
    tags: ['hubber/api:1.3'],
    dangling: false,
    createdAt: null,
    createdSince: '10 days ago',
    sizeBytes: 1,
    containers: 0,
  },
];

function renderView(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<DockerHubView />, {
    bridge: {
      'dockerHub.status': SIGNED_IN,
      'dockerHub.repositories': [api, secret],
      'dockerHub.tags': TAGS,
      'dockerHub.pull': { ok: true },
      'docker.listImages': LOCAL,
      ...bridge,
    },
  });
}

describe('DockerHubView signed out', () => {
  it('offers the Docker Hub sign-in and lists repositories once it is saved', async () => {
    let status: unknown = { state: 'signedOut', username: null };
    const { user, bridge } = renderView({
      'dockerHub.status': async () => status,
      'deployRegistry.saveCredential': async () => {
        status = SIGNED_IN;
        return {};
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in to Docker Hub' }));
    const dialog = await screen.findByRole('dialog', { name: /Docker Hub/ });
    await user.type(within(dialog).getByLabelText('User name'), 'hubber');
    await user.type(within(dialog).getByLabelText('Access token or password'), 'dckr_pat_x');
    await user.click(within(dialog).getByRole('button', { name: /Save sign-in/ }));

    expect(bridge.$fn('deployRegistry.saveCredential')).toHaveBeenCalledWith({
      kind: 'dockerhub',
      username: 'hubber',
      secret: 'dckr_pat_x',
    });
    expect(await screen.findByRole('listitem', { name: 'hubber/api' })).toBeInTheDocument();
  });

  it('asks for the passkey when the sign-in is sealed behind it', async () => {
    renderView({ 'dockerHub.status': { state: 'locked', username: 'hubber' } });

    expect(await screen.findByText(/Unlock the Servers passkey/)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('DockerHubView signed in', () => {
  it('names the account and lists its repositories with their details', async () => {
    renderView();

    expect(await screen.findByText('hubber')).toBeInTheDocument();
    const row = await screen.findByRole('listitem', { name: 'hubber/api' });
    expect(within(row).getByText('The shop API')).toBeInTheDocument();
    expect(within(row).getByText('Public')).toBeInTheDocument();
    expect(within(row).getByText('12.3K')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'hubber/secret' })).getByText('Private'),
    ).toBeInTheDocument();
  });

  it('filters repositories by name or description', async () => {
    const { user } = renderView();
    await screen.findByRole('listitem', { name: 'hubber/api' });

    await user.type(screen.getByRole('textbox', { name: 'Search repositories' }), 'shop');

    expect(screen.getByRole('listitem', { name: 'hubber/api' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'hubber/secret' })).not.toBeInTheDocument();
  });

  it('loads tags only when a repository is opened, and only once', async () => {
    const { user, bridge } = renderView();
    const row = await screen.findByRole('listitem', { name: 'hubber/api' });
    // The fake bridge only answers $fn for paths the code has touched, so a closed repository
    // shows up as no tag list rather than as an uncalled mock.
    expect(within(row).queryByRole('list', { name: /Tags of/ })).not.toBeInTheDocument();

    const toggle = within(row).getByRole('button', { name: /hubber\/api/, expanded: false });
    await user.click(toggle);
    expect(await within(row).findByText('1.4')).toBeInTheDocument();
    expect(within(row).getByText('linux/amd64, linux/arm64')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    await user.click(toggle);
    expect(bridge.$fn('dockerHub.tags')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('dockerHub.tags')).toHaveBeenCalledWith('hubber', 'api');
  });

  it('marks a tag that is already on this machine', async () => {
    const { user } = renderView();
    const row = await screen.findByRole('listitem', { name: 'hubber/api' });
    await user.click(within(row).getByRole('button', { name: /hubber\/api/ }));

    const old = await within(row).findByRole('listitem', { name: '1.3' });
    expect(within(old).getByText('On this machine')).toBeInTheDocument();
    expect(within(old).getByRole('button', { name: 'Pull hubber/api:1.3' })).toHaveTextContent(
      'Pull again',
    );
    const fresh = within(row).getByRole('listitem', { name: '1.4' });
    expect(within(fresh).queryByText('On this machine')).not.toBeInTheDocument();
  });

  it('pulls a tag, then refreshes the images on this machine', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { user, bridge } = renderView({
      'dockerHub.pull': () => new Promise((resolve) => (finish = resolve)),
    });
    const row = await screen.findByRole('listitem', { name: 'hubber/secret' });
    await user.click(within(row).getByRole('button', { name: /hubber\/secret/ }));
    const pull = await within(row).findByRole('button', { name: 'Pull hubber/secret:1.4' });
    const imageLoads = bridge.$fn('docker.listImages').mock.calls.length;

    await user.click(pull);

    expect(pull).toBeDisabled();
    expect(pull).toHaveTextContent('Pulling');
    expect(bridge.$fn('dockerHub.pull')).toHaveBeenCalledWith({
      namespace: 'hubber',
      name: 'secret',
      tag: '1.4',
      isPrivate: true,
    });
    finish({ ok: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pulled hubber/secret:1.4.'));
    await waitFor(() =>
      expect(bridge.$fn('docker.listImages').mock.calls.length).toBeGreaterThan(imageLoads),
    );
  });

  it("shows docker's reason when a pull fails", async () => {
    const { user } = renderView({
      'dockerHub.pull': { ok: false, error: 'pull access denied for hubber/api' },
    });
    const row = await screen.findByRole('listitem', { name: 'hubber/api' });
    await user.click(within(row).getByRole('button', { name: /hubber\/api/ }));
    await user.click(await within(row).findByRole('button', { name: 'Pull hubber/api:1.4' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('pull access denied for hubber/api'),
    );
  });

  it('says so when the account has no repositories yet', async () => {
    renderView({ 'dockerHub.repositories': [] });

    expect(await screen.findByText('No repositories yet')).toBeInTheDocument();
  });

  it('shows a refused sign-in with a way to replace it', async () => {
    renderView({
      'dockerHub.repositories': () =>
        Promise.reject(new Error('Docker Hub did not accept the saved sign-in.')),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Docker Hub did not accept the saved sign-in.');
    expect(within(alert).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change sign-in' })).toBeInTheDocument();
  });
});
