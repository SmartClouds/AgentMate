import { encodeCoreError } from '@shared/coreErrors';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, signedIn } from '../security/testing/fixtures';
import { notSetUp, SECRET, sending, TOKEN } from './testing/fixtures';

/**
 * A server's Notifications section (E30): Telegram alerts through their states. Shimmer, an older
 * core, not set up (for an Owner with the form, for an Admin without), the form's checks, finding
 * the chat, turning it on after a step-up, set up with its facts, the test message and removing it.
 * Roles below Admin see no setup at all.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { NotificationsPanel } = await import('./NotificationsPanel');

function renderPanel(
  overrides: Record<string, unknown> = {},
  options: { roles?: string[]; onUpdateCore?: () => void } = {},
) {
  return renderWithProviders(
    <NotificationsPanel
      server={SERVER}
      {...(options.onUpdateCore ? { onUpdateCore: options.onUpdateCore } : {})}
    />,
    {
      bridge: {
        'deploy.access': async () => signedIn(options.roles ?? ['owner']),
        'deployTelegram.status': async () => notSetUp(),
        ...overrides,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
});

describe('NotificationsPanel', () => {
  it('shimmers while it reads the core', async () => {
    const { container } = renderPanel({
      'deployTelegram.status': () => new Promise(() => undefined),
    });

    await waitFor(() =>
      expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull(),
    );
  });

  it('tells roles below Admin that an Admin or Owner sets this up', async () => {
    renderPanel({}, { roles: ['operator'] });

    expect(await screen.findByText(/Admins and Owners/)).toBeTruthy();
    expect(screen.queryByLabelText('Bot token')).toBeNull();
  });

  it('offers the core update when the server runs a core without this feature', async () => {
    const onUpdateCore = vi.fn();
    const { user } = renderPanel(
      {
        'deployTelegram.status': async () => {
          throw new Error(
            'This server runs an older core without Telegram notifications. Update the core from the Overview, then try again.',
          );
        },
      },
      { onUpdateCore },
    );

    expect(await screen.findByText(/older core without Telegram/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Update the core' }));
    expect(onUpdateCore).toHaveBeenCalledOnce();
  });

  describe('when it is not set up', () => {
    it('shows an Owner how to make a bot, and a form with the server name and every alert on', async () => {
      renderPanel();

      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(screen.getByText(/@BotFather/)).toBeTruthy();
      expect((screen.getByLabelText('Server name') as HTMLInputElement).value).toBe('Production');
      expect(screen.getByLabelText('Bot token')).toBeTruthy();
      expect(screen.getByLabelText('Chat ID')).toBeTruthy();
      for (const label of ['Backup failed', 'Container keeps restarting', 'Disk filling up']) {
        expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe(
          'true',
        );
      }
      expect(
        screen
          .getByRole('switch', { name: 'Also tell me when a problem clears' })
          .getAttribute('aria-checked'),
      ).toBe('true');
      expect(screen.getByRole('button', { name: 'Turn on Telegram alerts' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send test message' })).toBeNull();
    });

    it('tells an Admin an Owner has to set it up, with no form', async () => {
      renderPanel({}, { roles: ['admin'] });

      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(screen.getByText(/An Owner can set this up/)).toBeTruthy();
      expect(screen.queryByLabelText('Bot token')).toBeNull();
    });

    it('checks the token and chat as they are typed and sends nothing wrong', async () => {
      const { user, bridge } = renderPanel();

      await user.type(await screen.findByLabelText('Bot token'), 'nonsense');
      await user.type(screen.getByLabelText('Chat ID'), 'someone');
      await user.click(screen.getByRole('button', { name: 'Turn on Telegram alerts' }));

      expect(await screen.findByText(/does not look like a bot token/)).toBeTruthy();
      expect(screen.getByText(/Enter the chat ID/)).toBeTruthy();
      expect(() => bridge.$fn('deployTelegram.save')).toThrow(/not been touched/);
    });

    it('requires a token the first time', async () => {
      const { user, bridge } = renderPanel();

      await user.type(await screen.findByLabelText('Chat ID'), '123456789');
      await user.click(screen.getByRole('button', { name: 'Turn on Telegram alerts' }));

      expect(await screen.findByText(/Paste the token BotFather gave you/)).toBeTruthy();
      expect(() => bridge.$fn('deployTelegram.save')).toThrow(/not been touched/);
    });

    it('finds the chat that last wrote to the bot', async () => {
      const { user, bridge } = renderPanel({
        'deployTelegram.detectChat': async () => ({ chatId: '-1009876543210' }),
      });

      const detect = await screen.findByRole('button', { name: 'Detect' });
      expect(detect.hasAttribute('disabled')).toBe(true);
      await user.type(screen.getByLabelText('Bot token'), TOKEN);
      await user.click(detect);

      await waitFor(() =>
        expect((screen.getByLabelText('Chat ID') as HTMLInputElement).value).toBe('-1009876543210'),
      );
      expect(bridge.$fn('deployTelegram.detectChat')).toHaveBeenCalledWith(TOKEN);
    });

    it('says why the chat could not be found', async () => {
      const { user } = renderPanel({
        'deployTelegram.detectChat': async () => ({
          chatId: null,
          error: 'No messages found yet. Send your bot any message on Telegram, then try again.',
        }),
      });

      await user.type(await screen.findByLabelText('Bot token'), TOKEN);
      await user.click(screen.getByRole('button', { name: 'Detect' }));

      expect(await screen.findByText(/No messages found yet/)).toBeTruthy();
    });

    it('turns it on after a step-up with only the alerts left on, and clears the token', async () => {
      let calls = 0;
      const { user, bridge } = renderPanel({
        'deployTelegram.save': async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(encodeCoreError('stepUpRequired', 'Needs your password again.'));
          }
          return { problems: [], status: sending() };
        },
      });

      await user.type(await screen.findByLabelText('Bot token'), TOKEN);
      await user.type(screen.getByLabelText('Chat ID'), '-1001234567890');
      await user.click(screen.getByRole('switch', { name: 'Reboot needed' }));
      await user.click(screen.getByRole('button', { name: 'Turn on Telegram alerts' }));
      await user.type(await screen.findByLabelText('Password'), 'secret');
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() =>
        expect(bridge.$fn('deployTelegram.save')).toHaveBeenLastCalledWith(
          expect.objectContaining({
            serverId: SERVER.id,
            botToken: TOKEN,
            enabled: true,
            chatId: '-1001234567890',
            serverName: 'Production',
            sendResolved: true,
            password: 'secret',
          }),
        ),
      );
      const sent = bridge.$fn('deployTelegram.save').mock.calls.at(-1)?.[0] as {
        kinds: string[];
      };
      expect(sent.kinds).not.toContain('rebootRequired');
      expect(sent.kinds).toContain('backupFailed');
      expect(sent.kinds).toContain('containerCrashLoop');
      expect(await screen.findByText('On, nothing sent yet')).toBeTruthy();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Telegram alerts are on'));
      expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('');
    });

    it('lists what the core found wrong and keeps the form', async () => {
      const { user } = renderPanel({
        'deployTelegram.save': async () => ({ problems: ['The chat is not known.'] }),
      });

      await user.type(await screen.findByLabelText('Bot token'), TOKEN);
      await user.type(screen.getByLabelText('Chat ID'), '123456789');
      await user.click(screen.getByRole('button', { name: 'Turn on Telegram alerts' }));

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The chat is not known.')).toBeTruthy();
      expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe(TOKEN);
    });
  });

  describe('when it is set up', () => {
    const delivered = () =>
      sending({
        sentCount: 4,
        lastSentAtUnixMs: Date.now() - 120_000,
        kinds: ['backupFailed', 'containerCrashLoop'],
      });

    it('shows the chat, the name, the alerts and how sending goes, never the token', async () => {
      const { container } = renderPanel({ 'deployTelegram.status': async () => delivered() });

      const details = await screen.findByLabelText('Telegram details');
      expect(within(details).getByText('-1001234567890')).toBeTruthy();
      expect(within(details).getByText('web-1')).toBeTruthy();
      expect(within(details).getByText('Backup failed, Container keeps restarting')).toBeTruthy();
      expect(within(details).getByText(/4 messages/)).toBeTruthy();
      expect(within(details).getByText(/by maria/)).toBeTruthy();
      expect(screen.getByText('Sending')).toBeTruthy();
      expect(container.textContent).not.toContain(SECRET);
    });

    it('fills the form from the core and keeps the stored token unless a new one is pasted', async () => {
      const { user, bridge } = renderPanel({
        'deployTelegram.status': async () => delivered(),
        'deployTelegram.save': async () => ({ problems: [], status: delivered() }),
      });

      expect(
        ((await screen.findByLabelText('Bot token')) as HTMLInputElement).getAttribute(
          'placeholder',
        ),
      ).toBe('Leave empty to keep the current token');
      expect((screen.getByLabelText('Server name') as HTMLInputElement).value).toBe('web-1');
      expect((screen.getByLabelText('Chat ID') as HTMLInputElement).value).toBe('-1001234567890');
      expect(
        screen.getByRole('switch', { name: 'Disk filling up' }).getAttribute('aria-checked'),
      ).toBe('false');

      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(bridge.$fn('deployTelegram.save')).toHaveBeenCalled());
      const sent = bridge.$fn('deployTelegram.save').mock.calls.at(-1)?.[0];
      expect(sent).not.toHaveProperty('botToken');
      expect(sent).toMatchObject({ kinds: ['backupFailed', 'containerCrashLoop'] });
    });

    it('sends a test message and says what Telegram answered', async () => {
      const { user } = renderPanel({
        'deployTelegram.status': async () => delivered(),
        'deployTelegram.test': async () => ({
          delivered: false,
          message:
            'Telegram cannot find that chat. Start a chat with the bot, or add it to the group, then try again.',
        }),
      });

      await user.click(await screen.findByRole('button', { name: 'Send test message' }));

      expect(await screen.findByText(/cannot find that chat/)).toBeTruthy();
    });

    it('shows the last failure the core holds', async () => {
      renderPanel({
        'deployTelegram.status': async () =>
          sending({
            lastFailedAtUnixMs: Date.now() - 1_000,
            lastError: 'The bot was blocked in that chat.',
          }),
      });

      expect(await screen.findByText('Last send failed')).toBeTruthy();
      expect(screen.getByText('The bot was blocked in that chat.')).toBeTruthy();
    });

    it('removes it once confirmed', async () => {
      const { user, bridge } = renderPanel({
        'deployTelegram.status': async () => delivered(),
        'deployTelegram.remove': async () => notSetUp(),
      });

      await user.click(await screen.findByRole('button', { name: 'Remove' }));

      await waitFor(() =>
        expect(bridge.$fn('deployTelegram.remove')).toHaveBeenCalledWith({ serverId: SERVER.id }),
      );
      expect(confirm).toHaveBeenCalledOnce();
      expect(await screen.findByText('Not set up')).toBeTruthy();
      expect(toast.success).toHaveBeenCalledWith('Telegram alerts were removed.');
    });
  });
});
