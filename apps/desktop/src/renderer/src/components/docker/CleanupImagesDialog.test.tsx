import type { DockerImage } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The Clean up dialog. What matters is that nothing is removed by surprise: only dangling images
 * start ticked, the space it shows matches what is ticked, and an image docker refuses to remove
 * stays on screen with docker's reason instead of vanishing in a toast.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { CleanupImagesDialog } = await import('./CleanupImagesDialog');

function image(overrides: Partial<DockerImage>): DockerImage {
  return {
    id: 'sha256:x',
    tags: [],
    dangling: false,
    createdAt: null,
    createdSince: '1 day ago',
    sizeBytes: 1024 ** 2,
    containers: 0,
    ...overrides,
  };
}

const danglingA = image({ id: 'sha256:aaaaaaaaaaaa01', dangling: true, sizeBytes: 10 * 1024 ** 2 });
const danglingB = image({ id: 'sha256:bbbbbbbbbbbb02', dangling: true, sizeBytes: 5 * 1024 ** 2 });
const oldNode = image({ id: 'sha256:cccccccccccc03', tags: ['node:18'], sizeBytes: 1024 ** 3 });
const oldRedis = image({ id: 'sha256:dddddddddddd04', tags: ['redis:6', 'redis:6.2'] });

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const onDone = vi.fn();
  const view = renderWithProviders(
    <CleanupImagesDialog
      open
      images={[danglingA, danglingB, oldNode, oldRedis]}
      onOpenChange={onOpenChange}
      onDone={onDone}
    />,
    { bridge: { 'docker.removeImages': { removed: [], failed: [] }, ...bridge } },
  );
  return { ...view, onOpenChange, onDone, dialog: screen.getByRole('dialog') };
}

describe('CleanupImagesDialog', () => {
  it('starts with only the dangling images ticked', () => {
    const { dialog } = renderDialog();

    expect(within(dialog).getByRole('checkbox', { name: 'aaaaaaaaaaaa' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'bbbbbbbbbbbb' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'node:18' })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'redis:6' })).not.toBeChecked();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Frees up to 15.0 MB');
    expect(within(dialog).getByRole('button', { name: 'Remove 2 images' })).toBeEnabled();
  });

  it('ticks a whole group at once and shows a partly ticked group as mixed', async () => {
    const { user, dialog } = renderDialog();
    const tagged = within(dialog).getByRole('checkbox', {
      name: 'Select all unused tagged images',
    });

    await user.click(tagged);
    expect(within(dialog).getByRole('checkbox', { name: 'node:18' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'redis:6' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Remove 4 images' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: 'node:18' }));
    expect(tagged).toHaveAttribute('aria-checked', 'mixed');
  });

  it('keeps Remove disabled while nothing is ticked', async () => {
    const { user, dialog } = renderDialog();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Select all dangling images' }));

    expect(within(dialog).getByRole('button', { name: /Remove/ })).toBeDisabled();
  });

  it('removes what is ticked, says how much, and closes', async () => {
    const { user, dialog, bridge, onDone, onOpenChange } = renderDialog({
      'docker.removeImages': { removed: [danglingA.id, danglingB.id], failed: [] },
    });

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 images' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.$fn('docker.removeImages')).toHaveBeenCalledWith([
      { id: danglingA.id, tags: [] },
      { id: danglingB.id, tags: [] },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Removed 2 images, freeing up to 15.0 MB.');
    expect(onDone).toHaveBeenCalled();
  });

  it("stays open on a refusal and shows docker's reason beside that image", async () => {
    const { user, dialog, onDone, onOpenChange } = renderDialog({
      'docker.removeImages': {
        removed: [danglingA.id],
        failed: [{ id: danglingB.id, error: 'conflict: image has dependent child images' }],
      },
    });

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 images' }));

    expect(await within(dialog).findByText(/image has dependent child images/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The list behind the dialog still has to drop the one that did go.
    expect(onDone).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Removed 1 of 2 images.');
  });

  it('reports a failed call without closing', async () => {
    const { user, dialog, onOpenChange } = renderDialog({
      'docker.removeImages': () => Promise.reject(new Error('Docker is not running.')),
    });

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 images' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Docker is not running.'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
