import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { container } from '../containers/testing/fixtures';
import { cleanupBridge, danglingImage, oldImage, SERVER } from './testing/fixtures';

/**
 * A server's Cleanup section: what Docker keeps that nothing uses, picked by kind, age or name,
 * removed in one go after asking (with the server's name for volumes), a refusal that leaves the
 * rest alone, what each role may remove, and the build cache cleared on its own.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { CleanupPanel } = await import('./CleanupPanel');

const down = () => Promise.reject(new Error('The server core is not answering (503).'));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
}

function open(
  roles: string[] = ['owner'],
  overrides: Record<string, unknown> = {},
  onUpdateCore?: () => void,
) {
  return renderWithProviders(
    <>
      <CleanupPanel server={SERVER} onUpdateCore={onUpdateCore} />
      <ConfirmDialogHost />
      <LocationProbe />
    </>,
    { bridge: cleanupBridge(roles, overrides) },
  );
}

async function group(name: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name }, { timeout: 10_000 });
}

function row(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name: `Select ${name}` });
}

describe('CleanupPanel', () => {
  it('lists only what nothing uses, grouped by kind, with sizes and the total that could go', async () => {
    open();
    const images = await group('Images');
    expect(within(images).getByText('shop-api:0.9')).toBeInTheDocument();
    expect(within(images).getByText('b2b2b2b2b2b2')).toBeInTheDocument();
    expect(within(images).getByText('Untagged')).toBeInTheDocument();
    expect(within(images).getByText('300 MB')).toBeInTheDocument();
    expect(within(images).queryByText('nginx:1.29')).toBeNull();
    expect(within(await group('Containers')).getByText('migrate-once')).toBeInTheDocument();
    expect(within(await group('Volumes')).getByText('old-cache')).toBeInTheDocument();
    const networks = await group('Networks');
    expect(within(networks).getByText('oldshop_default')).toBeInTheDocument();
    expect(within(networks).queryByText('bridge')).toBeNull();
    expect(within(networks).queryByText('shop_default')).toBeNull();
    expect(screen.getByText(/Docker uses .+ on Production/)).toBeInTheDocument();
  });

  it('narrows the list by kind, age and name, and can reset the filters', async () => {
    const { user } = open();
    await group('Images');
    await user.click(screen.getByRole('button', { name: /^Volumes/ }));
    expect(screen.queryByRole('region', { name: 'Images' })).toBeNull();
    expect(within(await group('Volumes')).getByText('old-cache')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^All/ }));
    await user.click(screen.getByRole('button', { name: 'Over a month' }));
    const images = await group('Images');
    expect(within(images).getByText('shop-api:0.9')).toBeInTheDocument();
    expect(within(images).queryByText('b2b2b2b2b2b2')).toBeNull();
    // A volume Docker gives no date for has no age to go by.
    expect(screen.queryByRole('region', { name: 'Volumes' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Any age' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter unused items' }), 'nothing-x');
    expect(await screen.findByText('No unused items match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(await group('Images')).toBeInTheDocument();
  });

  it('selects a whole group or single rows, and says what the selection frees', async () => {
    const { user } = open();
    const images = await group('Images');
    const all = within(images).getByRole('checkbox', { name: 'Select all images' });
    await user.click(row('shop-api:0.9'));
    expect(all).toHaveAttribute('data-state', 'indeterminate');
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(bar).toHaveTextContent('1 selected');
    expect(bar).toHaveTextContent('frees about 300 MB');

    await user.click(all);
    expect(all).toHaveAttribute('data-state', 'checked');
    expect(bar).toHaveTextContent('2 selected');
    expect(bar).toHaveTextContent('frees about 340 MB');

    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('removes the selection after asking, stopped containers before their images', async () => {
    const { user, bridge } = open();
    await group('Images');
    await user.click(row('shop-api:0.9'));
    await user.click(row('migrate-once'));
    await user.click(screen.getByRole('button', { name: 'Remove selected' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove 2 items from Production?' });
    expect(confirm).toHaveTextContent('shop-api:0.9');
    expect(confirm).toHaveTextContent('migrate-once');
    expect(within(confirm).queryByRole('textbox')).toBeNull();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Removed 2 items and freed 300 MB.'),
    );
    const removeContainer = bridge.$fn('deployDocker.remove');
    const removeImage = bridge.$fn('deployDocker.removeImage');
    expect(removeContainer).toHaveBeenCalledWith({
      serverId: SERVER.id,
      containerId: container('migrate-once').id,
      removeVolumes: false,
      force: false,
    });
    expect(removeImage).toHaveBeenCalledWith({
      serverId: SERVER.id,
      image: oldImage().id,
      force: false,
    });
    expect(removeContainer.mock.invocationCallOrder[0]).toBeLessThan(
      removeImage.mock.invocationCallOrder[0],
    );
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('asks for the server name before removing a volume, and stops if the answer is no', async () => {
    const { user, bridge } = open();
    await group('Volumes');
    await user.click(row('old-cache'));
    await user.click(screen.getByRole('button', { name: 'Remove selected' }));
    let confirm = await screen.findByRole('dialog', { name: 'Remove 1 item from Production?' });
    expect(confirm).toHaveTextContent('Data in removed volumes cannot be brought back.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Remove selected' }));
    confirm = await screen.findByRole('dialog', { name: 'Remove 1 item from Production?' });
    const go = within(confirm).getByRole('button', { name: 'Remove' });
    expect(go).toBeDisabled();
    await user.type(within(confirm).getByRole('textbox'), 'Production');
    await user.click(go);
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.removeVolume')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        volume: 'old-cache',
        force: false,
      }),
    );
    // The first answer was no, so this is the only removal.
    expect(bridge.$fn('deployDocker.removeVolume')).toHaveBeenCalledOnce();
  });

  it('keeps going past a refusal and leaves the refused item selected with the reason', async () => {
    const refused = (input: { image: string }) =>
      input.image === danglingImage().id
        ? Promise.reject(
            new Error(
              "Error invoking remote method 'deployDocker:removeImage': Error: image has dependent child images",
            ),
          )
        : Promise.resolve();
    const { user } = open(['owner'], { 'deployDocker.removeImage': refused });
    const images = await group('Images');
    await user.click(within(images).getByRole('checkbox', { name: 'Select all images' }));
    await user.click(screen.getByRole('button', { name: 'Remove selected' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove 2 items from Production?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Removed 1 of 2. 1 could not be removed.'),
    );
    expect(await screen.findByText('image has dependent child images')).toBeInTheDocument();
    expect(row('b2b2b2b2b2b2')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('1 selected');
  });

  it('lets a Viewer look only, and keeps volumes from Operators', async () => {
    const viewer = open(['viewer']);
    await group('Images');
    expect(row('shop-api:0.9')).toBeDisabled();
    expect(screen.getByText(/Removing needs an Operator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear build cache' })).toBeNull();
    viewer.unmount();

    open(['operator']);
    await group('Volumes');
    expect(row('shop-api:0.9')).toBeEnabled();
    expect(row('old-cache')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Clear build cache' })).toBeNull();
  });

  it('says when there is nothing to clean up', async () => {
    open(['owner'], {
      'deployDocker.listImages': [],
      'deployDocker.listContainers': { groups: [] },
      'deployDocker.listVolumes': [],
      'deployDocker.listNetworks': [],
    });
    expect(
      await screen.findByText('Nothing to clean up on Production', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it('says when the lists do not load, and tries again', async () => {
    const { user, bridge } = open(['owner'], { 'deployDocker.listImages': down });
    expect(await screen.findByRole('alert', {}, { timeout: 10_000 })).toHaveTextContent(
      'not answering',
    );
    bridge.$set('deployDocker.listImages', [oldImage()]);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(within(await group('Images')).getByText('shop-api:0.9')).toBeInTheDocument();
  });

  it('points to the Containers section when Docker is not there yet', async () => {
    const { user } = open(['owner'], {
      'deployDocker.status': {
        installed: false,
        running: false,
        composeSupported: false,
        conflictingPackages: [],
      },
    });
    expect(
      await screen.findByText(/Docker is not installed on Production/, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Containers' }));
    expect(screen.getByTestId('path')).toHaveTextContent(`server=${SERVER.id}&view=containers`);
  });

  it('asks the user to sign in first', async () => {
    open(['owner'], { 'deploy.access': { state: 'needs-sign-in' } });
    expect(await screen.findByText('Not signed in', {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it('clears the build cache after asking', async () => {
    const { user, bridge } = open();
    const card = await screen.findByRole('region', { name: 'Build cache' }, { timeout: 10_000 });
    expect(card).toHaveTextContent('300 MB');
    await user.click(within(card).getByRole('button', { name: 'Clear build cache' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Clear the build cache on Production?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.prune')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        target: 'buildCache',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Cleared the build cache and freed 300 MB.');
  });

  it('offers the core update when an older core cannot clear the build cache', async () => {
    const onUpdateCore = vi.fn();
    const older = () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'deployDocker:prune': Error: This server runs an older core that cannot clear the build cache. Update the core from the Overview, then try again.",
        ),
      );
    const { user } = open(['owner'], { 'deployDocker.prune': older }, onUpdateCore);
    const card = await screen.findByRole('region', { name: 'Build cache' }, { timeout: 10_000 });
    await user.click(within(card).getByRole('button', { name: 'Clear build cache' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Clear the build cache on Production?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Clear' }));
    expect(await within(card).findByText(/older core/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Update the core' }));
    expect(onUpdateCore).toHaveBeenCalledOnce();
  });
});
