import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BOX, DISK, SERVER, STEPPED_UP } from './testing/fixtures';

/**
 * Destinations (E28): an SFTP server's host key is shown by a test first and pinned only once the
 * user trusts it; Telegram signs in with a code and then the cloud password when the account has
 * one; Google Drive and OneDrive sign in through the browser with the user's own OAuth client;
 * removing a destination asks first.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.fn(async () => true);
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (...args: unknown[]) => confirm(...(args as [])),
}));

const { DestinationsTab } = await import('./DestinationsTab');
const { useStepUp } = await import('../security/useStepUp');

const KEY = 'SHA256:9a3b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b';

function Harness(): React.JSX.Element {
  const stepUp = useStepUp(SERVER);
  return (
    <>
      <DestinationsTab server={SERVER} stepUp={stepUp} />
      {stepUp.dialog}
    </>
  );
}

function renderTab(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<Harness />, {
    bridge: {
      ...STEPPED_UP,
      'deployServerBackups.listDestinations': [DISK, BOX],
      'deployServerBackups.saveDestination': async () => DISK,
      ...bridge,
    },
  });
}

async function addKind(user: ReturnType<typeof renderTab>['user'], kind: string) {
  await user.click(await screen.findByRole('button', { name: 'Add a destination' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a destination' });
  await user.click(within(dialog).getByRole('combobox', { name: 'Kind' }));
  await user.click(await screen.findByRole('option', { name: kind }));
  return dialog;
}

describe('DestinationsTab', () => {
  it('lists destinations with what went wrong last', async () => {
    renderTab();
    const row = await screen.findByRole('listitem', { name: 'Storage box' });
    expect(within(row).getByText('SFTP')).toBeTruthy();
    expect(within(row).getByText(/Connection refused/)).toBeTruthy();
  });

  it('shows an SFTP host key from a test and pins it only once trusted', async () => {
    const test = vi.fn(async () => ({
      ok: false,
      problem: 'The host key is not trusted yet.',
      hostKeySha256: KEY,
    }));
    const { user, bridge } = renderTab({ 'deployServerBackups.testDestination': test });
    const dialog = await addKind(user, 'SFTP');

    await user.type(within(dialog).getByLabelText('Name'), 'Box');
    await user.type(within(dialog).getByLabelText('Host'), 'box.example');
    await user.type(within(dialog).getByLabelText('User'), 'u1');
    await user.type(within(dialog).getByLabelText('Password'), 'pw');
    await user.type(within(dialog).getByLabelText('Folder'), '/backups');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText(KEY)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Trust this key' }));
    expect(save.hasAttribute('disabled')).toBe(false);
    await user.click(save);

    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.saveDestination')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        destination: {
          name: 'Box',
          kind: 'sftp',
          settings: {
            host: 'box.example',
            port: 22,
            userName: 'u1',
            path: '/backups',
            hostKeySha256: KEY,
          },
          secret: { password: 'pw' },
        },
      }),
    );
  });

  it('signs in to Telegram with the code, then the cloud password', async () => {
    const start = vi.fn(async () => ({ loginId: 'login-1', step: 'code' }));
    const next = vi
      .fn()
      .mockResolvedValueOnce({ loginId: 'login-1', step: 'password' })
      .mockResolvedValueOnce({
        loginId: 'login-1',
        step: 'done',
        accountName: 'Maria',
        isPremium: false,
      });
    const { user, bridge } = renderTab({
      'deployServerBackups.startTelegramLogin': start,
      'deployServerBackups.continueTelegramLogin': next,
    });
    const dialog = await addKind(user, 'Telegram');
    expect(within(dialog).getByText(/parts of 2000 MB/)).toBeTruthy();

    await user.type(within(dialog).getByLabelText('Name'), 'Telegram');
    await user.type(within(dialog).getByLabelText('api_id'), '12345');
    await user.type(within(dialog).getByLabelText('api_hash'), '0123456789abcdef0123456789abcdef');
    await user.type(within(dialog).getByLabelText('Phone number'), '+49 151 2345678');
    await user.click(within(dialog).getByRole('button', { name: 'Send the code' }));
    expect(start).toHaveBeenCalledWith({
      serverId: 'srv-1',
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      phoneNumber: '+49 151 2345678',
    });

    await user.type(await within(dialog).findByLabelText('Code from Telegram'), '12345');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(await within(dialog).findByLabelText('Cloud password'), 'cloud pw');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(next).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      loginId: 'login-1',
      password: 'cloud pw',
    });
    expect(await within(dialog).findByText(/Signed in as Maria/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.saveDestination')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        destination: {
          name: 'Telegram',
          kind: 'telegram',
          settings: { apiId: 12345, accountName: 'Maria', isPremium: false, chat: 'me' },
          secret: { apiHash: '0123456789abcdef0123456789abcdef', telegramLoginId: 'login-1' },
        },
      }),
    );
  });

  it('signs in to Google Drive in the browser with the user own client', async () => {
    const connect = vi.fn(async () => ({ ...DISK, kind: 'googleDrive', name: 'Drive' }));
    const { user } = renderTab({ 'deployServerBackups.connectCloudDrive': connect });
    const dialog = await addKind(user, 'Google Drive');
    expect(within(dialog).getByText(/Desktop app/)).toBeTruthy();

    await user.type(within(dialog).getByLabelText('Name'), 'Drive');
    await user.type(within(dialog).getByLabelText('Client ID'), 'abc.apps.googleusercontent.com');
    await user.type(within(dialog).getByLabelText('Client secret'), 'GOCSPX-1');
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Google' }));

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        serverId: 'srv-1',
        name: 'Drive',
        kind: 'googleDrive',
        clientId: 'abc.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-1',
        folderName: 'AgentMate backups',
      }),
    );
  });

  it('asks before removing a destination', async () => {
    const remove = vi.fn(async () => true);
    const { user } = renderTab({ 'deployServerBackups.deleteDestination': remove });
    const row = await screen.findByRole('listitem', { name: 'Local disk' });
    await user.click(within(row).getByRole('button', { name: 'Remove Local disk' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ serverId: 'srv-1', id: DISK.id }));
  });
});
