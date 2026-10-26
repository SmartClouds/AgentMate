// @vitest-environment jsdom
import type { AppSettings } from '@runova/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  renderWithVaultProviders,
  type VaultApiMock,
} from './testing/mockVaultApi';
import { VaultSettings } from './VaultSettings';

installDomShims();

const settings = {
  vaultAutoLockMinutes: 15,
  vaultClipboardClearSeconds: 30,
  vaultLockOnSystemLock: true,
} as AppSettings;

let mock: VaultApiMock;
const update = vi.fn(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch }));

function renderSettings() {
  installVaultApi(mock);
  Object.assign(window.runova, { settings: { update } });
  return renderWithVaultProviders(<VaultSettings settings={settings} />);
}

beforeEach(() => {
  mock = createVaultApiMock({ state: 'unlocked' });
  update.mockClear();
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultSettings', () => {
  it('saves the auto-lock and clipboard timers as soon as one is picked', async () => {
    renderSettings();
    const autoLock = screen.getByRole('radiogroup', { name: 'Lock after' });
    expect(screen.getByRole('radio', { name: '15 min' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '5 min' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ vaultAutoLockMinutes: 5 }));
    expect(autoLock).toBeTruthy();

    const clear = screen.getByRole('radiogroup', { name: 'Clear copied values after' });
    fireEvent.click(clear.querySelector('[data-value="0"]') as HTMLElement);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ vaultClipboardClearSeconds: 0 }));
  });

  it('turns locking with the computer on and off', async () => {
    renderSettings();
    fireEvent.click(
      screen.getByRole('switch', { name: 'Lock when this computer locks or sleeps' }),
    );
    await waitFor(() => expect(update).toHaveBeenCalledWith({ vaultLockOnSystemLock: false }));
  });

  it('changes the master password only while unlocked, and can reset', async () => {
    mock.status.state = 'locked';
    renderSettings();
    const change = await screen.findByRole('button', { name: 'Change master password' });
    await waitFor(() => expect(change.hasAttribute('disabled')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Reset vault' }));
    expect(await screen.findByRole('dialog', { name: 'Reset the vault?' })).toBeTruthy();
  });

  it('opens the change password dialog when unlocked', async () => {
    renderSettings();
    const changeButton = () => screen.getByRole('button', { name: 'Change master password' });
    await waitFor(() => expect(changeButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(changeButton());
    expect(await screen.findByRole('dialog', { name: 'Change master password' })).toBeTruthy();
  });
});
