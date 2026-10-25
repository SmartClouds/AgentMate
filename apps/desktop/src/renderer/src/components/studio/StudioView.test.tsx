import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { fieldSecondsToFlicks, flicksToFieldSeconds, formatWhen, scriptClass } from './format';
import { ProjectStudioSection } from './project/ProjectStudioSection';
import { studioKeys } from './queryKeys';
import { StudioView } from './StudioView';
import { opened, PROJECT, storage, video } from './testing/fixtures';

describe('StudioView', () => {
  it('shows the library, and opens a video in the editor', async () => {
    const navigate = vi.fn();
    const { user } = renderWithProviders(<StudioView videoId={null} navigate={navigate} />, {
      bridge: { 'projects.list': async () => [PROJECT], 'studio.list': async () => [video()] },
    });
    await user.click(await screen.findByRole('button', { name: 'Launch film' }));
    expect(navigate).toHaveBeenCalledWith(`/studio/${video().id}`);
  });

  it('shows the editor for an open video, with a way back', async () => {
    const navigate = vi.fn();
    const { user } = renderWithProviders(<StudioView videoId={video().id} navigate={navigate} />, {
      bridge: { 'studio.open': async () => opened(), 'studio.history': async () => [] },
    });
    await user.click(await screen.findByRole('button', { name: /Studio/ }));
    expect(navigate).toHaveBeenCalledWith('/studio');
  });

  it('refreshes the library when the service says it changed', async () => {
    const { bridge, queryClient } = renderWithProviders(
      <StudioView videoId={null} navigate={vi.fn()} />,
      {
        bridge: { 'studio.list': async () => [] },
      },
    );
    await screen.findByText('No videos yet');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    bridge.$emit('studio.onEvent', { type: 'library-changed' });
    bridge.$emit('studio.onEvent', { type: 'video-changed', videoId: 'v1', seq: 4 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: studioKeys.videos });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: studioKeys.history('v1') });
  });
});

describe('ProjectStudioSection', () => {
  it("lists the project's videos with its folder, and makes a new one for it", async () => {
    const onOpen = vi.fn();
    const { user, bridge } = renderWithProviders(
      <ProjectStudioSection projectId="p1" onOpen={onOpen} />,
      {
        bridge: {
          'studio.list': async () => [],
          'studio.projectStorage': async () => storage(),
          'projects.list': async () => [PROJECT],
        },
      },
    );
    expect(await screen.findByText(storage().root)).toBeInTheDocument();
    expect(bridge.$fn('studio.list')).toHaveBeenCalledWith({ projectId: 'p1' });
    await user.click(screen.getAllByRole('button', { name: /New video/ })[0] as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'New video' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(storage().root, { selector: 'span' })).toBeInTheDocument(),
    );
  });
});

describe('format', () => {
  it('says how long ago something happened', () => {
    const now = 1_000_000_000_000;
    expect(formatWhen(now - 10_000, now)).toBe('just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatWhen(now - 26 * 3600_000, now)).toBe('yesterday');
  });

  it('turns scene lengths into seconds and back', () => {
    expect(flicksToFieldSeconds(705_600_000 * 5)).toBe('5');
    expect(flicksToFieldSeconds(705_600_000 * 2.5)).toBe('2.5');
    expect(fieldSecondsToFlicks('2,5')).toBe(705_600_000 * 2.5);
    expect(fieldSecondsToFlicks('abc')).toBeNull();
    expect(fieldSecondsToFlicks('601')).toBeNull();
  });

  it('gives Persian text the Persian font and leaves other text alone', () => {
    expect(scriptClass('سلام')).toBe('font-vazirmatn');
    expect(scriptClass('Hello')).toBeUndefined();
  });
});
