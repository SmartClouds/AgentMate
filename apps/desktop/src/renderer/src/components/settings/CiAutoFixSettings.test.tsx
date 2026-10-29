import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CiAutoFixSettings } from './CiAutoFixSettings';

/**
 * The CLI auto-fix uses unless a run says otherwise, with its model and how many tries a run
 * gets. A model belongs to one CLI, so changing the CLI clears the model and effort with it.
 */

const installed = ['claude-code', 'codex-cli'].map((id) => ({ id, installed: true }));

function render(saved: Record<string, unknown> = {}) {
  return renderWithProviders(<CiAutoFixSettings />, {
    bridge: {
      'cli.detectAll': installed,
      'settings.get': {
        ciAutoFixCliId: null,
        ciAutoFixModel: null,
        ciAutoFixEffort: null,
        ciAutoFixMaxAttempts: 3,
        ...saved,
      },
      'settings.update': async (patch: unknown) => patch,
    },
  });
}

describe('CiAutoFixSettings', () => {
  it("uses the project's own CLI until one is picked", async () => {
    render();
    expect(
      await screen.findByRole('combobox', { name: 'Agent CLI for auto-fix' }),
    ).toHaveTextContent("Each project's CLI");
    expect(screen.queryByRole('combobox', { name: 'Model for auto-fix' })).toBeNull();
  });

  it('saves a CLI and clears the model that belonged to the old one', async () => {
    const { user, bridge } = render({ ciAutoFixCliId: 'claude-code', ciAutoFixModel: 'opus' });
    await user.click(await screen.findByRole('combobox', { name: 'Agent CLI for auto-fix' }));
    await user.click(await screen.findByRole('option', { name: /Codex/ }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        ciAutoFixCliId: 'codex-cli',
        ciAutoFixModel: null,
        ciAutoFixEffort: null,
      }),
    );
  });

  it('offers the models of the picked CLI and saves one', async () => {
    const { user, bridge } = render({ ciAutoFixCliId: 'claude-code' });
    await user.click(await screen.findByRole('combobox', { name: 'Model for auto-fix' }));
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    await user.click(options[1]);
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith(
        expect.objectContaining({ ciAutoFixModel: expect.any(String) }),
      ),
    );
  });

  it('saves how many tries a run gets', async () => {
    const { user, bridge } = render();
    await user.click(await screen.findByRole('combobox', { name: 'Tries per run' }));
    await user.click(await screen.findByRole('option', { name: '5 tries' }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ ciAutoFixMaxAttempts: 5 }),
    );
  });
});
