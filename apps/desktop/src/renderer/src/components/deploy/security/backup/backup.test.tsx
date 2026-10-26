import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { SERVER } from '../testing/fixtures';

/**
 * Backups from the Security area: a passphrase typed twice and long enough before anything
 * happens, a cancelled save making nothing, and a restore that needs its file, its passphrase, an
 * Owner of the backup and the server's name typed, then shows its steps and its outcome.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.fn(async () => true);
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (...args: unknown[]) => confirm(...(args as [])),
}));

const { BackupCard } = await import('./BackupCard');
const { passphraseIssue } = await import('./CreateBackupDialog');

const PASSPHRASE = 'orange tractor bicycle lamp';
const FILE = {
  token: '00000000-0000-4000-9000-000000000009',
  name: 'web.ambackup',
  sizeBytes: 2_400_000,
};

function renderCard(bridge: Record<string, unknown> = {}, server = SERVER) {
  return renderWithProviders(<BackupCard server={server} userName="maria" />, {
    bridge: {
      'deploy.account': async () => ({
        twoFactorEnabled: false,
        stepUpUntilUnixMs: Date.now() + 600_000,
      }),
      'deployHardening.createBackup': async () => ({
        saved: true,
        path: 'C:/Backups/web.ambackup',
        sizeBytes: 10,
      }),
      'deployHardening.pickBackup': async () => FILE,
      'deployHardening.restore': async () => ({
        backupCoreVersion: '1.52.0',
        backupHostName: 'old-web',
        backupCreatedAtUnixMs: Date.UTC(2026, 8, 30),
        previousStateFolder: '/var/lib/runova-core-restore/previous',
      }),
      ...bridge,
    },
  });
}

describe('passphraseIssue', () => {
  it('asks for length first, then a match', () => {
    expect(passphraseIssue('', '')).toBeNull();
    expect(passphraseIssue('short', '')).toMatch(/at least 12/);
    expect(passphraseIssue(PASSPHRASE, 'other')).toMatch(/do not match/);
    expect(passphraseIssue(PASSPHRASE, PASSPHRASE)).toBeNull();
  });
});

describe('BackupCard', () => {
  it('points to the Backups section for whole-server backups (E28)', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Backups section' })).toBeTruthy();
  });

  it('makes a backup once the passphrase is long enough and typed twice', async () => {
    const { user, bridge } = renderCard();

    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog', { name: /Back up Production/ });
    const save = within(dialog).getByRole('button', { name: 'Choose where to save' });
    await user.type(within(dialog).getByLabelText('Passphrase'), 'short');
    expect(within(dialog).getByText('Use at least 12 characters.')).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);
    await user.clear(within(dialog).getByLabelText('Passphrase'));
    await user.type(within(dialog).getByLabelText('Passphrase'), PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Passphrase again'), PASSPHRASE);
    await user.click(save);

    expect(bridge.$fn('deployHardening.createBackup')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      passphrase: PASSPHRASE,
    });
    expect(toast.success).toHaveBeenCalledWith('Backup saved to C:/Backups/web.ambackup');
  });

  it('stays open and says nothing when the save dialog is cancelled', async () => {
    const { user } = renderCard({ 'deployHardening.createBackup': async () => ({ saved: false }) });
    toast.success.mockClear();

    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Passphrase'), PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Passphrase again'), PASSPHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Choose where to save' }));

    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('restores after the server name is typed, shows the steps and the outcome', async () => {
    const { user, bridge } = renderCard();

    await user.click(screen.getByRole('button', { name: 'Restore a backup' }));
    const dialog = await screen.findByRole('dialog', { name: /Restore a backup onto Production/ });
    const restore = within(dialog).getByRole('button', { name: 'Restore' });
    expect(restore.hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Pick the backup file' }));
    expect(within(dialog).getByText('web.ambackup (2.3 MB)')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Backup passphrase'), PASSPHRASE);
    await user.type(
      within(dialog).getByLabelText('Their password'),
      'correct horse battery staple',
    );
    act(() => {
      bridge.$emit('deployHardening.onRestoreProgress', {
        serverId: 'srv-1',
        progress: { phase: 'stage', title: 'Decrypt and check the backup', status: 'done' },
      });
    });
    await user.click(restore);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ typeToConfirm: 'Production', variant: 'destructive' }),
    );
    expect(bridge.$fn('deployHardening.restore')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      fileToken: FILE.token,
      passphrase: PASSPHRASE,
      sudoPassword: null,
      userName: 'maria',
      password: 'correct horse battery staple',
    });
    expect(await within(dialog).findByText(/Restored the backup of old-web/)).toBeTruthy();
    expect(within(dialog).getByText('/var/lib/runova-core-restore/previous')).toBeTruthy();
  });

  it('says why a restore stopped', async () => {
    const { user } = renderCard({
      'deployHardening.restore': async () => {
        throw new Error('The passphrase is wrong, or the backup file is damaged.');
      },
    });

    await user.click(screen.getByRole('button', { name: 'Restore a backup' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Pick the backup file' }));
    await user.type(within(dialog).getByLabelText('Backup passphrase'), 'not it at all');
    await user.type(within(dialog).getByLabelText('Their password'), 'pw');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('passphrase is wrong');
  });

  it('cannot restore onto the DevHost, which has no SSH', () => {
    renderCard({}, { ...SERVER, id: 'devhost', dev: true });

    expect(screen.getByRole('button', { name: 'Restore a backup' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
