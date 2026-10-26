import type {
  TelegramNotificationsRequest,
  TelegramNotificationsSaveResult,
  TelegramNotificationsStatus,
  TelegramNotificationsTestResult,
} from '../protocol/generated/Runova.ServerCore.Contracts';
import {
  checkBotToken,
  checkChatId,
  checkKinds,
  checkTelegramServerName,
  TELEGRAM_ALERT_KINDS,
} from '../telegramValidation';
import { FAKE_MACHINE_NAME } from './fakeErrorReporting';

/**
 * Telegram notifications on the pretend server (E30): what the core keeps about them and how a test
 * message goes. Like the real core it holds the token without ever returning it, and checks a
 * request the way the form does. Tests play Telegram's answer by setting `testAnswer`.
 */

const EVERY_KIND = TELEGRAM_ALERT_KINDS.map((kind) => kind.value);

function notSetUp(): TelegramNotificationsStatus {
  return {
    configured: false,
    enabled: false,
    serverName: FAKE_MACHINE_NAME,
    defaultServerName: FAKE_MACHINE_NAME,
    kinds: EVERY_KIND,
    sendResolved: true,
    sentCount: 0,
  };
}

export class FakeTelegram {
  status: TelegramNotificationsStatus = notSetUp();

  /** The token the pretend core holds. It is never part of an answer. */
  token: string | null = null;

  /** What the next test message comes to. */
  testAnswer: TelegramNotificationsTestResult = {
    delivered: true,
    message: 'Telegram took the test message. It should be in the chat now.',
  };

  constructor(private readonly deps: { now: () => number; userName: () => string }) {}

  save(request: TelegramNotificationsRequest): TelegramNotificationsSaveResult {
    const problems: string[] = [];
    let token = this.token;
    if (request.botToken?.trim()) {
      const checked = checkBotToken(request.botToken);
      if (checked.ok) token = checked.value;
      else problems.push(checked.reason);
    } else if (!token) {
      problems.push('Paste the bot token BotFather gave you when you created the bot.');
    }
    const chat = checkChatId(request.chatId ?? '');
    if (!chat.ok) problems.push(chat.reason);
    const serverName = checkTelegramServerName(request.serverName ?? '');
    if (!serverName.ok) problems.push(serverName.reason);
    const kinds = checkKinds(request.kinds ?? EVERY_KIND);
    if (!kinds.ok) problems.push(kinds.reason);
    if (problems.length > 0 || !token || !chat.ok || !serverName.ok || !kinds.ok) {
      return { problems };
    }
    this.token = token;
    this.status = {
      configured: true,
      enabled: request.enabled,
      chatId: chat.value,
      serverName: serverName.value || FAKE_MACHINE_NAME,
      defaultServerName: FAKE_MACHINE_NAME,
      kinds: EVERY_KIND.filter((kind) => kinds.value.includes(kind)),
      sendResolved: request.sendResolved,
      sentCount: this.status.sentCount,
      changedAtUnixMs: this.deps.now(),
      changedBy: this.deps.userName(),
    };
    return { problems: [], status: { ...this.status } };
  }

  remove(): TelegramNotificationsStatus {
    this.token = null;
    this.status = notSetUp();
    return { ...this.status };
  }

  test(): TelegramNotificationsTestResult {
    if (!this.status.configured) {
      return { delivered: false, message: 'Telegram is not set up on this server yet.' };
    }
    if (this.testAnswer.delivered) {
      this.status = {
        ...this.status,
        sentCount: this.status.sentCount + 1,
        lastSentAtUnixMs: this.deps.now(),
      };
      delete this.status.lastError;
    } else {
      this.status = {
        ...this.status,
        lastFailedAtUnixMs: this.deps.now(),
        lastError: this.testAnswer.message,
      };
    }
    return { ...this.testAnswer };
  }
}
