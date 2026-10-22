import { describe, expect, it, vi } from 'vitest';
import type {
  AlertKind,
  TelegramNotificationsRequest,
  TelegramNotificationsStatus,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import { DeployTelegram } from './service';

const TOKEN = '7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';

const STATUS: TelegramNotificationsStatus = {
  configured: true,
  enabled: true,
  chatId: '-1001234567890',
  serverName: 'web-1',
  defaultServerName: 'web-1',
  kinds: ['backupFailed', 'containerCrashLoop'],
  sendResolved: true,
  sentCount: 2,
};

const BASE = {
  serverId: 'srv',
  enabled: true,
  chatId: '-1001234567890',
  serverName: 'web-1',
  kinds: ['backupFailed', 'containerCrashLoop'] as AlertKind[],
  sendResolved: true,
};

function setup(
  roles = ['owner'],
  hubOverrides: Partial<Record<string, unknown>> = {},
  detect = vi.fn(async (_token: string) => ({ chatId: '123456789' as string | null })),
) {
  const hub = {
    stepUp: vi.fn(async () => ({ stepUpUntilUnixMs: 1 })),
    getTelegramNotifications: vi.fn(async () => STATUS),
    saveTelegramNotifications: vi.fn(async (_request: TelegramNotificationsRequest) => ({
      problems: [],
      status: STATUS,
    })),
    removeTelegramNotifications: vi.fn(async () => ({ ...STATUS, configured: false })),
    sendTelegramNotificationTest: vi.fn(async () => ({
      delivered: true,
      message: 'Telegram took the test message. It should be in the chat now.',
    })),
    ...hubOverrides,
  };
  const service = new DeployTelegram({
    links: { call: (_id, work) => work(hub as unknown as ICoreHub) },
    roles: () => roles,
    detectChat: detect,
  });
  return { service, hub, detect };
}

describe('DeployTelegram', () => {
  it('reads how notifications stand', async () => {
    const { service, hub } = setup();

    expect(await service.status('srv')).toEqual(STATUS);
    expect(hub.getTelegramNotifications).toHaveBeenCalledOnce();
  });

  it('saves the setup, stepping up first when handed the password', async () => {
    const { service, hub } = setup();

    const result = await service.save({ ...BASE, botToken: ` ${TOKEN} `, password: 'pw' });

    expect(hub.stepUp).toHaveBeenCalledWith({ password: 'pw' });
    expect(hub.saveTelegramNotifications).toHaveBeenCalledWith({
      enabled: true,
      botToken: TOKEN,
      chatId: '-1001234567890',
      serverName: 'web-1',
      kinds: ['backupFailed', 'containerCrashLoop'],
      sendResolved: true,
    });
    expect(hub.stepUp.mock.invocationCallOrder[0]).toBeLessThan(
      hub.saveTelegramNotifications.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toEqual({ problems: [], status: STATUS });
  });

  it('leaves the token out to keep the one the core has, and steps up only when asked to', async () => {
    const { service, hub } = setup();

    await service.save({ ...BASE, botToken: '  ' });

    expect(hub.stepUp).not.toHaveBeenCalled();
    expect(hub.saveTelegramNotifications.mock.calls[0]?.[0]).not.toHaveProperty('botToken');
  });

  it('passes the problems the core found on, with no status', async () => {
    const { service } = setup(['owner'], {
      saveTelegramNotifications: vi.fn(async () => ({ problems: ['Bad chat.'] })),
    });

    expect(await service.save(BASE)).toEqual({ problems: ['Bad chat.'], status: null });
  });

  it('refuses a token or chat the core would refuse, before calling it', async () => {
    const { service, hub } = setup();

    await expect(service.save({ ...BASE, botToken: 'nope' })).rejects.toThrow(/BotFather/);
    await expect(service.save({ ...BASE, chatId: 'someone' })).rejects.toThrow(/chat ID/);
    expect(hub.saveTelegramNotifications).not.toHaveBeenCalled();
  });

  it('removes it with a step-up, and sends a test', async () => {
    const { service, hub } = setup();

    expect((await service.remove({ serverId: 'srv', totpCode: '123456' })).configured).toBe(false);
    expect(hub.stepUp).toHaveBeenCalledWith({ totpCode: '123456' });
    expect((await service.test('srv')).delivered).toBe(true);
  });

  it('finds the chat that last wrote to the bot, from this computer', async () => {
    const { service, detect } = setup();

    expect(await service.detectChat(` ${TOKEN} `)).toEqual({ chatId: '123456789' });
    expect(detect).toHaveBeenCalledWith(TOKEN);
  });

  it('never repeats the token when finding the chat fails', async () => {
    const { service } = setup(
      ['owner'],
      {},
      vi.fn(async () => ({
        chatId: null,
        error: `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`,
      })),
    );

    const result = await service.detectChat(TOKEN);

    expect(result.chatId).toBeNull();
    expect(result.error).not.toContain('AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE');
  });

  it('refuses a token that is not shaped like one before asking Telegram', async () => {
    const { service, detect } = setup();

    await expect(service.detectChat('nope')).rejects.toThrow(/BotFather/);
    expect(detect).not.toHaveBeenCalled();
  });

  it('says to update the core when the server does not know these calls', async () => {
    const { service } = setup(['owner'], {
      getTelegramNotifications: vi.fn(async () => {
        throw new Error(
          "Failed to invoke 'GetTelegramNotifications' due to an error on the server. HubException: Method does not exist.",
        );
      }),
    });

    await expect(service.status('srv')).rejects.toThrow(/older core/);
  });
});
