import type { TelegramNotificationsStatus } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { TELEGRAM_ALERT_KINDS } from '@shared/deploy/telegramValidation';

/** Telegram notifications as a core describes them, for the card's tests. */

const EVERY_KIND = TELEGRAM_ALERT_KINDS.map((kind) => kind.value);

/** A server nobody has set up yet: every kind on, as a new setup sends. */
export function notSetUp(
  fields: Partial<TelegramNotificationsStatus> = {},
): TelegramNotificationsStatus {
  return {
    configured: false,
    enabled: false,
    serverName: 'prod-box',
    defaultServerName: 'prod-box',
    kinds: EVERY_KIND,
    sendResolved: true,
    sentCount: 0,
    ...fields,
  };
}

/** A server sending to a group, waiting for its first alert unless the fields say more. */
export function sending(
  fields: Partial<TelegramNotificationsStatus> = {},
): TelegramNotificationsStatus {
  return {
    configured: true,
    enabled: true,
    chatId: '-1001234567890',
    serverName: 'web-1',
    defaultServerName: 'prod-box',
    kinds: EVERY_KIND,
    sendResolved: true,
    sentCount: 0,
    changedAtUnixMs: Date.now() - 3_600_000,
    changedBy: 'maria',
    ...fields,
  };
}

/** The token the tests paste. */
export const SECRET = 'AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';
export const TOKEN = `7712345678:${SECRET}`;
