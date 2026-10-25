import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { video } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { VideoCard } = await import('./VideoCard');

function renderCard(
  props: Partial<Parameters<typeof VideoCard>[0]> = {},
  overrides: Record<string, unknown> = {},
) {
  const onOpen = vi.fn();
  const view = renderWithProviders(<VideoCard video={video()} onOpen={onOpen} {...props} />, {
    bridge: overrides,
  });
  return { ...view, onOpen };
}

async function openMenu(user: ReturnType<typeof renderCard>['user']) {
  await user.click(screen.getByRole('button', { name: 'More for Launch film' }));
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
});

describe('VideoCard', () => {
  it('shows Persian titles right to left', () => {
    renderCard({ video: video({ title: 'فیلم معرفی' }) });
    expect(screen.getByText('فیلم معرفی')).toHaveAttribute('dir', 'rtl');
  });

  it('says when it was last opened', () => {
    renderCard({ video: video({ lastOpenedAt: Date.now() - 2 * 3600_000 }) });
    expect(screen.getByText('Opened 2 hours ago')).toBeInTheDocument();
  });

  it('opens the folder in the file manager', async () => {
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Open folder/ }));
    expect(bridge.$fn('studio.revealVideo')).toHaveBeenCalledWith(video().id);
  });

  it('moves a video and puts the old copy in the trash when the user agrees', async () => {
    const moved = video({ folder: 'D:\\Archive\\Launch-film-v1aaaaaa' });
    const { user, bridge } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'D:\\Archive',
        'studio.move': async () => ({ video: moved, oldFolder: video().folder }),
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.trashOldFolder')).toHaveBeenCalledWith(video().folder),
    );
    expect(bridge.$fn('studio.move')).toHaveBeenCalledWith(video().id, 'D:\\Archive');
  });

  it('keeps the old copy when the user says so', async () => {
    confirm.mockResolvedValue(false);
    const { user, bridge } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'D:\\Archive',
        'studio.move': async () => ({ video: video(), oldFolder: video().folder }),
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.trashOldFolder')).toThrow();
  });

  it('explains a move that failed', async () => {
    const { user } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'C:\\code\\shop',
        'studio.move': async () => {
          throw new Error("Videos can't be stored inside the project's folder.");
        },
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Videos can't be stored inside the project's folder.",
      ),
    );
  });

  it('removes a video from the library after asking, keeping its files', async () => {
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Remove from library/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.removeFromLibrary')).toHaveBeenCalledWith(video().id),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Remove from library' }),
    );
  });

  it('leaves it in the library when the user cancels', async () => {
    confirm.mockResolvedValue(false);
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Remove from library/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.removeFromLibrary')).toThrow();
  });

  it('offers to locate a video whose folder disappeared, and cannot open it meanwhile', async () => {
    const { user, bridge, onOpen } = renderCard(
      { video: video({ missing: true }) },
      {
        'studio.pickFolder': async () => 'D:\\Found',
        'studio.locate': async () => video({ folder: 'D:\\Found' }),
      },
    );
    expect(screen.getByText(/The folder is gone/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Launch film' }));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Locate' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.locate')).toHaveBeenCalledWith(video().id, 'D:\\Found'),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('explains a folder that is not this video', async () => {
    const { user } = renderCard(
      { video: video({ missing: true }) },
      {
        'studio.pickFolder': async () => 'D:\\Other',
        'studio.locate': async () => {
          throw new Error('That folder holds a different video.');
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Locate' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That folder holds a different video.'),
    );
  });

  it('names the project, or says it was removed', () => {
    const { unmount } = renderCard({
      video: video({ linkedProjectId: 'p1' }),
      projectName: 'Shop',
    });
    expect(screen.getByText('Shop')).toBeInTheDocument();
    unmount();
    renderCard({ video: video({ linkedProjectId: 'gone' }), projectName: null });
    expect(screen.getByText('Removed project')).toBeInTheDocument();
  });
});
