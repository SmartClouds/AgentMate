import type { CloudflareZoneSettings } from '@shared/cloudflareTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, SETTINGS, ZONE } from './testing/fixtures';

/**
 * Zone settings (T3): development mode, the security level up to "I'm Under Attack", the SSL/TLS
 * mode with a suggestion for proxied domains, and Always Use HTTPS. Each says its state in words.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ZoneSettingsCard } = await import('./ZoneSettingsCard');

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(<ZoneSettingsCard zone={ZONE} />, { bridge });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('ZoneSettingsCard', () => {
  it('shimmers while the settings load', () => {
    const { container } = renderCard({
      'cloudflare.zoneSettings': () => new Promise(() => undefined),
    });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says what went wrong', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () => {
        throw ipcError('zoneSettings', 'This token is not allowed to change zone settings.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'not allowed to change zone settings',
    );
  });

  it('shows each setting in words, with the SSL/TLS suggestion', async () => {
    renderCard({ 'cloudflare.zoneSettings': async () => SETTINGS });

    expect(await screen.findByLabelText('Security level')).toHaveTextContent('Medium');
    expect(screen.getByLabelText('SSL/TLS mode')).toHaveTextContent(/^Full$/);
    expect(screen.getByRole('switch', { name: 'Development mode' })).not.toBeChecked();
    expect(screen.getByText(/certificate is not checked/)).toBeInTheDocument();
    expect(screen.getAllByText('Off')).not.toHaveLength(0);
  });

  it("turns on I'm Under Attack, development mode and Always Use HTTPS", async () => {
    const changed: CloudflareZoneSettings = {
      ...SETTINGS,
      developmentMode: { value: 'on', secondsRemaining: 10800, editable: true },
    };
    const { user, bridge, queryClient } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => changed,
    });

    await user.click(await screen.findByRole('combobox', { name: 'Security level' }));
    await user.click(await screen.findByRole('option', { name: "I'm Under Attack" }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.cloudflareSettings(ZONE.id))).toEqual(changed),
    );
    expect(await screen.findByText('On, 3 h left')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Always Use HTTPS' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'alwaysUseHttps',
      value: 'on',
    });
    await user.click(screen.getByRole('switch', { name: 'Development mode' }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'developmentMode',
      value: 'off',
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('moves to Full (strict) from the suggestion', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => ({
        ...SETTINGS,
        ssl: { value: 'strict', editable: true },
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Use Full (strict)' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'ssl',
      value: 'strict',
    });
    expect(await screen.findByText(/This is the safest mode/)).toBeInTheDocument();
  });

  it('warns while under attack, and passes on a refused change', async () => {
    const { user } = renderCard({
      'cloudflare.zoneSettings': async () => ({
        ...SETTINGS,
        securityLevel: { value: 'under_attack', editable: true },
      }),
      'cloudflare.changeSetting': async () => {
        throw ipcError('changeSetting', 'Cloudflare said: Invalid value (code 1007)');
      },
    });

    expect(await screen.findByText(/every visitor sees a short check/)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'SSL/TLS mode' }));
    await user.click(await screen.findByRole('option', { name: 'Flexible' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare said: Invalid value (code 1007)'),
    );
  });

  it('locks settings Cloudflare says cannot be changed', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () => ({
        ...SETTINGS,
        ssl: { value: 'origin_pull', editable: false },
      }),
    });
    expect(await screen.findByLabelText('SSL/TLS mode')).toBeDisabled();
    expect(screen.getByLabelText('SSL/TLS mode')).toHaveTextContent(
      'Strict (SSL-only origin pull)',
    );
  });
});
