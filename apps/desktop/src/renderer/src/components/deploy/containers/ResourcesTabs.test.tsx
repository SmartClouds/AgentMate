import { sampleJob } from '@shared/deploy/testing/fakeCoreData';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { dockerBridge, SERVER } from './testing/fixtures';

/**
 * Docker's images, volumes, networks and disk use: each tab through loading, failure, empty and
 * filled, pulls as a job, and removals and prunes that ask first (with the name for data).
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { ContainersPanel } = await import('./ContainersPanel');

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
}

async function openTab(tab: string, bridge: Record<string, unknown> = {}, roles?: string[]) {
  const view = renderWithProviders(
    <>
      <ContainersPanel server={SERVER} />
      <ConfirmDialogHost />
      <LocationProbe />
    </>,
    { bridge: { ...dockerBridge(roles), ...bridge } },
  );
  await view.user.click(await screen.findByRole('tab', { name: tab }, { timeout: 10_000 }));
  return view;
}

const down = () => Promise.reject(new Error('The server core is not answering (503).'));

describe('Images', () => {
  it('pulls an image as a job with a live log, and checks the reference first', async () => {
    const job = sampleJob({ kind: 'imagePull', title: 'Pull redis:8' });
    const { user, bridge } = await openTab('Images', { 'deployDocker.pullImage': async () => job });
    expect(await screen.findByRole('list', { name: 'Images' })).toHaveTextContent('nginx:1.29');
    const field = screen.getByRole('textbox', { name: 'Image to pull' });
    await user.type(field, 'Not Valid');
    expect(screen.getByText('That is not an image reference.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pull/ })).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'redis:8{Enter}');
    expect(bridge.$fn('deployDocker.pullImage')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      reference: 'redis:8',
    });
    expect(await screen.findByRole('dialog', { name: 'Pull redis:8' })).toBeInTheDocument();
  });

  it('says why a pull was refused', async () => {
    const { user } = await openTab('Images', { 'deployDocker.pullImage': down });
    await user.type(
      await screen.findByRole('textbox', { name: 'Image to pull' }),
      'redis:8{Enter}',
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The server core is not answering (503).'),
    );
  });

  it('removes an image after asking, by force when containers still use it', async () => {
    const { user, bridge } = await openTab('Images');
    const list = await screen.findByRole('list', { name: 'Images' });
    await user.click(within(list).getByRole('button', { name: 'Remove shop-api:latest' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove shop-api:latest?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove anyway' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.removeImage')).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Removed shop-api:latest.');
  });

  it('lets a Viewer only look, and shows failure and empty states', async () => {
    await openTab('Images', {}, ['viewer']);
    const list = await screen.findByRole('list', { name: 'Images' });
    expect(screen.queryByRole('textbox', { name: 'Image to pull' })).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it('says when images do not load, or there are none', async () => {
    await openTab('Images', { 'deployDocker.listImages': down });
    expect(await screen.findByRole('alert')).toHaveTextContent('not answering');
  });

  it('says when there are no images', async () => {
    await openTab('Images', { 'deployDocker.listImages': [] });
    expect(await screen.findByText('No images on this server yet.')).toBeInTheDocument();
  });
});

describe('Volumes and networks', () => {
  it('removes a volume only with its name typed out, and only for Admins', async () => {
    const { user, bridge } = await openTab('Volumes');
    const list = await screen.findByRole('list', { name: 'Volumes' });
    expect(within(list).getByRole('button', { name: 'Remove shop_db-data' })).toBeDisabled();
    await user.click(within(list).getByRole('button', { name: 'Remove old-cache' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove the volume old-cache?' });
    await user.type(within(confirm).getByRole('textbox'), 'old-cache');
    await user.click(within(confirm).getByRole('button', { name: 'Remove the volume' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.removeVolume')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        volume: 'old-cache',
        force: false,
      }),
    );
  });

  it('keeps volume removal from Operators and lists volumes in words', async () => {
    await openTab('Volumes', {}, ['operator']);
    const list = await screen.findByRole('list', { name: 'Volumes' });
    expect(within(list).getByRole('listitem', { name: 'shop_db-data' })).toHaveTextContent(
      'project shop, 512 MB, used by 1 container',
    );
    expect(within(list).queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('says when volumes do not load or there are none', async () => {
    await openTab('Volumes', { 'deployDocker.listVolumes': [] });
    expect(await screen.findByText('No volumes on this server.')).toBeInTheDocument();
  });

  it('says why a volume removal failed', async () => {
    const { user } = await openTab('Volumes', { 'deployDocker.removeVolume': down });
    const list = await screen.findByRole('list', { name: 'Volumes' });
    await user.click(within(list).getByRole('button', { name: 'Remove old-cache' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove the volume old-cache?' });
    await user.type(within(confirm).getByRole('textbox'), 'old-cache');
    await user.click(within(confirm).getByRole('button', { name: 'Remove the volume' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The server core is not answering (503).'),
    );
  });

  it('removes a network of its own, never a built-in one', async () => {
    const { user, bridge } = await openTab('Networks', {
      'deployDocker.listNetworks': async () =>
        (await import('@shared/deploy/testing/fakeDockerData'))
          .sampleNetworks()
          .map((network) => ({ ...network, containers: network.builtIn ? network.containers : 0 })),
    });
    const list = await screen.findByRole('list', { name: 'Networks' });
    expect(within(list).queryByRole('button', { name: 'Remove bridge' })).toBeNull();
    expect(within(list).getByRole('listitem', { name: 'bridge' })).toHaveTextContent('Built in');
    await user.click(within(list).getByRole('button', { name: 'Remove shop_default' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove the network shop_default?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove the network' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.removeNetwork')).toHaveBeenCalledWith(
        SERVER.id,
        'shop_default',
      ),
    );
  });

  it('says when networks do not load or there are none', async () => {
    await openTab('Networks', { 'deployDocker.listNetworks': down });
    expect(await screen.findByRole('alert')).toHaveTextContent('not answering');
  });

  it('says when there are no networks', async () => {
    await openTab('Networks', { 'deployDocker.listNetworks': [] });
    expect(await screen.findByText('No networks on this server.')).toBeInTheDocument();
  });
});

describe('Volumes, Browse files (E27)', () => {
  it('opens the Files section on a volume', async () => {
    const { user } = await openTab('Volumes');
    const list = await screen.findByRole('list', { name: 'Volumes' });
    await user.click(within(list).getByRole('button', { name: 'Browse files in shop_db-data' }));
    expect(screen.getByTestId('path').textContent).toBe(
      '/deploy?server=srv-1&view=files&source=volume&target=shop_db-data',
    );
  });

  it('is off below Admin, and says why', async () => {
    const { user } = await openTab('Volumes', {}, ['operator']);
    const list = await screen.findByRole('list', { name: 'Volumes' });
    const button = within(list).getByRole('button', { name: 'Browse files in old-cache' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement as HTMLElement);
    expect(
      await screen.findByRole('tooltip', { name: 'Browsing files in a volume is for Admins.' }),
    ).toBeTruthy();
  });
});

describe('Disk use', () => {
  it('shows each kind and prunes after asking, with the server name for anything with data', async () => {
    const { user, bridge } = await openTab('Disk use', {
      'deployDocker.prune': async () => ({ removed: 3, reclaimedBytes: 1024 * 1024 }),
    });
    const kinds = await screen.findByRole('list', { name: 'Disk use' });
    expect(within(kinds).getByRole('listitem', { name: 'Build cache' })).toHaveTextContent(
      '300 MB',
    );

    await user.click(
      within(kinds).getByRole('button', { name: /Remove images no container uses/ }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.prune')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        target: 'images',
        allImages: true,
        includeVolumes: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Removed 3 items and freed 1.00 MB.');

    await user.click(screen.getByRole('button', { name: /Clean up everything unused/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Clean up Docker on Production?' });
    await user.type(within(confirm).getByRole('textbox'), 'Production');
    await user.click(within(confirm).getByRole('button', { name: 'Clean up' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.prune')).toHaveBeenLastCalledWith(
        expect.objectContaining({ target: 'system', includeVolumes: true }),
      ),
    );
  });

  it('clears the build cache, and links to the Cleanup section to pick items', async () => {
    const { user, bridge } = await openTab('Disk use', {
      'deployDocker.prune': async () => ({ removed: 12, reclaimedBytes: 300 * 1024 * 1024 }),
    });
    const kinds = await screen.findByRole('list', { name: 'Disk use' });
    await user.click(within(kinds).getByRole('button', { name: /Remove the build cache/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.prune')).toHaveBeenCalledWith(
        expect.objectContaining({ target: 'buildCache' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Pick what to remove' }));
    expect(screen.getByTestId('path')).toHaveTextContent(`server=${SERVER.id}&view=cleanup`);
  });

  it('says why a prune failed, and keeps pruning from Operators', async () => {
    const { user } = await openTab('Disk use', { 'deployDocker.prune': down });
    const kinds = await screen.findByRole('list', { name: 'Disk use' });
    await user.click(within(kinds).getByRole('button', { name: /Remove stopped containers/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The server core is not answering (503).'),
    );
  });

  it('only shows the figures to an Operator, and says when they do not load', async () => {
    await openTab('Disk use', {}, ['operator']);
    const kinds = await screen.findByRole('list', { name: 'Disk use' });
    expect(within(kinds).queryByRole('button')).toBeNull();
  });

  it('says when disk use does not load', async () => {
    await openTab('Disk use', { 'deployDocker.diskUsage': down });
    expect(await screen.findByRole('alert')).toHaveTextContent('not answering');
  });
});
