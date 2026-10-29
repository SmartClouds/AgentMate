import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { emptyDraft, useDeployAppRunStore, wizardKey } from '@/stores/deployAppRunStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { appsBridge, SERVER, STACK_ID, sampleStack } from './testing/fixtures';

/** The Apps section: the list in every state, and the address that opens an app or the wizard. */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { AppsPanel } = await import('./AppsPanel');

function Where(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

function renderApps(
  bridge: Record<string, unknown> = {},
  roles?: string[],
  route = `/deploy?server=${SERVER.id}&view=apps`,
) {
  return renderWithProviders(
    <>
      <AppsPanel server={SERVER} />
      <Where />
      <ConfirmDialogHost />
    </>,
    { bridge: { ...appsBridge(roles), ...bridge }, route },
  );
}

describe('AppsPanel list', () => {
  it('shimmers per card while the apps load', async () => {
    renderApps({ 'deployStacks.list': () => new Promise(() => undefined) });
    await waitFor(() =>
      expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(3),
    );
  });

  it('asks for a sign-in first', async () => {
    renderApps({ 'deploy.access': { state: 'needs-sign-in' } });
    expect(await screen.findByText(/Sign in to Production on its Overview/)).toBeInTheDocument();
  });

  it('shows each app with its status, revision, containers and source', async () => {
    renderApps({
      'deployStacks.list': [
        sampleStack(),
        sampleStack({
          id: 'other',
          name: 'blog',
          status: 'failed',
          liveRevision: undefined,
          containers: 0,
          runningContainers: 0,
          source: undefined,
        }),
      ],
    });
    const shop = await screen.findByRole('listitem', { name: 'shop' });
    expect(within(shop).getByText('Running')).toBeInTheDocument();
    expect(within(shop).getByText('Revision 2 live')).toBeInTheDocument();
    expect(within(shop).getByText('2 of 2 containers running')).toBeInTheDocument();
    expect(within(shop).getByText('Shop / compose.yaml')).toBeInTheDocument();
    const blog = screen.getByRole('listitem', { name: 'blog' });
    expect(within(blog).getByText('Failed')).toBeInTheDocument();
    expect(within(blog).getByText('Nothing live')).toBeInTheDocument();
    expect(within(blog).getByText('No containers')).toBeInTheDocument();
  });

  it('says what to do on an empty server', async () => {
    const { user } = renderApps({ 'deployStacks.list': [] });
    expect(await screen.findByText('No apps on this server yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New app' }));
    expect(screen.getByTestId('where')).toHaveTextContent('new=1');
    expect(await screen.findByRole('heading', { name: 'New app' })).toBeInTheDocument();
  });

  it('says when the apps did not load and tries again', async () => {
    let calls = 0;
    const { user } = renderApps({
      'deployStacks.list': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The server core is not answering (503).');
        return [sampleStack()];
      },
    });
    expect(
      await screen.findByText(/The apps did not load: The server core is not answering/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: 'shop' })).toBeInTheDocument();
  });

  it('lets a Viewer look but not start a new app', async () => {
    renderApps({ 'deployStacks.list': [] }, ['viewer']);
    expect(await screen.findByRole('button', { name: 'New app' })).toBeDisabled();
  });

  it('opens an app from its card and comes back', async () => {
    const { user } = renderApps();
    await user.click(await screen.findByRole('button', { name: /shop/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(`app=${STACK_ID}`);
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All apps' }));
    expect(await screen.findByRole('list', { name: 'Apps' })).toBeInTheDocument();
  });

  it('opens the wizard to deploy an app again from its page', async () => {
    const { user } = renderApps(
      {},
      undefined,
      `/deploy?server=${SERVER.id}&view=apps&app=${STACK_ID}`,
    );
    await user.click(await screen.findByRole('button', { name: 'Deploy again' }));
    expect(await screen.findByRole('heading', { name: 'Deploy shop again' })).toBeInTheDocument();
    expect(screen.getByLabelText('App name')).toHaveValue('shop');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeInTheDocument();
  });

  it('deploys another compose file from the edit, starting on Configure with fresh services', async () => {
    const { user, bridge } = renderApps(
      {
        'deployStacks.discover': {
          projectId: 'proj-1',
          projectName: 'Shop',
          files: [
            { path: 'compose.yaml', services: 2 },
            { path: 'deploy/docker-compose.prod.yml', services: 3 },
          ],
          truncated: false,
        },
      },
      undefined,
      `/deploy?server=${SERVER.id}&view=apps&app=${STACK_ID}`,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Edit the compose file and env files' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('radio', { name: /docker-compose\.prod/ }));
    await user.click(within(dialog).getByRole('button', { name: /Continue/ }));

    expect(await screen.findByRole('heading', { name: 'Deploy shop again' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('new=1');
    expect(await screen.findByRole('list', { name: 'Services to deploy' })).toBeInTheDocument();
    // A new compose file starts from the preview's own choice of private services.
    expect(bridge.$fn('deployStacks.preview')).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      composePath: 'deploy/docker-compose.prod.yml',
      environmentId: 'env-1',
    });

    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByRole('radio', { name: /docker-compose\.prod/ })).toBeChecked();
    expect(screen.getByLabelText('App name')).toHaveValue('shop');
  });

  it('keeps the private services when only the env files change', async () => {
    const { user, bridge } = renderApps(
      {},
      undefined,
      `/deploy?server=${SERVER.id}&view=apps&app=${STACK_ID}`,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Edit the compose file and env files' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Environment' }));
    await user.click(await screen.findByRole('option', { name: 'Staging' }));
    await user.click(
      within(within(dialog).getByRole('list', { name: 'Env files' })).getByRole('checkbox', {
        name: '.env.local',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /Continue/ }));

    expect(await screen.findByRole('list', { name: 'Services to deploy' })).toBeInTheDocument();
    expect(bridge.$fn('deployStacks.preview')).toHaveBeenNthCalledWith(1, {
      projectId: 'proj-1',
      composePath: 'compose.yaml',
      environmentId: 'env-2',
      envFileIds: ['s1', 's2'],
      proxiedServices: ['web'],
    });
  });

  it('says so when the app to deploy again does not load', async () => {
    renderApps(
      { 'deployStacks.get': () => Promise.reject(new Error('There is no such app.')) },
      undefined,
      `/deploy?server=${SERVER.id}&view=apps&app=${STACK_ID}&new=1`,
    );
    expect(
      await screen.findByText(/The app did not load: There is no such app/),
    ).toBeInTheDocument();
  });
});

describe('AppsPanel registries', () => {
  it('opens the registry sign-ins from the list, in the address', async () => {
    const { user } = renderApps({ 'deployRegistry.list': [], 'deployRegistry.serverList': [] });
    await user.click(await screen.findByRole('button', { name: /Registries/ }));
    expect(await screen.findByRole('heading', { name: /Registries/ })).toBeVisible();
    expect(screen.getByTestId('where')).toHaveTextContent('registries=1');
  });
});

describe('AppsPanel deploys left running', () => {
  function keep(existingStackId: string | null, phase: 'uploading' | 'idle') {
    const key = wizardKey(SERVER.id, existingStackId);
    useDeployAppRunStore.getState().open(key, emptyDraft({ step: 'deploy' }));
    useDeployAppRunStore.setState((state) => ({
      wizards: {
        ...state.wizards,
        [key]: { ...state.wizards[key], run: { phase }, name: 'shop', serverId: SERVER.id },
      },
    }));
  }

  it('says a deploy is still on its way, and opens it', async () => {
    keep(null, 'uploading');
    const { user } = renderApps();
    const notice = await screen.findByRole('status', { name: 'Deploy in progress' });
    expect(notice).toHaveTextContent('Deploying shop');
    await user.click(within(notice).getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('where')).toHaveTextContent('new=1');
  });

  it('opens a deploy again of an app with that app', async () => {
    keep(STACK_ID, 'uploading');
    const { user } = renderApps();
    const notice = await screen.findByRole('status', { name: 'Deploy in progress' });
    await user.click(within(notice).getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('where')).toHaveTextContent(`app=${STACK_ID}&new=1`);
  });

  it('starts a new app from scratch when nothing is on its way', async () => {
    keep(null, 'idle');
    const { user } = renderApps();
    expect(screen.queryByRole('status', { name: 'Deploy in progress' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'New app' }));
    const steps = await screen.findByRole('list', { name: 'New app steps' });
    expect(within(steps).getByRole('listitem', { current: 'step' })).toHaveTextContent('Source');
  });
});
