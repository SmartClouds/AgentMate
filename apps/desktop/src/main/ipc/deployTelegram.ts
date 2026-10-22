import type { IpcMainInvokeEvent } from 'electron';
import {
  checkBotToken,
  checkChatId,
  checkKinds,
  checkTelegramServerName,
} from '../../shared/deploy/telegramValidation';
import type {
  DeployTelegramRemoveInput,
  DeployTelegramSaveInput,
} from '../../shared/deployTelegramTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployTelegram } from '../deploy/telegram/service';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';

/**
 * Telegram notification channels (E30): how they stand, setting them up, removing them, a test
 * message, and finding the chat ID from the bot. Main window only, every argument checked here; the
 * core checks them again and decides who may change them. The token is checked for its shape and
 * never repeated in a message: it stays in the form.
 */

export interface DeployTelegramHandlerDeps {
  ipc: DeployIpcRegistry;
  telegram: Pick<DeployTelegram, 'status' | 'save' | 'remove' | 'test' | 'detectChat'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

function token(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The bot token must be text.');
  const checked = checkBotToken(value);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

/** Empty or missing means "keep the token the core already has". */
function optionalToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  return token(value);
}

export function saveInput(value: unknown): DeployTelegramSaveInput {
  const input = object(value, 'the Telegram settings');
  const proof = stepUpInput(value);
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Say whether Telegram notifications are on or paused.');
  }
  if (typeof input.sendResolved !== 'boolean') {
    throw new Error('Say whether to send a note when a problem clears.');
  }
  const chat = checkChatId(typeof input.chatId === 'string' ? input.chatId : '');
  if (!chat.ok) throw new Error(chat.reason);
  if (typeof input.serverName !== 'string') throw new Error('Server name must be text.');
  const serverName = checkTelegramServerName(input.serverName);
  if (!serverName.ok) throw new Error(serverName.reason);
  const kinds = checkKinds(input.kinds);
  if (!kinds.ok) throw new Error(kinds.reason);
  const botToken = optionalToken(input.botToken);
  return {
    ...proof,
    ...(botToken ? { botToken } : {}),
    enabled: input.enabled,
    chatId: chat.value,
    serverName: serverName.value,
    kinds: kinds.value,
    sendResolved: input.sendResolved,
  };
}

function removeInput(value: unknown): DeployTelegramRemoveInput {
  return stepUpInput(value);
}

export function registerDeployTelegramHandlers(deps: DeployTelegramHandlerDeps): void {
  const { ipc, telegram } = deps;
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployTelegram.status, (id) => telegram.status(serverId(id)));
  handle(IPC.deployTelegram.save, (value) => telegram.save(saveInput(value)));
  handle(IPC.deployTelegram.remove, (value) => telegram.remove(removeInput(value)));
  handle(IPC.deployTelegram.test, (id) => telegram.test(serverId(id)));
  handle(IPC.deployTelegram.detectChat, (value) => telegram.detectChat(token(value)));
}
