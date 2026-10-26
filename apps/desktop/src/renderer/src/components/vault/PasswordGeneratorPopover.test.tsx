// @vitest-environment jsdom
import { DEFAULT_PASSWORD_OPTIONS } from '@runova/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { PasswordGeneratorPopover } from './PasswordGeneratorPopover';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import {
  expectNoNativeTitles,
  installDomShims,
  renderWithVaultProviders,
} from './testing/mockVaultApi';

installDomShims();

function preview(): string {
  return screen.getByTestId('generated-password').textContent ?? '';
}

function open(onUse = vi.fn()) {
  renderWithVaultProviders(<PasswordGeneratorPopover onUse={onUse} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate a password' }));
  return onUse;
}

beforeEach(() => {
  useVaultStore.setState({ generator: { ...DEFAULT_PASSWORD_OPTIONS } });
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('PasswordGeneratorPopover', () => {
  it('shows a fresh password using the saved options', () => {
    open();
    expect(preview()).toHaveLength(DEFAULT_PASSWORD_OPTIONS.length);
    expect(screen.getByRole('meter', { name: 'Password strength' })).toBeTruthy();
  });

  it('regenerates when asked and when options change', () => {
    open();
    const first = preview();
    fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    expect(preview()).not.toBe(first);

    fireEvent.change(screen.getByRole('slider', { name: 'Length' }), { target: { value: '32' } });
    expect(preview()).toHaveLength(32);

    fireEvent.click(screen.getByRole('switch', { name: 'Digits' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Symbols' }));
    expect(preview()).toMatch(/^[A-Za-z]{32}$/);
    expect(useVaultStore.getState().generator).toMatchObject({
      length: 32,
      digits: false,
      symbols: false,
    });
  });

  it('keeps at least one character set switched on', () => {
    open();
    for (const name of ['Uppercase letters', 'Digits', 'Symbols']) {
      fireEvent.click(screen.getByRole('switch', { name }));
    }
    const last = screen.getByRole('switch', { name: 'Lowercase letters' });
    expect(last.hasAttribute('disabled')).toBe(true);
    expect(preview()).toMatch(/^[a-z]+$/);
  });

  it('leaves out look-alike characters when that box is ticked', () => {
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Avoid look-alike characters' }));
    for (let i = 0; i < 30; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
      expect(preview()).not.toMatch(/[Il1O0o|]/);
    }
  });

  it('hands the password to the form and closes', () => {
    const onUse = open();
    const value = preview();
    fireEvent.click(screen.getByRole('button', { name: 'Use password' }));
    expect(onUse).toHaveBeenCalledWith(value);
    expect(screen.queryByTestId('generated-password')).toBeNull();
  });
});

describe('PasswordStrengthMeter', () => {
  it('reports the score and label, and stays out of the way for an empty password', () => {
    const { rerender } = renderWithVaultProviders(<PasswordStrengthMeter password="" />);
    expect(screen.queryByRole('meter')).toBeNull();
    rerender(<PasswordStrengthMeter password="password1" />);
    const meter = screen.getByRole('meter', { name: 'Password strength' });
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    expect(meter.getAttribute('aria-valuetext')).toBe('Very weak');
    expect(screen.getByText(/most common/i)).toBeTruthy();
  });

  it('keeps quiet about patterns once a password is strong', () => {
    renderWithVaultProviders(<PasswordStrengthMeter password="kX9#mP2$qL7!vB4&zT8*1234" />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('4');
    expect(screen.queryByText(/easy to guess/)).toBeNull();
  });
});
