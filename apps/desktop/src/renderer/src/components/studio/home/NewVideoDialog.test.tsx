import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { INSIDE_PROJECT, ok, PROJECT, settings, storage, video } from '../testing/fixtures';
import { NewVideoDialog } from './NewVideoDialog';

function renderDialog(projectId: string | null = null, overrides: Record<string, unknown> = {}) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <NewVideoDialog open onOpenChange={onOpenChange} projectId={projectId} onCreated={onCreated} />,
    {
      bridge: {
        'projects.list': async () => [
          PROJECT,
          { ...PROJECT, id: 'p2', name: 'Old', archived: true },
        ],
        'studio.settings': async () => settings(),
        'studio.projectStorage': async () => storage(),
        'studio.create': async () => video(),
        ...overrides,
      },
    },
  );
  return { ...view, onCreated, onOpenChange };
}

describe('NewVideoDialog', () => {
  it('creates a standalone Persian video by default and says where it will be saved', async () => {
    const { user, bridge, onCreated, onOpenChange } = renderDialog();
    expect(await screen.findByText(settings().standaloneRoot)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'معرفی محصول');
    await user.click(screen.getByRole('radio', { name: 'Vertical 9:16' }));
    await user.click(screen.getByRole('button', { name: 'Create video' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.create')).toHaveBeenCalledWith({
        title: 'معرفی محصول',
        projectId: null,
        language: 'fa',
        aspect: '9:16',
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(video());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot create a video without a title', async () => {
    renderDialog();
    expect(await screen.findByRole('button', { name: 'Create video' })).toBeDisabled();
  });

  it("uses the project's folder when opened from a project", async () => {
    const { user, bridge } = renderDialog('p1');
    expect(await screen.findByText(storage().root)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Teaser');
    await user.click(screen.getByRole('button', { name: 'Create video' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.create')).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1' }),
      ),
    );
  });

  it('will not create a project video while its folder is not allowed, and says why', async () => {
    const { user } = renderDialog('p1', {
      'studio.projectStorage': async () => storage({ check: ok([INSIDE_PROJECT]) }),
    });
    expect(await screen.findByText(/inside the project's folder/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Teaser');
    expect(screen.getByRole('button', { name: 'Create video' })).toBeDisabled();
  });

  it('shows what went wrong when the video could not be made', async () => {
    const { user } = renderDialog(null, {
      'studio.create': async () => {
        throw new Error("Error invoking remote method 'studio:create': Error: The disk is full.");
      },
    });
    await user.type(await screen.findByLabelText('Title'), 'Film');
    await user.click(screen.getByRole('button', { name: 'Create video' }));
    expect(await screen.findByText('The disk is full.')).toBeInTheDocument();
  });

  it('offers no Chinese among the languages', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('combobox', { name: 'Language' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('Persian (فارسی)');
    expect(options.some((o) => /chinese/i.test(o.textContent ?? ''))).toBe(false);
  });
});
