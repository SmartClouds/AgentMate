import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { storage } from '../testing/fixtures';
import { SceneNetworkCard } from './SceneNetworkCard';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

describe('SceneNetworkCard', () => {
  it('says scenes reach no network by default, and saves the hosts typed one per line', async () => {
    const { user, bridge } = renderWithProviders(<SceneNetworkCard projectId="p1" />, {
      bridge: {
        'studio.projectStorage': async () => storage(),
        'studio.setSceneHosts': async () =>
          storage({ sceneHosts: ['cdn.example.com', 'fonts.example.org'] }),
      },
    });
    expect(await screen.findByText(/cannot reach the internet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.type(
      screen.getByLabelText('Hosts scenes may load from, one per line'),
      'cdn.example.com{Enter}fonts.example.org',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.setSceneHosts')).toHaveBeenCalledWith('p1', [
        'cdn.example.com',
        'fonts.example.org',
      ]),
    );
    expect(await screen.findByText('fonts.example.org')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Scenes in this project may load from those hosts.');
  });

  it('shows why the hosts were not saved', async () => {
    const { user } = renderWithProviders(<SceneNetworkCard projectId="p1" />, {
      bridge: {
        'studio.projectStorage': async () => storage({ sceneHosts: ['cdn.example.com'] }),
        'studio.setSceneHosts': async () => {
          throw new Error(
            "Error invoking remote method 'studio:setSceneHosts': Error: Enter a host name such as cdn.example.com.",
          );
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Hosts scenes may load from, one per line')).toHaveValue(
      'cdn.example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Enter a host name such as cdn.example.com.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('cdn.example.com')).toBeInTheDocument();
  });
});
