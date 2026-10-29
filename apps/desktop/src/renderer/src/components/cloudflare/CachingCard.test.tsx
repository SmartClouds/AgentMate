import type { CloudflareZoneSettings } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, SETTINGS, ZONE } from './testing/fixtures';

/**
 * The Caching tab's settings: development mode with the time it has left, the caching level, and
 * how long browsers keep files. Each says its state in words.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { CachingCard } = await import('./CachingCard');

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(<CachingCard zone={ZONE} />, { bridge });
}

function withSettings(change: Partial<CloudflareZoneSettings>): CloudflareZoneSettings {
  return { ...SETTINGS, ...change };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('CachingCard', () => {
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

  it('turns development mode on, and shows the time it has left', async () => {
    const changed = withSettings({
      developmentMode: { value: 'on', secondsRemaining: 10800, editable: true },
    });
    const { user, bridge, queryClient } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => changed,
    });

    const toggle = await screen.findByRole('switch', { name: 'Development mode' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'developmentMode',
      value: 'on',
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.cloudflareSettings(ZONE.id))).toEqual(changed),
    );
    expect(await screen.findByText('On, 3 h left')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Development mode is on for three hours.');
  });

  it('shows the caching level as three choices, and changes it', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () =>
        withSettings({ cacheLevel: { value: 'basic', editable: true } }),
    });

    const group = await screen.findByRole('radiogroup', { name: 'Caching level' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Standard', 'Ignore query string', 'No query string']);
    expect(within(group).getByRole('radio', { name: 'Standard' })).toBeChecked();
    expect(screen.getByText(/separate copy for every query string/)).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: 'No query string' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'cacheLevel',
      value: 'basic',
    });
    expect(
      await screen.findByText(/only when the address has no query string/),
    ).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Caching level is No query string now.');
  });

  it('changes how long browsers keep files', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () =>
        withSettings({ browserCacheTtl: { value: 86400, editable: true } }),
    });

    expect(await screen.findByLabelText('Browser cache TTL')).toHaveTextContent('4 hours');
    await user.click(screen.getByRole('combobox', { name: 'Browser cache TTL' }));
    await user.click(await screen.findByRole('option', { name: '1 day' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'browserCacheTtl',
      value: 86400,
    });
    expect(await screen.findByLabelText('Browser cache TTL')).toHaveTextContent('1 day');
  });

  it('shows a TTL that is not on the list in words too', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () =>
        withSettings({ browserCacheTtl: { value: 90, editable: true } }),
    });
    expect(await screen.findByLabelText('Browser cache TTL')).toHaveTextContent('90 seconds');
  });

  it('locks settings Cloudflare says cannot be changed', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () =>
        withSettings({
          developmentMode: { value: 'off', secondsRemaining: 0, editable: false },
          cacheLevel: { value: 'aggressive', editable: false },
          browserCacheTtl: { value: 14400, editable: false },
        }),
    });

    expect(await screen.findByRole('switch', { name: 'Development mode' })).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByLabelText('Browser cache TTL')).toBeDisabled();
  });
});
