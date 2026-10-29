import type { CloudflareZoneSettings } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, SETTINGS, ZONE } from './testing/fixtures';

/**
 * The SSL/TLS tab: the encryption mode as four cards that show which legs of the trip are
 * encrypted, the suggestion for proxied domains, and the HTTPS and TLS version settings.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { SslTlsCard } = await import('./SslTlsCard');

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(<SslTlsCard zone={ZONE} />, { bridge });
}

function withSettings(change: Partial<CloudflareZoneSettings>): CloudflareZoneSettings {
  return { ...SETTINGS, ...change };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('SslTlsCard', () => {
  it('shimmers while the settings load', () => {
    const { container } = renderCard({
      'cloudflare.zoneSettings': () => new Promise(() => undefined),
    });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says what went wrong, and tries again', async () => {
    let calls = 0;
    const { user } = renderCard({
      'cloudflare.zoneSettings': async () => {
        calls += 1;
        throw ipcError('zoneSettings', 'Could not reach Cloudflare.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Cloudflare.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it('shows the mode as four choices, with the suggestion for it', async () => {
    renderCard({ 'cloudflare.zoneSettings': async () => SETTINGS });

    const group = await screen.findByRole('radiogroup', { name: 'Encryption mode' });
    const modes = within(group).getAllByRole('radio');
    expect(modes.map((mode) => mode.getAttribute('aria-label'))).toEqual([
      'Off (no HTTPS)',
      'Flexible',
      'Full',
      'Full (strict)',
    ]);
    expect(within(group).getByRole('radio', { name: 'Full' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Flexible' })).not.toBeChecked();
    expect(screen.getByText(/certificate is not checked/)).toBeInTheDocument();
  });

  it('changes the mode from a card, and keeps the answer', async () => {
    const changed = withSettings({ ssl: { value: 'strict', editable: true } });
    const { user, bridge, queryClient } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => changed,
    });

    await user.click(await screen.findByRole('radio', { name: 'Full (strict)' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'ssl',
      value: 'strict',
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.cloudflareSettings(ZONE.id))).toEqual(changed),
    );
    expect(toast.success).toHaveBeenCalledWith('SSL/TLS mode is Full (strict) now.');
    expect(await screen.findByText(/This is the safest mode/)).toBeInTheDocument();
  });

  it('moves between the cards with the arrow keys, and picks with Enter', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => SETTINGS,
    });
    const full = await screen.findByRole('radio', { name: 'Full' });

    full.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Full (strict)' })).toHaveFocus();
    // Moving alone never changes a live setting.
    expect(() => bridge.$fn('cloudflare.changeSetting')).toThrow();
    await user.keyboard('{ArrowLeft}{ArrowLeft}{Enter}');

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'ssl',
      value: 'flexible',
    });
  });

  it('moves to Full (strict) from the suggestion', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () =>
        withSettings({ ssl: { value: 'strict', editable: true } }),
    });

    await user.click(await screen.findByRole('button', { name: 'Use Full (strict)' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'ssl',
      value: 'strict',
    });
  });

  it('passes on a refused change', async () => {
    const { user } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => {
        throw ipcError('changeSetting', 'Cloudflare said: Invalid value (code 1007)');
      },
    });

    await user.click(await screen.findByRole('radio', { name: 'Flexible' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare said: Invalid value (code 1007)'),
    );
  });

  it('shows a mode only Cloudflare can set, and locks a mode that cannot change', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () =>
        withSettings({ ssl: { value: 'origin_pull', editable: false } }),
    });

    expect(await screen.findByText(/Strict \(SSL-only origin pull\)/)).toBeInTheDocument();
    for (const mode of screen.getAllByRole('radio')) {
      expect(mode).toBeDisabled();
      expect(mode).not.toBeChecked();
    }
  });

  it('turns on Always Use HTTPS and Automatic HTTPS Rewrites', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => SETTINGS,
    });

    await user.click(await screen.findByRole('switch', { name: 'Always Use HTTPS' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'alwaysUseHttps',
      value: 'on',
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Automatic HTTPS Rewrites' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('switch', { name: 'Automatic HTTPS Rewrites' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'automaticHttpsRewrites',
      value: 'on',
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith('Automatic HTTPS Rewrites is on.'),
    );
  });

  it('suggests TLS 1.2 as the oldest version, and changes it', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () =>
        withSettings({ minTlsVersion: { value: '1.2', editable: true } }),
    });

    expect(await screen.findByLabelText('Minimum TLS version')).toHaveTextContent('TLS 1.0');
    expect(screen.getByText(/old browsers and bots/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use TLS 1.2' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'minTlsVersion',
      value: '1.2',
    });
    await waitFor(() => expect(screen.queryByText(/old browsers and bots/)).toBeNull());

    await user.click(screen.getByRole('combobox', { name: 'Minimum TLS version' }));
    await user.click(await screen.findByRole('option', { name: 'TLS 1.3' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'minTlsVersion',
      value: '1.3',
    });
  });

  it('turns TLS 1.3 off, and shows 0-RTT as on', async () => {
    const { user, bridge, unmount } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => SETTINGS,
    });

    await user.click(await screen.findByRole('switch', { name: 'TLS 1.3' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'tls13',
      value: 'off',
    });
    unmount();

    renderCard({
      'cloudflare.zoneSettings': async () =>
        withSettings({ tls13: { value: 'zrt', editable: true } }),
    });
    expect(await screen.findByRole('switch', { name: 'TLS 1.3' })).toBeChecked();
    expect(screen.getByText('0-RTT')).toBeInTheDocument();
  });
});
