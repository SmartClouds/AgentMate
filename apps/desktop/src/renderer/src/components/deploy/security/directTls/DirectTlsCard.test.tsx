import { encodeCoreError } from '@shared/coreErrors';
import type { DirectTlsStatus } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployDirectTlsInfo } from '@shared/deployDirectTlsTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { changeSet, status as firewallStatus, preview } from '../../firewall/testing/fixtures';
import { SERVER, signedIn } from '../testing/fixtures';

/**
 * Direct TLS through its states: shimmer, a read that failed, off for a Viewer (read only), on
 * for an Owner after a step-up followed by the firewall review, a key that changed (refused until
 * trusted), and turning it off with the rule taken away again.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { DirectTlsCard } = await import('./DirectTlsCard');

const PIN = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';

function tls(fields: Partial<DirectTlsStatus> = {}): DirectTlsStatus {
  return {
    enabled: false,
    port: 7443,
    sources: [],
    listening: false,
    pin: PIN,
    certificateNotAfterUnixMs: Date.UTC(2046, 0, 1),
    defaultPort: 7443,
    ...fields,
  };
}

function info(
  fields: Partial<DirectTlsStatus> = {},
  extra: Partial<DeployDirectTlsInfo> = {},
): DeployDirectTlsInfo {
  const status = tls(fields);
  return {
    status,
    pinned: { enabled: status.enabled, port: status.port, pin: PIN, pinnedAt: Date.now() - 60_000 },
    pinChanged: false,
    host: 'prod.example',
    ...extra,
  };
}

function renderCard(overrides: Record<string, unknown> = {}, owner = true) {
  return renderWithProviders(<DirectTlsCard server={SERVER} owner={owner} />, {
    bridge: {
      'deploy.access': async () => signedIn(owner ? ['owner'] : ['viewer']),
      'deploy.connection': async () => ({
        serverId: SERVER.id,
        state: 'online',
        since: 0,
        transport: 'streamlocal',
      }),
      'deployDirectTls.status': async () => info(),
      'deployFirewall.status': async () => firewallStatus(),
      'deployFirewall.history': async () => [],
      'deployFirewall.presets': async () => [],
      'deployFirewall.exposure': async () => ({ sockets: [], containers: [], checkedAtUnixMs: 0 }),
      'deployFirewall.preview': async () => preview(),
      'deployFirewall.applyChanges': async () => changeSet(),
      ...overrides,
    },
  });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
});

describe('DirectTlsCard', () => {
  it('shimmers while it reads the core', () => {
    const { container } = renderCard({
      'deployDirectTls.status': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says why it could not read the core, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deployDirectTls.status': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The SSH connection was refused.');
        return info();
      },
    });

    expect(await screen.findByText('The SSH connection was refused.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Off')).toBeTruthy();
  });

  it('shows a Viewer how it stands, with the pin, and nothing to change', async () => {
    renderCard({}, false);

    const details = await screen.findByLabelText('Direct TLS details');
    expect(within(details).getByText('Off')).toBeTruthy();
    expect(within(details).getByText(`sha256/${PIN}`)).toBeTruthy();
    expect(within(details).getByText(/read over SSH/)).toBeTruthy();
    expect(within(details).getByText(/Uses SSH only/)).toBeTruthy();
    expect(screen.getByText('Only an Owner can change direct TLS.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on direct TLS' })).toBeNull();
  });

  it('checks the form as the Owner types', async () => {
    const { user, bridge } = renderCard();

    const port = await screen.findByLabelText('Port');
    await user.clear(port);
    await user.type(port, '443');
    await user.type(screen.getByLabelText('Allowed from'), '0.0.0.0/0');
    await user.click(screen.getByRole('button', { name: 'Turn on direct TLS' }));

    expect(screen.getByText('Pick a port from 1024 to 65535.')).toBeTruthy();
    expect(screen.getByText('Leave the sources empty to allow every address.')).toBeTruthy();
    expect(() => bridge.$fn('deployDirectTls.enable')).toThrow(/not been touched/);
  });

  it('turns it on after a step-up, then offers the firewall rule for review', async () => {
    let calls = 0;
    const { user, bridge } = renderCard({
      'deployDirectTls.enable': async () => {
        calls += 1;
        if (calls === 1)
          throw new Error(encodeCoreError('stepUpRequired', 'Needs your password again.'));
        return info({ enabled: true, listening: true, port: 9443, sources: ['10.0.0.0/8'] });
      },
    });

    const port = await screen.findByLabelText('Port');
    await user.clear(port);
    await user.type(port, '9443');
    await user.type(screen.getByLabelText('Allowed from'), '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: 'Turn on direct TLS' }));
    await user.type(await screen.findByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(bridge.$fn('deployDirectTls.enable')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      port: 9443,
      sources: ['10.0.0.0/8'],
      password: 'secret',
    });
    expect(await screen.findByText('On, listening on port 9443')).toBeTruthy();
    const review = await screen.findByRole('dialog', { name: 'Review the firewall change' });
    await user.click(within(review).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bridge.$fn('deployFirewall.applyChanges')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        changes: [
          {
            kind: 'addRule',
            rule: {
              action: 'allow',
              protocol: 'tcp',
              port: 9443,
              source: '10.0.0.0/8',
              comment: 'Runova direct TLS',
            },
          },
        ],
      }),
    );
  });

  it('turns it off after a confirmation and takes the rule away again', async () => {
    const rule = {
      id: 'tls',
      action: 'allow' as const,
      protocol: 'tcp' as const,
      families: 'both' as const,
      description: 'Allow 7443/tcp',
      editable: true,
      outgoing: false,
      port: 7443,
      comment: 'Runova direct TLS',
    };
    const { user, bridge } = renderCard({
      'deployDirectTls.status': async () => info({ enabled: true, listening: true }),
      'deployDirectTls.disable': async () => info({ enabled: false }),
      'deployFirewall.status': async () => firewallStatus({ rules: [rule] }),
    });

    await user.click(await screen.findByRole('button', { name: /Turn off/ }));

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(bridge.$fn('deployDirectTls.disable')).toHaveBeenCalledWith(SERVER.id);
    const review = await screen.findByRole('dialog', { name: 'Review the firewall change' });
    await user.click(within(review).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bridge.$fn('deployFirewall.applyChanges')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        changes: [{ kind: 'removeRule', ruleId: 'tls' }],
      }),
    );
  });

  it('warns about a key that changed and trusts the new one only when asked', async () => {
    const { user, bridge } = renderCard({
      'deployDirectTls.status': async () =>
        info({ enabled: true, listening: true }, { pinChanged: true }),
      'deployDirectTls.acceptPin': async () => info({ enabled: true, listening: true }),
    });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The server key changed')).toBeTruthy();
    expect(within(alert).getByText(/nothing falls back to it quietly/)).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Trust the new key' }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Trust the new server key?' }),
    );
    expect(bridge.$fn('deployDirectTls.acceptPin')).toHaveBeenCalledWith(SERVER.id);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows the details of a mode that is on, and copies the pin', async () => {
    const { user } = renderCard({
      'deploy.connection': async () => ({
        serverId: SERVER.id,
        state: 'online',
        since: 0,
        transport: 'direct-tls',
      }),
      'deployDirectTls.status': async () =>
        info({
          enabled: true,
          listening: false,
          sources: ['10.0.0.0/8'],
          error: 'The core could not open port 7443.',
          changedBy: 'maria',
          changedAtUnixMs: Date.now() - 120_000,
        }),
    });

    const details = await screen.findByLabelText('Direct TLS details');
    expect(within(details).getByText('On, but the port is not open')).toBeTruthy();
    expect(within(details).getByText('The core could not open port 7443.')).toBeTruthy();
    expect(within(details).getByText('prod.example:7443')).toBeTruthy();
    expect(within(details).getByText('10.0.0.0/8')).toBeTruthy();
    expect(within(details).getByText(/Tries direct TLS first/)).toBeTruthy();
    expect(within(details).getByText(/Connected over direct TLS/)).toBeTruthy();
    expect(within(details).getByText(/by maria/)).toBeTruthy();
    await user.click(within(details).getByRole('button', { name: 'Copy the pin' }));
    expect(await navigator.clipboard.readText()).toBe(PIN);
    expect(toast.success).toHaveBeenCalledWith('Pin copied.');
  });

  it('keeps or reverts a firewall change that is waiting, from the same card', async () => {
    const pending = changeSet({ deadlineUnixMs: Date.now() + 50_000 });
    const { user, bridge } = renderCard({
      'deployDirectTls.status': async () => info({ enabled: true, listening: true }),
      'deployFirewall.status': async () => firewallStatus({ pending }),
      'deployFirewall.confirm': async () => changeSet({ state: 'confirmed' }),
      'deployFirewall.revert': async () => changeSet({ state: 'rolledBack' }),
    });

    await user.click(await screen.findByRole('button', { name: 'Keep changes' }));
    await waitFor(() =>
      expect(bridge.$fn('deployFirewall.confirm')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        changeSetId: pending.id,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Firewall change kept.');

    await user.click(await screen.findByRole('button', { name: /Revert/ }));
    await waitFor(() => expect(bridge.$fn('deployFirewall.revert')).toHaveBeenCalled());
  });

  it('says why a change could not be made', async () => {
    const { user } = renderCard({
      'deployDirectTls.enable': async () => {
        throw new Error('Port 7443 is already in use on the server. Pick another one.');
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Turn on direct TLS' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Port 7443 is already in use on the server. Pick another one.',
      ),
    );
  });

  it('changes the port of a mode that is on, moving the firewall rule with it', async () => {
    const rule = {
      id: 'old',
      action: 'allow' as const,
      protocol: 'tcp' as const,
      families: 'both' as const,
      description: 'Allow 7443/tcp',
      editable: true,
      outgoing: false,
      port: 7443,
      comment: 'Runova direct TLS',
    };
    const { user, bridge } = renderCard({
      'deployDirectTls.status': async () => info({ enabled: true, listening: true }),
      'deployDirectTls.enable': async () => info({ enabled: true, listening: true, port: 8443 }),
      'deployFirewall.status': async () => firewallStatus({ rules: [rule] }),
    });

    await user.click(await screen.findByRole('button', { name: /Change port or sources/ }));
    const port = screen.getByLabelText('Port');
    await user.clear(port);
    await user.type(port, '8443');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const review = await screen.findByRole('dialog', { name: 'Review the firewall change' });
    await user.click(within(review).getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bridge.$fn('deployFirewall.applyChanges')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        changes: [
          { kind: 'removeRule', ruleId: 'old' },
          {
            kind: 'addRule',
            rule: {
              action: 'allow',
              protocol: 'tcp',
              port: 8443,
              comment: 'Runova direct TLS',
            },
          },
        ],
      }),
    );
  });
});
