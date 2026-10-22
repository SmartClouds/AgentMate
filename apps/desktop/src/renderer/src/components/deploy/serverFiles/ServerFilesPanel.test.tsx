import { sampleDockerStatus, sampleVolumes } from '@shared/deploy/testing/fakeDockerData';
import type { DeployAccess, DeployServer } from '@shared/deployTypes';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SshFilesViewProps } from '@/components/sftp/SshFilesView';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { dockerBridge, SERVER } from '../containers/testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

// The file manager has tests of its own; here only which target it is pointed at counts.
vi.mock('@/components/sftp/SshFilesView', () => ({
  SshFilesView: (props: SshFilesViewProps) => (
    <div data-testid="files-view" data-target={props.serverId} data-variant={props.variant} />
  ),
}));

const { ServerFilesPanel } = await import('./ServerFilesPanel');

/**
 * A Deploy server's Files section (E27): the server's own disk, a container or a volume in the
 * two-pane file manager, the choice kept in the page address, and a word for every reason it
 * cannot open (no sign-in, no Admin role, no Docker, nothing to browse, a target that is gone).
 */

const DEVHOST: DeployServer = { ...SERVER, id: 'devhost', nickname: 'DevHost', dev: true };

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

function renderPanel(
  search: string,
  bridge: Record<string, unknown> = {},
  options: { server?: DeployServer; roles?: string[] } = {},
) {
  const server = options.server ?? SERVER;
  return renderWithProviders(
    <>
      <ServerFilesPanel server={server} />
      <LocationProbe />
    </>,
    {
      route: `/deploy?${search}`,
      bridge: { ...dockerBridge(options.roles), ...bridge },
    },
  );
}

const view = () => screen.findByTestId('files-view', {}, { timeout: 10_000 });
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');
const sourcePicker = () => screen.getByRole('combobox', { name: 'Source' });

async function pick(user: ReturnType<typeof renderPanel>['user'], box: HTMLElement, name: string) {
  await user.click(box);
  await user.click(await screen.findByRole('option', { name }));
}

describe('ServerFilesPanel, the source', () => {
  it('opens the server disk by default, drawn in full inside the section', async () => {
    renderPanel('server=srv-1&view=files');
    const files = await view();
    expect(files.dataset.target).toBe('srv-1');
    expect(files.dataset.variant).toBe('embedded');
    expect(sourcePicker()).toHaveTextContent('Server disk');
  });

  it('offers the server disk, containers and volumes', async () => {
    const { user } = renderPanel('server=srv-1&view=files');
    await user.click(await screen.findByRole('combobox', { name: 'Source' }));
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(['Server disk', 'Container', 'Volume']);
  });

  it('keeps a picked container in the address and opens it', async () => {
    const { user } = renderPanel('server=srv-1&view=files');
    await view();
    await pick(user, sourcePicker(), 'Container');
    expect(search().get('source')).toBe('container');
    expect(await screen.findByText('Choose a container')).toBeTruthy();
    await pick(
      user,
      await screen.findByRole('combobox', { name: 'Container' }),
      'shop-api-1 (running)',
    );
    expect(Object.fromEntries(search())).toEqual({
      server: 'srv-1',
      view: 'files',
      source: 'container',
      target: 'shop-api-1',
    });
    expect((await view()).dataset.target).toBe('docker~srv-1~container~shop-api-1');
  });

  it('says what state each container is in, stopped ones included', async () => {
    const { user } = renderPanel('server=srv-1&view=files&source=container');
    await user.click(await screen.findByRole('combobox', { name: 'Container' }));
    expect(await screen.findByRole('option', { name: 'migrate-once (exited)' })).toBeTruthy();
  });

  it('opens a volume from the address', async () => {
    renderPanel('server=srv-1&view=files&source=volume&target=shop_db-data');
    expect((await view()).dataset.target).toBe('docker~srv-1~volume~shop_db-data');
    expect(screen.getByRole('combobox', { name: 'Volume' })).toHaveTextContent('shop_db-data');
  });

  it('goes back to the server disk and drops the target from the address', async () => {
    const { user } = renderPanel('server=srv-1&view=files&source=volume&target=shop_db-data');
    await view();
    await pick(user, sourcePicker(), 'Server disk');
    expect(Object.fromEntries(search())).toEqual({
      server: 'srv-1',
      view: 'files',
      source: 'server',
    });
    await waitFor(() => expect(screen.getByTestId('files-view').dataset.target).toBe('srv-1'));
  });

  it('has no server disk on the DevHost, which has no SSH, and starts on containers', async () => {
    const { user } = renderPanel('server=devhost&view=files', {}, { server: DEVHOST });
    expect(await screen.findByText('Choose a container')).toBeTruthy();
    await user.click(sourcePicker());
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(['Container', 'Volume']);
  });
});

describe('ServerFilesPanel, when it cannot open', () => {
  it('asks to sign in for a container, and still offers the server disk', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deploy.access': { state: 'needs-sign-in' } satisfies DeployAccess,
    });
    expect(await screen.findByText('Not signed in')).toBeTruthy();
    expect(
      screen.getByText('Sign in to Production to browse the files in its containers and volumes.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('files-view')).toBeNull();
    expect(sourcePicker()).toBeEnabled();
  });

  it('opens the server disk without a sign-in', async () => {
    renderPanel('server=srv-1&view=files', {
      'deploy.access': { state: 'needs-sign-in' } satisfies DeployAccess,
    });
    expect((await view()).dataset.target).toBe('srv-1');
  });

  it('keeps containers and volumes for Admins, and says which role the user has', async () => {
    renderPanel('server=srv-1&view=files&source=volume', {}, { roles: ['operator'] });
    expect(await screen.findByText('Files in containers and volumes are for Admins')).toBeTruthy();
    expect(screen.getByText(/You are signed in as an Operator\./)).toBeTruthy();
    expect(screen.queryByTestId('files-view')).toBeNull();
  });

  it('says when Docker is not installed', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deployDocker.status': sampleDockerStatus({ installed: false, running: false }),
    });
    expect(await screen.findByText('Docker is not installed on Production')).toBeTruthy();
  });

  it('says when Docker is not running', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deployDocker.status': sampleDockerStatus({ running: false }),
    });
    expect(await screen.findByText('Docker is not running on Production')).toBeTruthy();
  });

  it('says why Docker could not be asked about, and asks again', async () => {
    let fail = true;
    const { user } = renderPanel('server=srv-1&view=files&source=container', {
      'deployDocker.status': async () => {
        if (fail) throw new Error('The server core is not answering (503).');
        return sampleDockerStatus();
      },
    });
    expect(await screen.findByText(/The server core is not answering/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Choose a container')).toBeTruthy();
  });

  it('says when there are no containers', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deployDocker.listContainers': { groups: [] },
    });
    expect(await screen.findByText('No containers on Production')).toBeTruthy();
  });

  it('says when there are no volumes', async () => {
    renderPanel('server=srv-1&view=files&source=volume', { 'deployDocker.listVolumes': [] });
    expect(await screen.findByText('No volumes on Production')).toBeTruthy();
  });

  it('says why the containers did not load', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deployDocker.listContainers': async () => {
        throw new Error('The server core is not answering (503).');
      },
    });
    expect(
      await screen.findByText(/Could not list the containers: The server core is not answering/),
    ).toBeTruthy();
  });

  it('says when the container in the address is not there anymore', async () => {
    renderPanel('server=srv-1&view=files&source=container&target=web-9');
    expect(
      await screen.findByText('web-9 is not on Production anymore. Pick another container.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('files-view')).toBeNull();
  });

  it('says when the volume in the address is not there anymore', async () => {
    renderPanel('server=srv-1&view=files&source=volume&target=gone', {
      'deployDocker.listVolumes': sampleVolumes().slice(0, 1),
    });
    expect(
      await screen.findByText('gone is not on Production anymore. Pick another volume.'),
    ).toBeTruthy();
  });

  it('shimmers while it finds out, with no overlay', async () => {
    renderPanel('server=srv-1&view=files&source=container', {
      'deploy.access': () => new Promise(() => undefined),
    });
    expect(await screen.findByRole('status', { name: 'Loading the files' })).toBeTruthy();
    expect(screen.queryByTestId('files-view')).toBeNull();
  });
});
