import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PROJECT, settings, video } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { StudioHome } = await import('./StudioHome');

function renderHome(overrides: Record<string, unknown> = {}) {
  const onOpen = vi.fn();
  const view = renderWithProviders(<StudioHome onOpen={onOpen} />, {
    bridge: {
      'projects.list': async () => [PROJECT],
      'studio.list': async () => [],
      'studio.settings': async () => settings(),
      ...overrides,
    },
  });
  return { ...view, onOpen };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('StudioHome', () => {
  it('shimmers a card at a time while the library loads', () => {
    renderHome({ 'studio.list': () => new Promise(() => undefined) });
    expect(screen.getByLabelText('Loading videos')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers to make the first video when the library is empty', async () => {
    const { user } = renderHome();
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /New video/ });
    await user.click(buttons.at(-1) as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'New video' })).toBeInTheDocument();
  });

  it('shows each video with the project it belongs to, and opens one on click', async () => {
    const forProject = video({
      id: 'v2bbbbbbbbbbbbbb',
      title: 'Shop teaser',
      linkedProjectId: 'p1',
    });
    const { user, onOpen } = renderHome({ 'studio.list': async () => [forProject, video()] });
    const card = await screen.findByRole('article', { name: 'Shop teaser' });
    expect(within(card).getByText('Shop')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Launch film' })).getByText('Standalone'),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Shop teaser' }));
    expect(onOpen).toHaveBeenCalledWith(forProject);
  });

  it('lists only standalone videos when asked', async () => {
    const { user, bridge } = renderHome();
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('radio', { name: 'Standalone' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.list')).toHaveBeenCalledWith({ projectId: null }),
    );
  });

  it('says so when the library does not load, and tries again', async () => {
    let calls = 0;
    const { user } = renderHome({
      'studio.list': async () => {
        calls += 1;
        if (calls === 1) throw new Error('disk gone');
        return [];
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('disk gone');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
  });

  it('adds an existing video folder', async () => {
    const { user, bridge } = renderHome({
      'studio.pickFolder': async () => 'D:\\Old\\Film-abc',
      'studio.addExisting': async () => video({ title: 'Old film' }),
    });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.addExisting')).toHaveBeenCalledWith('D:\\Old\\Film-abc'),
    );
    expect(toast.success).toHaveBeenCalledWith('Added "Old film" to the library.');
  });

  it('explains why a folder could not be added', async () => {
    const { user } = renderHome({
      'studio.pickFolder': async () => 'D:\\Random',
      'studio.addExisting': async () => {
        throw new Error(
          "Error invoking remote method 'studio:addExisting': Error: D:\\Random is not a Studio video folder.",
        );
      },
    });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('D:\\Random is not a Studio video folder.'),
    );
  });

  it('does nothing when the folder picker is cancelled', async () => {
    const { user, bridge } = renderHome({ 'studio.pickFolder': async () => null });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() => expect(bridge.$fn('studio.pickFolder')).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.addExisting')).toThrow();
  });
});
