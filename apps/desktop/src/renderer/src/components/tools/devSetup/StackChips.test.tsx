import { DEV_STACKS } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { StackChips } from './StackChips';

/**
 * "What do you build?" The one choice the whole checklist hangs on, so it has to be obvious which
 * stacks are on, that Essentials cannot be turned off, and what each stack brings.
 */

function renderChips(selected: string[] = ['essentials'], onToggle = vi.fn()) {
  return {
    onToggle,
    ...renderWithProviders(
      <StackChips stacks={DEV_STACKS} selected={selected} onToggle={onToggle} />,
    ),
  };
}

describe('StackChips', () => {
  it('asks what the person builds', () => {
    renderChips();

    expect(screen.getByRole('heading', { name: 'What do you build?' })).toBeTruthy();
  });

  it('offers every stack, each as a toggle that says whether it is on', () => {
    renderChips(['essentials', 'flutter']);

    expect(screen.getByRole('button', { name: '.NET' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Flutter + Android' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Docker' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('turns a stack on or off when its chip is pressed', async () => {
    const { user, onToggle } = renderChips();

    await user.click(screen.getByRole('button', { name: 'Docker' }));

    expect(onToggle).toHaveBeenCalledWith('docker');
  });

  it('shows Essentials as always on, not as something to click', () => {
    renderChips();

    expect(screen.getByText('Essentials')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Essentials' })).toBeNull();
  });

  it('explains why Essentials is locked when asked', async () => {
    const { user } = renderChips();

    await user.hover(screen.getByText('Essentials'));

    expect(
      (await screen.findAllByText('Always on. Everything else builds on it.')).length,
    ).toBeGreaterThan(0);
  });

  it('says what a stack brings when its chip is hovered', async () => {
    const { user } = renderChips();

    await user.hover(screen.getByRole('button', { name: '.NET' }));

    expect(
      (await screen.findAllByText('The .NET SDK and the Entity Framework tool, for C# projects.'))
        .length,
    ).toBeGreaterThan(0);
  });

  it('groups the chips so a screen reader announces them together', () => {
    renderChips();

    expect(screen.getByRole('group', { name: 'Stacks' })).toBeTruthy();
  });
});
