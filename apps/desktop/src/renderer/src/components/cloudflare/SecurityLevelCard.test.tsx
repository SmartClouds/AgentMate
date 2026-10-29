import type { CloudflareZoneSettings } from '@shared/cloudflareTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, SETTINGS, ZONE } from './testing/fixtures';

/**
 * The security level at the top of the Security tab, up to "I'm Under Attack", with a reminder to
 * turn it back down while it is on.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { SecurityLevelCard } = await import('./SecurityLevelCard');

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(<SecurityLevelCard zone={ZONE} />, { bridge });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('SecurityLevelCard', () => {
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

  it("turns on I'm Under Attack and keeps the answer", async () => {
    const changed: CloudflareZoneSettings = {
      ...SETTINGS,
      securityLevel: { value: 'under_attack', editable: true },
    };
    const { user, bridge, queryClient } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => changed,
    });

    expect(await screen.findByLabelText('Security level')).toHaveTextContent('Medium');
    await user.click(screen.getByRole('combobox', { name: 'Security level' }));
    await user.click(await screen.findByRole('option', { name: "I'm Under Attack" }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.cloudflareSettings(ZONE.id))).toEqual(changed),
    );
    expect(toast.success).toHaveBeenCalledWith("Security level is I'm Under Attack now.");
    expect(await screen.findByText(/every visitor sees a short check/)).toBeInTheDocument();
  });

  it('passes on a refused change', async () => {
    const { user } = renderCard({
      'cloudflare.zoneSettings': async () => SETTINGS,
      'cloudflare.changeSetting': async () => {
        throw ipcError('changeSetting', 'Cloudflare said: Invalid value (code 1007)');
      },
    });

    await user.click(await screen.findByRole('combobox', { name: 'Security level' }));
    await user.click(await screen.findByRole('option', { name: 'High' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare said: Invalid value (code 1007)'),
    );
  });

  it('locks the level when Cloudflare says it cannot be changed', async () => {
    renderCard({
      'cloudflare.zoneSettings': async () => ({
        ...SETTINGS,
        securityLevel: { value: 'high', editable: false },
      }),
    });
    expect(await screen.findByLabelText('Security level')).toBeDisabled();
  });
});
