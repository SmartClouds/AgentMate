import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { INSIDE_PROJECT, ok, storage } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ProjectStorageCard } = await import('./ProjectStorageCard');

function renderCard(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(<ProjectStorageCard projectId="p1" />, {
    bridge: {
      'studio.projectStorage': async () => storage(),
      'studio.checkRoot': async () => ok(),
      ...overrides,
    },
  });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('ProjectStorageCard', () => {
  it("shows the project's folder and that it is the default", async () => {
    renderCard();
    expect(await screen.findByText(storage().root)).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use the default' })).not.toBeInTheDocument();
  });

  it('changes the folder once the new one passes the checks', async () => {
    const { user, bridge } = renderCard({
      'studio.setProjectRoot': async () => storage({ root: 'D:\\Shop videos', isCustom: true }),
    });
    await user.click(await screen.findByRole('button', { name: 'Change folder' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Folder');
    await user.clear(field);
    await user.type(field, 'D:\\Shop videos');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(bridge.$fn('studio.setProjectRoot')).toHaveBeenCalledWith('p1', 'D:\\Shop videos'),
    );
    expect(await screen.findByText('D:\\Shop videos')).toBeInTheDocument();
    expect(screen.getByText('Chosen')).toBeInTheDocument();
  });

  it('keeps Save off for a folder inside the project', async () => {
    const { user } = renderCard({ 'studio.checkRoot': async () => ok([INSIDE_PROJECT]) });
    await user.click(await screen.findByRole('button', { name: 'Change folder' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/inside the project's folder/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('goes back to the default folder', async () => {
    const { user, bridge } = renderCard({
      'studio.projectStorage': async () => storage({ root: 'D:\\Custom', isCustom: true }),
      'studio.setProjectRoot': async () => storage(),
    });
    await user.click(await screen.findByRole('button', { name: 'Use the default' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.setProjectRoot')).toHaveBeenCalledWith('p1', null),
    );
    expect(toast.success).toHaveBeenCalledWith('Back to the default folder.');
  });

  it('warns when the folder in use is no longer allowed', async () => {
    renderCard({ 'studio.projectStorage': async () => storage({ check: ok([INSIDE_PROJECT]) }) });
    expect(await screen.findByText(/inside the project's folder/)).toBeInTheDocument();
  });

  it('says why the folder could not be read', async () => {
    renderCard({
      'studio.projectStorage': async () => {
        throw new Error('That project is not in AgentMate any more.');
      },
    });
    expect(
      await screen.findByText('That project is not in AgentMate any more.'),
    ).toBeInTheDocument();
  });

  it('reports a save the service refused', async () => {
    const { user } = renderCard({
      'studio.setProjectRoot': async () => {
        throw new Error('The drive is gone.');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Change folder' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The drive is gone.'));
  });
});
