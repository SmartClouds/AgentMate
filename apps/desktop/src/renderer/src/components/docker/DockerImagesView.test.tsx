import type { DockerImage } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The images on this machine. A user comes here to see what takes up space and to get rid of
 * what nothing uses, so the view has to say clearly which images are in use, refuse to remove
 * those, and ask before removing anything else.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { DockerImagesView } = await import('./DockerImagesView');

function image(overrides: Partial<DockerImage>): DockerImage {
  return {
    id: 'sha256:x',
    tags: [],
    dangling: false,
    createdAt: null,
    createdSince: '2 weeks ago',
    sizeBytes: 1024 ** 2,
    containers: 0,
    ...overrides,
  };
}

const nginx = image({
  id: 'sha256:aaaaaaaaaaaa01',
  tags: ['nginx:1.27', 'nginx:latest'],
  containers: 2,
  sizeBytes: 187 * 1024 ** 2,
});
const node = image({ id: 'sha256:bbbbbbbbbbbb02', tags: ['node:18'], sizeBytes: 1024 ** 3 });
const dangling = image({ id: 'sha256:cccccccccccc03', dangling: true });

function renderView(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <DockerImagesView />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'docker.listImages': [nginx, node, dangling],
        'docker.removeImages': { removed: [node.id], failed: [] },
        ...bridge,
      },
    },
  );
}

describe('DockerImagesView', () => {
  it('lists each image once with its tags, size and whether a container uses it', async () => {
    renderView();

    const nginxRow = await screen.findByRole('listitem', { name: 'nginx:1.27' });
    expect(within(nginxRow).getByText('nginx')).toBeInTheDocument();
    expect(within(nginxRow).getByText('1.27')).toBeInTheDocument();
    expect(within(nginxRow).getByText('latest')).toBeInTheDocument();
    expect(within(nginxRow).getByText('187 MB')).toBeInTheDocument();
    expect(within(nginxRow).getByText('In use · 2')).toBeInTheDocument();

    const nodeRow = screen.getByRole('listitem', { name: 'node:18' });
    expect(within(nodeRow).getByText('Unused')).toBeInTheDocument();

    const danglingRow = screen.getByRole('listitem', { name: 'cccccccccccc' });
    expect(within(danglingRow).getByText('Dangling')).toBeInTheDocument();
  });

  it('counts the images and the unused ones in the toolbar', async () => {
    renderView();

    await screen.findByRole('listitem', { name: 'nginx:1.27' });
    const counts = screen.getByRole('group', { name: 'Image counts' });
    expect(counts).toHaveTextContent('Images3');
    expect(counts).toHaveTextContent('Unused2');
  });

  it('narrows the list to unused images and back', async () => {
    const { user } = renderView();
    await screen.findByRole('listitem', { name: 'nginx:1.27' });

    await user.click(screen.getByRole('button', { name: 'Unused', pressed: false }));

    expect(screen.queryByRole('listitem', { name: 'nginx:1.27' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'node:18' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'In use', pressed: false }));

    expect(screen.getByRole('listitem', { name: 'nginx:1.27' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'node:18' })).not.toBeInTheDocument();
  });

  it('says when a search finds nothing', async () => {
    const { user } = renderView();
    await screen.findByRole('listitem', { name: 'nginx:1.27' });

    await user.type(screen.getByRole('textbox', { name: 'Search images' }), 'postgres');

    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('will not remove an image a container uses, and says why', async () => {
    renderView();

    const row = await screen.findByRole('listitem', { name: 'nginx:1.27' });

    expect(within(row).getByRole('button', { name: 'Remove nginx:1.27' })).toBeDisabled();
  });

  it('removes an unused image after asking, by its tags', async () => {
    const { user, bridge } = renderView();
    const row = await screen.findByRole('listitem', { name: 'node:18' });

    await user.click(within(row).getByRole('button', { name: 'Remove node:18' }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Remove image' }));

    await waitFor(() =>
      expect(bridge.$fn('docker.removeImages')).toHaveBeenCalledWith([
        { id: node.id, tags: ['node:18'] },
      ]),
    );
    expect(toast.success).toHaveBeenCalledWith('Removed node:18.');
  });

  it("shows docker's reason when it refuses", async () => {
    const { user } = renderView({
      'docker.removeImages': {
        removed: [],
        failed: [{ id: node.id, error: 'conflict: image is being used by a new container' }],
      },
    });
    const row = await screen.findByRole('listitem', { name: 'node:18' });

    await user.click(within(row).getByRole('button', { name: 'Remove node:18' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove image' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('conflict: image is being used by a new container'),
    );
  });

  it('opens the clean up dialog with the unused images', async () => {
    const { user } = renderView();
    await screen.findByRole('listitem', { name: 'nginx:1.27' });

    await user.click(screen.getByRole('button', { name: /Clean up/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Clean up unused images' });
    expect(within(dialog).getByRole('checkbox', { name: 'node:18' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'nginx:1.27' })).not.toBeInTheDocument();
  });

  it('offers no clean up when every image is in use', async () => {
    renderView({ 'docker.listImages': [nginx] });
    await screen.findByRole('listitem', { name: 'nginx:1.27' });

    expect(screen.getByRole('button', { name: /Clean up/ })).toBeDisabled();
  });

  it('says when there are no images at all', async () => {
    renderView({ 'docker.listImages': [] });

    expect(await screen.findByText('No images on this machine')).toBeInTheDocument();
  });

  it('shows a failed load with a way to try again', async () => {
    renderView({
      'docker.listImages': () => Promise.reject(new Error('Cannot connect to the Docker daemon')),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot connect to the Docker daemon');
    expect(within(alert).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});
