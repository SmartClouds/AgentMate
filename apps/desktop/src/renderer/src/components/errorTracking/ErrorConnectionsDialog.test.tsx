import type { LinkCandidateProject, RemoteProject } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { connection, link, project, remoteProject, tokenCheck } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

// The matcher is core's to get right; here it only has to be asked and followed.
const suggest = vi.hoisted(() =>
  vi.fn((candidate: LinkCandidateProject, remote: readonly RemoteProject[]) =>
    remote.filter((one) => one.slug.startsWith(candidate.name.toLowerCase())),
  ),
);
vi.mock('@runova/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@runova/core')>()),
  suggestRemoteProjects: suggest,
}));

const { ErrorConnectionsDialog } = await import('./ErrorConnectionsDialog');

const projects = [project(), project({ id: 'p2', name: 'Admin', folderPath: 'C:\\work\\admin' })];
const remote = [
  remoteProject(),
  remoteProject({ id: '12', slug: 'storefront-api', name: 'storefront-api' }),
  remoteProject({ id: '13', slug: 'billing', name: 'billing' }),
];

function renderDialog(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <ErrorConnectionsDialog open onOpenChange={vi.fn()} projects={projects} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'errorTracking.listConnections': [],
        'errorTracking.listLinks': [],
        'errorTracking.remoteProjects': remote,
        ...bridge,
      },
    },
  );
}

async function dialog() {
  return screen.findByRole('dialog', { name: 'Error tracking connections' });
}

describe('ErrorConnectionsDialog, adding a connection', () => {
  it('checks the token, lists its scopes and saves the chosen organization', async () => {
    const check = vi.fn(async () => tokenCheck());
    let added = false;
    const add = vi.fn(async () => {
      added = true;
      return connection();
    });
    const { user } = renderDialog({
      'errorTracking.listConnections': async () => (added ? [connection()] : []),
      'errorTracking.checkToken': check,
      'errorTracking.addConnection': add,
    });
    const view = await dialog();

    expect(await within(view).findByRole('combobox', { name: 'Sentry host' })).toHaveTextContent(
      'Sentry.io (US)',
    );
    expect(within(view).getByRole('button', { name: 'Check token' })).toBeDisabled();
    await user.type(within(view).getByLabelText('Auth token'), 'sntryu_secret');
    await user.click(within(view).getByRole('button', { name: 'Check token' }));
    expect(check).toHaveBeenCalledWith({
      provider: 'sentry',
      host: 'https://sentry.io',
      token: 'sntryu_secret',
    });

    const scopes = await within(view).findByRole('list', { name: 'Token scopes' });
    const rows = within(scopes).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/org:read.*Granted/),
      expect.stringMatching(/project:read.*Granted/),
      expect.stringMatching(/event:read.*Granted/),
      expect.stringMatching(/event:write.*needed for Resolve and Ignore/),
    ]);

    await user.click(within(view).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'Side project' }));
    await user.click(within(view).getByRole('button', { name: 'Save connection' }));
    expect(add).toHaveBeenCalledWith({
      provider: 'sentry',
      host: 'https://sentry.io',
      token: 'sntryu_secret',
      orgSlug: 'side',
    });
    // Saved: the form makes way for the next step, linking projects.
    await waitFor(() => expect(within(view).queryByLabelText('Auth token')).toBeNull());
    expect(await within(view).findByRole('heading', { name: 'Link projects' })).toBeInTheDocument();
  });

  it('asks for the server URL of a self-hosted Sentry or GlitchTip', async () => {
    const check = vi.fn(async () => tokenCheck({ host: 'http://127.0.0.1:9000' }));
    const { user } = renderDialog({ 'errorTracking.checkToken': check });
    const view = await dialog();
    await user.click(await within(view).findByRole('combobox', { name: 'Sentry host' }));
    expect(within(view).queryByLabelText('Server URL')).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Self-hosted or GlitchTip' }));
    await user.type(within(view).getByLabelText('Server URL'), 'http://127.0.0.1:9000');
    await user.type(within(view).getByLabelText('Auth token'), 'tok');
    await user.click(within(view).getByRole('button', { name: 'Check token' }));
    expect(check).toHaveBeenCalledWith({
      provider: 'sentry',
      host: 'http://127.0.0.1:9000',
      token: 'tok',
    });
  });

  it('will not save a token that cannot read issues, and says why', async () => {
    const { user } = renderDialog({
      'errorTracking.checkToken': async () =>
        tokenCheck({
          scopes: ['org:ci'],
          missingScopes: ['org:read', 'project:read', 'event:read'],
          warning: 'This is an organization token. It can upload releases but cannot read issues.',
        }),
    });
    const view = await dialog();
    await user.type(await within(view).findByLabelText('Auth token'), 'sntrys_org');
    await user.click(within(view).getByRole('button', { name: 'Check token' }));
    const scopes = await within(view).findByRole('list', { name: 'Token scopes' });
    expect(within(scopes).getAllByText('Missing')).toHaveLength(4);
    expect(view).toHaveTextContent('This is an organization token');
    expect(view).toHaveTextContent('needs org:read, project:read and event:read');
    expect(within(view).getByRole('button', { name: 'Save connection' })).toBeDisabled();
  });

  it('shows why a token check failed', async () => {
    const { user } = renderDialog({
      'errorTracking.checkToken': async () => {
        throw new Error('Token rejected');
      },
    });
    const view = await dialog();
    await user.type(await within(view).findByLabelText('Auth token'), 'bad');
    await user.click(within(view).getByRole('button', { name: 'Check token' }));
    expect(await within(view).findByRole('alert')).toHaveTextContent('Token rejected');
  });
});

describe('ErrorConnectionsDialog, saved connections', () => {
  it('lists each connection with its state', async () => {
    renderDialog({
      'errorTracking.listConnections': [
        connection(),
        connection({ id: 'c2', label: 'Side', locked: true }),
        connection({ id: 'c3', label: 'Old', problem: 'Token rejected', canWrite: false }),
      ],
    });
    const view = await dialog();
    const list = await within(view).findByRole('list', { name: 'Connections' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Locked');
    expect(rows[2]).toHaveTextContent('Token rejected');
    expect(rows[2]).toHaveTextContent('Read only');
  });

  it('removes a connection only after a confirmation', async () => {
    const { user, bridge } = renderDialog({ 'errorTracking.listConnections': [connection()] });
    const view = await dialog();
    const list = await within(view).findByRole('list', { name: 'Connections' });
    await user.click(within(list).getByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Acme?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(bridge.$fn('errorTracking.removeConnection')).toHaveBeenCalledWith('c1'),
    );
  });

  it('replaces a token', async () => {
    const replace = vi.fn(async () => connection());
    const { user } = renderDialog({
      'errorTracking.listConnections': [connection({ problem: 'Token rejected' })],
      'errorTracking.replaceToken': replace,
    });
    const view = await dialog();
    const list = await within(view).findByRole('list', { name: 'Connections' });
    await user.click(within(list).getByRole('button', { name: 'Replace token' }));
    await user.type(within(list).getByLabelText('New auth token'), 'sntryu_new');
    await user.click(within(list).getByRole('button', { name: 'Save token' }));
    expect(replace).toHaveBeenCalledWith('c1', 'sntryu_new');
  });
});

describe('ErrorConnectionsDialog, linking projects', () => {
  it('pre-fills unlinked projects from the suggestions and saves the links', async () => {
    const setLinks = vi.fn(async () => []);
    const { user } = renderDialog({
      'errorTracking.listConnections': [connection()],
      'errorTracking.listLinks': [
        link({
          projectId: 'p2',
          remoteProjectId: '13',
          remoteSlug: 'billing',
          remoteName: 'billing',
        }),
      ],
      'errorTracking.setLinks': setLinks,
    });
    const view = await dialog();
    expect(await within(view).findByRole('heading', { name: 'Link projects' })).toBeInTheDocument();

    const storefront = await within(view).findByRole('combobox', {
      name: 'Sentry projects for Storefront',
    });
    await waitFor(() => expect(storefront).toHaveTextContent('storefront-web'));
    expect(storefront).toHaveTextContent('storefront-api');
    expect(suggest).toHaveBeenCalledWith(
      { name: 'Storefront', folderPath: 'C:\\work\\storefront', repoUrl: null },
      remote,
    );
    // A project that is linked already keeps its links rather than taking suggestions.
    expect(
      within(view).getByRole('combobox', { name: 'Sentry projects for Admin' }),
    ).toHaveTextContent('billing');

    // Take one suggestion back out before saving.
    await user.click(storefront);
    await user.click(await screen.findByRole('option', { name: /storefront-api/ }));
    await user.keyboard('{Escape}');

    await user.click(within(view).getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(setLinks).toHaveBeenCalledTimes(1));
    expect(setLinks).toHaveBeenCalledWith('p1', [
      {
        projectId: 'p1',
        connectionId: 'c1',
        remoteProjectId: '11',
        remoteSlug: 'storefront-web',
        remoteName: 'storefront-web',
      },
    ]);
  });
});
