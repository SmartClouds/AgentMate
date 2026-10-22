import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployTelegram } from '../deploy/telegram/service';
import { registerDeployTelegramHandlers } from './deployTelegram';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const TOKEN = '7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';
const SECRET = 'AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const telegram = {
    status: vi.fn(async () => ({})),
    save: vi.fn(async (_input: unknown) => ({ problems: [], status: null })),
    remove: vi.fn(async () => ({})),
    test: vi.fn(async () => ({})),
    detectChat: vi.fn(async () => ({ chatId: '123' })),
  };
  registerDeployTelegramHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    telegram: telegram as unknown as DeployTelegram,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, telegram, call };
}

const GOOD = {
  serverId: 'srv-1',
  botToken: TOKEN,
  enabled: true,
  chatId: '-1001234567890',
  serverName: 'web-1',
  kinds: ['backupFailed', 'diskPressure'],
  sendResolved: true,
};

describe('registerDeployTelegramHandlers', () => {
  it('handles every channel of the group', () => {
    const { handlers } = harness();

    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.deployTelegram).sort());
  });

  it('answers only the main window', async () => {
    const { call, telegram } = harness(false);

    await expect(call(IPC.deployTelegram.status, 'srv-1')).rejects.toThrow(/main window/);
    await expect(call(IPC.deployTelegram.save, GOOD)).rejects.toThrow(/main window/);
    await expect(call(IPC.deployTelegram.detectChat, TOKEN)).rejects.toThrow(/main window/);
    expect(telegram.status).not.toHaveBeenCalled();
    expect(telegram.save).not.toHaveBeenCalled();
    expect(telegram.detectChat).not.toHaveBeenCalled();
  });

  it('passes reads and the test with a checked server', async () => {
    const { call, telegram } = harness();

    await call(IPC.deployTelegram.status, 'srv-1');
    await call(IPC.deployTelegram.test, 'srv-1');

    expect(telegram.status).toHaveBeenCalledWith('srv-1');
    expect(telegram.test).toHaveBeenCalledWith('srv-1');
    await expect(call(IPC.deployTelegram.status, '../etc')).rejects.toThrow(/saved server/);
    await expect(call(IPC.deployTelegram.test, 7)).rejects.toThrow(/saved server/);
  });

  it('passes a checked setup with its step-up proof, and nothing else', async () => {
    const { call, telegram } = harness();

    await call(IPC.deployTelegram.save, {
      ...GOOD,
      botToken: `  ${TOKEN}  `,
      chatId: ' 123456789 ',
      password: 'secret',
      extra: 'dropped',
    });

    expect(telegram.save).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: 'secret',
      botToken: TOKEN,
      enabled: true,
      chatId: '123456789',
      serverName: 'web-1',
      kinds: ['backupFailed', 'diskPressure'],
      sendResolved: true,
    });
  });

  it('keeps the stored token when none is sent', async () => {
    const { call, telegram } = harness();

    await call(IPC.deployTelegram.save, { ...GOOD, botToken: undefined });
    await call(IPC.deployTelegram.save, { ...GOOD, botToken: '' });

    for (const [sent] of telegram.save.mock.calls) expect(sent).not.toHaveProperty('botToken');
  });

  it.each([
    [{ botToken: 'nope' }, /BotFather/],
    [{ botToken: 5 }, /token/],
    [{ enabled: 'yes' }, /on or paused/],
    [{ chatId: 'someone' }, /chat ID/],
    [{ chatId: 7 }, /chat ID/],
    [{ serverName: 'a\nb' }, /Server name/],
    [{ serverName: 7 }, /Server name/],
    [{ kinds: ['loud'] }, /alerts/],
    [{ kinds: undefined }, /alerts/],
    [{ sendResolved: 'yes' }, /clears/],
  ])('refuses %o without telling the core', async (fields, reason) => {
    const { call, telegram } = harness();

    await expect(call(IPC.deployTelegram.save, { ...GOOD, ...fields })).rejects.toThrow(reason);
    expect(telegram.save).not.toHaveBeenCalled();
  });

  it('never repeats the token when it refuses one', async () => {
    const { call } = harness();

    const error = await call(IPC.deployTelegram.save, { ...GOOD, botToken: `${TOKEN}/` }).catch(
      (caught: Error) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('removes with a checked server and its step-up proof', async () => {
    const { call, telegram } = harness();

    await call(IPC.deployTelegram.remove, { serverId: 'srv-1', totpCode: '123456' });

    expect(telegram.remove).toHaveBeenCalledWith({ serverId: 'srv-1', totpCode: '123456' });
  });

  it('looks up the chat with a checked token', async () => {
    const { call, telegram } = harness();

    expect(await call(IPC.deployTelegram.detectChat, ` ${TOKEN} `)).toEqual({ chatId: '123' });
    expect(telegram.detectChat).toHaveBeenCalledWith(TOKEN);
    await expect(call(IPC.deployTelegram.detectChat, 'nope')).rejects.toThrow(/BotFather/);
    await expect(call(IPC.deployTelegram.detectChat, 5)).rejects.toThrow(/token/);
  });
});
