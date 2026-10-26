import { DEFAULT_REVIEW_COMMANDS } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ReviewCommandsSettings } from './ReviewCommandsSettings';

function renderSettings(reviewCommands: string[]) {
  return renderWithProviders(<ReviewCommandsSettings />, {
    bridge: { 'settings.get': { reviewCommands }, 'settings.update': {} },
  });
}

describe('ReviewCommandsSettings', () => {
  it('adds a command on Enter, trimmed', async () => {
    const { user, bridge } = renderSettings(['@claude review']);
    await user.type(
      await screen.findByRole('textbox', { name: 'New review command' }),
      '  @bot please review {Enter}',
    );
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        reviewCommands: ['@claude review', '@bot please review'],
      }),
    );
  });

  it('ignores a duplicate', async () => {
    const { user } = renderSettings(['@claude review']);
    await user.type(
      await screen.findByRole('textbox', { name: 'New review command' }),
      '@claude review{Enter}',
    );
    expect(screen.getByText('Already in the list.')).toBeInTheDocument();
  });

  it('removes a command', async () => {
    const { user, bridge } = renderSettings(['@claude review', '/gemini review']);
    await user.click(await screen.findByRole('button', { name: 'Remove /gemini review' }));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
      reviewCommands: ['@claude review'],
    });
  });

  it('puts the defaults back', async () => {
    const { user, bridge } = renderSettings([]);
    await user.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
      reviewCommands: [...DEFAULT_REVIEW_COMMANDS],
    });
  });
});
