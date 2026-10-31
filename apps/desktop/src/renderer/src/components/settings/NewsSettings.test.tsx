import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { NewsSettings } from './NewsSettings';

/**
 * The News card in Settings > Notifications (E42): news on or off, the categories to show and the
 * lowest severity of a security fix that notifies. Every change saves straight away.
 */

function render(saved: Record<string, unknown> = {}) {
  // Keeps what was saved, so the refetch after a save reads it back like the real store.
  let stored: Record<string, unknown> = {
    newsEnabled: true,
    newsCategories: [],
    newsNotifyMinSeverity: 'high',
    ...saved,
  };
  return renderWithProviders(<NewsSettings />, {
    bridge: {
      'settings.get': async () => stored,
      'settings.update': async (patch: Record<string, unknown>) => {
        stored = { ...stored, ...patch };
        return stored;
      },
    },
  });
}

describe('NewsSettings', () => {
  it('starts with news on, every category shown and High notifying', async () => {
    render();
    expect(await screen.findByRole('switch', { name: 'Show news' })).toBeChecked();
    for (const name of ['Security', 'Release', 'Deprecation', 'End of life', 'AI', 'Tooling']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
    }
    expect(
      screen.getByRole('combobox', { name: 'Notify me about security fixes at' }),
    ).toHaveTextContent('High');
  });

  it('says that checking for news sends nothing about this machine', async () => {
    render();
    expect(await screen.findByText(/sends no personal data/)).toBeInTheDocument();
  });

  it('turns news off and greys out the rest', async () => {
    const { user, bridge } = render();
    await user.click(await screen.findByRole('switch', { name: 'Show news' }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ newsEnabled: false }),
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Security' })).toBeDisabled());
    expect(
      screen.getByRole('combobox', { name: 'Notify me about security fixes at' }),
    ).toBeDisabled();
  });

  it('shows the saved choices when news is off', async () => {
    render({ newsEnabled: false, newsCategories: ['security'], newsNotifyMinSeverity: 'never' });
    expect(await screen.findByRole('switch', { name: 'Show news' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Security' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Release' })).not.toBeChecked();
    expect(
      screen.getByRole('combobox', { name: 'Notify me about security fixes at' }),
    ).toHaveTextContent('Never');
  });

  it('hides a category by saving every other one', async () => {
    const { user, bridge } = render();
    await user.click(await screen.findByRole('checkbox', { name: 'Industry' }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        newsCategories: ['security', 'release', 'deprecation', 'end-of-life', 'ai', 'tooling'],
      }),
    );
  });

  it('saves an empty list (all) once every category is back', async () => {
    const { user, bridge } = render({
      newsCategories: ['security', 'release', 'deprecation', 'end-of-life', 'ai', 'tooling'],
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Industry' }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ newsCategories: [] }),
    );
  });

  it('keeps the last shown category, since none at all would mean every one', async () => {
    render({ newsCategories: ['security'] });
    expect(await screen.findByRole('checkbox', { name: 'Security' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Release' })).toBeEnabled();
  });

  it('saves the lowest severity that notifies, or Never', async () => {
    const { user, bridge } = render();
    await user.click(
      await screen.findByRole('combobox', { name: 'Notify me about security fixes at' }),
    );
    await user.click(await screen.findByRole('option', { name: /Never/ }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        newsNotifyMinSeverity: 'never',
      }),
    );
  });
});
