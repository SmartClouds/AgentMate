import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { offerFirewallRules } from '@/lib/deploy/firewall/restoredRules';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, signedIn } from '../security/testing/fixtures';
import { changeSet, EXPOSURE, PRESETS, preview, status } from './testing/fixtures';

/**
 * A restore from Backups (E28) offers the backup's firewall rules: the Firewall section stages the
 * ones it lacks and opens the usual review, so they go through the safe apply like any change.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: vi.fn(async () => true) }));

const { FirewallPanel } = await import('./FirewallPanel');

function renderPanel(roles = ['admin']) {
  return renderWithProviders(<FirewallPanel server={SERVER} />, {
    route: '/deploy?server=srv-1&view=firewall&fix=restore-rules',
    bridge: {
      'deploy.access': async () => signedIn(roles),
      'deploy.connection': async () => ({ serverId: SERVER.id, state: 'online', since: 0 }),
      'deployFirewall.status': async () => status(),
      'deployFirewall.presets': async () => PRESETS,
      'deployFirewall.history': async () => [],
      'deployFirewall.exposure': async () => EXPOSURE,
      'deployFirewall.preview': async () => preview(),
      'deployFirewall.applyChanges': async () => changeSet(),
    },
  });
}

describe('FirewallPanel after a restore', () => {
  it('stages the restored rules it lacks and opens the review', async () => {
    const existing = status().rules[0];
    offerFirewallRules('srv-1', [
      { action: 'allow', protocol: 'tcp', port: 8443 },
      ...(existing
        ? [{ action: existing.action, protocol: existing.protocol, port: existing.port }]
        : []),
    ]);
    const { bridge } = renderPanel();

    expect(await screen.findByRole('dialog', { name: 'Review the firewall change' })).toBeTruthy();
    await waitFor(() =>
      expect(bridge.$fn('deployFirewall.preview')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        changes: [{ kind: 'addRule', rule: { action: 'allow', protocol: 'tcp', port: 8443 } }],
      }),
    );
  });
});
