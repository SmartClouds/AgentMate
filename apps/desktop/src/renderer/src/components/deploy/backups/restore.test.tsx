import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DISK, OTHER_SERVER, PENDING, SERVER, STEPPED_UP, STORED } from './testing/fixtures';

/**
 * The restore wizard (E28): pick the backup (on a destination, or a file here) and the server it
 * goes onto, give the secret key and an Owner of the backup, confirm by typing the server's name,
 * follow the steps; then see what the backup brings (volumes, images, containers, projects,
 * firewall rules, address changes) and bring the server up, moving the address on a new server,
 * with what has to be changed by hand at the end and the firewall rules offered for review.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.fn(async (_options: unknown) => true);
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (options: unknown) => confirm(options),
}));

const { RestoreTab } = await import('./RestoreTab');
const { takeFirewallRules } = await import('@/lib/deploy/firewall/restoredRules');

const STATUS = {
  state: 'succeeded',
  steps: [
    { name: 'Volumes', state: 'succeeded' },
    { name: 'Containers', state: 'succeeded' },
  ],
  applied: [PENDING.addressChanges[0]],
  manualDns: ['blog.example'],
};

function Harness({ initial }: { initial: Parameters<typeof RestoreTab>[0]['initial'] }) {
  return <RestoreTab server={SERVER} userName="maria" initial={initial} />;
}

function renderWizard(
  bridge: Record<string, unknown> = {},
  initial: Parameters<typeof RestoreTab>[0]['initial'] = null,
) {
  let restored = false;
  return renderWithProviders(<Harness initial={initial} />, {
    bridge: {
      ...STEPPED_UP,
      'deploy.listServers': async () => [SERVER, OTHER_SERVER],
      'deployServerBackups.listDestinations': [DISK],
      'deployServerBackups.listStored': async () => [STORED],
      'deployServerBackups.pendingRestore': async () => (restored ? PENDING : null),
      'deployServerBackups.restore': async () => {
        restored = true;
        return {
          backupCoreVersion: '1.62.0',
          backupHostName: 'web-1',
          backupCreatedAtUnixMs: STORED.createdAtUnixMs,
          previousStateFolder: '/var/lib/agentmate-core-restore/previous',
        };
      },
      'deployServerBackups.bringUp': async () => ({
        status: STATUS,
        moved: [
          {
            area: 'healthCheck',
            name: 'API',
            from: 'http://203.0.113.10/',
            to: 'http://198.51.100.7/',
          },
        ],
      }),
      ...bridge,
    },
  });
}

async function fillDetails(user: ReturnType<typeof renderWizard>['user']) {
  await user.type(screen.getByLabelText('Secret key'), 'orange tractor lamp');
  await user.type(screen.getByLabelText('Their password'), 'pw');
}

describe('RestoreTab', () => {
  it('restores a destination backup onto another server, then brings it up at the new address', async () => {
    const { user, bridge } = renderWizard(
      {},
      {
        serverId: SERVER.id,
        destinationId: DISK.id,
        backupId: STORED.backupId,
      },
    );

    expect(await screen.findByRole('radio', { name: /web-1/ })).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Restore onto' }));
    await user.click(await screen.findByRole('option', { name: 'Staging' }));
    await fillDetails(user);
    await user.click(screen.getByRole('button', { name: 'Restore onto Staging' }));

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ typeToConfirm: 'Staging' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.restore')).toHaveBeenCalledWith({
        serverId: 'srv-2',
        source: {
          kind: 'destination',
          serverId: 'srv-1',
          destinationId: DISK.id,
          backupId: STORED.backupId,
        },
        secret: 'orange tractor lamp',
        sudoPassword: null,
        userName: 'maria',
        password: 'pw',
      }),
    );

    const summary = await screen.findByRole('region', { name: 'What the backup brings' });
    expect(within(summary).getByText('4')).toBeTruthy();
    expect(within(summary).getByText('shop, blog')).toBeTruthy();
    const changes = within(summary).getByRole('table', { name: 'Address changes' });
    expect(within(changes).getByText('Automatic')).toBeTruthy();
    expect(within(changes).getByText('Change by hand')).toBeTruthy();
    const move = screen.getByRole('checkbox', { name: /Move what named the old address/ });
    expect(move.getAttribute('data-state')).toBe('checked');

    await user.click(screen.getByRole('button', { name: 'Bring the server up' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.bringUp')).toHaveBeenCalledWith({
        serverId: 'srv-2',
        moveAddresses: true,
        password: 'pw',
      }),
    );
    expect(
      await screen.findByText(/Point these at the new address yourself.*blog\.example/),
    ).toBeTruthy();
    expect(screen.getByText(/Health check API: from http:\/\/203\.0\.113\.10\//)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Review the firewall rules' }));
    expect(takeFirewallRules('srv-2')).toEqual(PENDING.firewallRules);
  });

  it('restores a file from this computer onto this server', async () => {
    const file = {
      token: '00000000-0000-4000-9000-000000000009',
      name: 'web.ambackup',
      sizeBytes: 10,
    };
    const { user, bridge } = renderWizard({ 'deployServerBackups.pickFile': async () => file });
    await user.click(await screen.findByRole('radio', { name: 'A file on this computer' }));
    await user.click(screen.getByRole('button', { name: 'Pick the backup file' }));
    expect(await screen.findByText(/web\.ambackup/)).toBeTruthy();
    await fillDetails(user);
    await user.click(screen.getByRole('button', { name: 'Restore onto Production' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.restore')).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'srv-1',
          source: { kind: 'file', fileToken: file.token },
        }),
      ),
    );
  });

  it('shows the steps and stops at a failure', async () => {
    const { user, bridge } = renderWizard(
      {
        'deployServerBackups.restore': async () => {
          bridge.$emit('deployServerBackups.onRestoreProgress', {
            serverId: 'srv-1',
            kind: 'step',
            progress: { phase: 'fetch', title: 'Fetch the backup', status: 'done' },
          });
          bridge.$emit('deployServerBackups.onRestoreProgress', {
            serverId: 'srv-1',
            kind: 'step',
            progress: {
              phase: 'stage',
              title: 'Decrypt and check the backup',
              status: 'failed',
              detail: 'The secret key is wrong.',
            },
          });
          throw new Error('The secret key is wrong.');
        },
      },
      { serverId: SERVER.id, destinationId: DISK.id, backupId: STORED.backupId },
    );
    await screen.findByRole('radio', { name: /web-1/ });
    await fillDetails(user);
    await user.click(screen.getByRole('button', { name: 'Restore onto Production' }));
    const steps = await screen.findByRole('list', { name: 'Restore steps' });
    expect(within(steps).getByText(/Fetch the backup/)).toBeTruthy();
    expect(within(steps).getByText(/Decrypt and check the backup \(failed\)/)).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'What the backup brings' })).toBeNull();
  });

  it('picks up a restored state that still waits to be brought up', async () => {
    const { user } = renderWizard({ 'deployServerBackups.pendingRestore': async () => PENDING });
    expect(await screen.findByText(/A restored state waits to be brought up/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue with it' }));
    expect(await screen.findByRole('region', { name: 'What the backup brings' })).toBeTruthy();
  });
});
