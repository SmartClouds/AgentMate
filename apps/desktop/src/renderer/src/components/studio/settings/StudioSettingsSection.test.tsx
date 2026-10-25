import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ok, settings } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { StudioSettingsSection } = await import('./StudioSettingsSection');

function renderSection(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(<StudioSettingsSection />, {
    bridge: {
      'studio.settings': async () => settings(),
      'studio.checkRoot': async () => ok(),
      'studio.updateSettings': async (patch: object) => settings(patch),
      ...overrides,
    },
  });
}

beforeEach(() => toast.error.mockClear());

describe('StudioSettingsSection', () => {
  it('shimmers until the settings arrive', () => {
    const { container } = renderSection({ 'studio.settings': () => new Promise(() => undefined) });
    expect(container.querySelector('.shimmer')).not.toBeNull();
  });

  it('saves a new library folder once it passes the checks', async () => {
    const { user, bridge } = renderSection();
    const field = await screen.findByLabelText('Studio library folder');
    const save = screen.getByRole('button', { name: 'Save folder' });
    expect(save).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'D:\\Studio');
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(bridge.$fn('studio.updateSettings')).toHaveBeenCalledWith({
        defaultRoot: 'D:\\Studio',
      }),
    );
  });

  it('goes back to the default library folder', async () => {
    const { user, bridge } = renderSection({
      'studio.settings': async () =>
        settings({ defaultRoot: 'D:\\Studio', defaultRootIsCustom: true }),
    });
    await user.click(await screen.findByRole('button', { name: 'Use the default' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.updateSettings')).toHaveBeenCalledWith({ defaultRoot: null }),
    );
  });

  it('saves a working files limit, and refuses one that is not a whole number in range', async () => {
    const { user, bridge } = renderSection();
    const cap = await screen.findByLabelText('Working files limit (GB)');
    await user.clear(cap);
    await user.type(cap, '0');
    expect(screen.getByText('Enter a whole number from 1 to 2000.')).toBeInTheDocument();
    await user.tab();
    expect(() => bridge.$fn('studio.updateSettings')).toThrow();
    await user.clear(cap);
    await user.type(cap, '50');
    await user.tab();
    await waitFor(() =>
      expect(bridge.$fn('studio.updateSettings')).toHaveBeenCalledWith({ cacheCapGb: 50 }),
    );
  });

  it('turns resuming renders and hardware encoding off', async () => {
    const { user, bridge } = renderSection();
    await user.click(await screen.findByRole('switch', { name: /Resume renders after a restart/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.updateSettings')).toHaveBeenCalledWith({
        autoResumeRenders: false,
      }),
    );
    await user.click(screen.getByRole('switch', { name: /Use the graphics card to encode/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.updateSettings')).toHaveBeenCalledWith({ hwEncode: false }),
    );
  });

  it('reports a change the service refused', async () => {
    const { user } = renderSection({
      'studio.updateSettings': async () => {
        throw new Error("AgentMate can't write to this folder.");
      },
    });
    await user.click(
      await screen.findByRole('switch', { name: /Use the graphics card to encode/ }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("AgentMate can't write to this folder."),
    );
  });
});
