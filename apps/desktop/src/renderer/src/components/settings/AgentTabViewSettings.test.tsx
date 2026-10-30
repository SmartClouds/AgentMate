import { DEFAULT_SETTINGS } from '@shared/defaultSettings';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { AgentTabViewSettings } from './AgentTabViewSettings';

/** Whether a Workspace agent tab opens as its CLI or as a chat, until that tab is switched. */

/** Settings that remember what was saved, the way main does. */
function render(saved: Record<string, unknown> = {}) {
  let current = { ...DEFAULT_SETTINGS, ...saved };
  return renderWithProviders(<AgentTabViewSettings />, {
    bridge: {
      'settings.get': async () => current,
      'settings.update': async (patch: object) => {
        current = { ...current, ...patch };
        return current;
      },
    },
  });
}

describe('AgentTabViewSettings', () => {
  it('opens agent tabs in the CLI by default', async () => {
    render();
    expect(await screen.findByRole('button', { name: /^CLI/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('saves chat as the default view', async () => {
    const { user, bridge } = render();
    await user.click(await screen.findByRole('button', { name: /^Chat/ }));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ defaultAgentTabMode: 'chat' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('shows the saved default', async () => {
    render({ defaultAgentTabMode: 'chat' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-pressed', 'true'),
    );
  });
});
