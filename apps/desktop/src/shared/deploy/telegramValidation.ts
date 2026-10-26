import type { AlertKind } from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * Checks for the Telegram notifications form (as the user types) and its IPC handler (E30). They
 * follow the core's own rules (TelegramConfig.cs), case for case (see TelegramSettingsTests.cs), so
 * the form says "fine" and "no" where the server does. The core checks everything again.
 */

export type TelegramCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export const MAX_TELEGRAM_SERVER_NAME_LENGTH = 64;

/**
 * The alerts a server can send, in the order the form lists them, with words for a person. A new
 * setup sends every one of them.
 */
export const TELEGRAM_ALERT_KINDS: ReadonlyArray<{
  value: AlertKind;
  label: string;
  hint: string;
}> = [
  {
    value: 'backupFailed',
    label: 'Backup failed',
    hint: 'A backup plan could not make its backup, or a destination did not take it.',
  },
  {
    value: 'containerCrashLoop',
    label: 'Container keeps restarting',
    hint: 'A container exited on its own three times in ten minutes.',
  },
  {
    value: 'jobFailed',
    label: 'Job failed',
    hint: 'A deploy, image pull, upgrade or another job on the server failed.',
  },
  {
    value: 'diskPressure',
    label: 'Disk filling up',
    hint: 'A disk is over 90% full (critical over 95%).',
  },
  {
    value: 'certificateRenewalFailed',
    label: 'Certificate did not renew',
    hint: 'A website certificate could not be renewed.',
  },
  {
    value: 'rebootRequired',
    label: 'Reboot needed',
    hint: 'Installed updates are waiting for a restart.',
  },
  {
    value: 'firewallRolledBack',
    label: 'Firewall rolled back',
    hint: 'A firewall change was not confirmed in time, so the old rules are back.',
  },
  {
    value: 'firewallRollbackFailed',
    label: 'Firewall rollback failed',
    hint: 'Putting the old firewall rules back did not work.',
  },
  {
    value: 'originLockRefreshFailed',
    label: 'Cloudflare lock refresh failed',
    hint: "Cloudflare's address ranges could not be fetched or applied.",
  },
];

const KNOWN_KINDS: ReadonlySet<string> = new Set(TELEGRAM_ALERT_KINDS.map((kind) => kind.value));

const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Trimmed when it looks like a token BotFather hands out. The reason never repeats it. */
export function checkBotToken(value: string): TelegramCheck<string> {
  const token = value.trim();
  return BOT_TOKEN.test(token)
    ? { ok: true, value: token }
    : {
        ok: false,
        reason:
          'That does not look like a bot token. BotFather gives one shaped like 123456789:AAH... when you create the bot.',
      };
}

/** A person or group (a number, a group's starting with -) or a channel's @name. */
export function checkChatId(value: string): TelegramCheck<string> {
  const chat = value.trim();
  return CHAT_ID.test(chat)
    ? { ok: true, value: chat }
    : {
        ok: false,
        reason:
          'Enter the chat ID of the person or group: a number such as 123456789 or -1001234567890, or a channel @name.',
      };
}

/** Trimmed. Empty is fine: the core then uses the machine's own name. */
export function checkTelegramServerName(value: string): TelegramCheck<string> {
  const name = value.trim();
  if (name.length > MAX_TELEGRAM_SERVER_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Server name is too long (${MAX_TELEGRAM_SERVER_NAME_LENGTH} characters at most).`,
    };
  }
  if (CONTROL_CHARACTER.test(name)) {
    return { ok: false, reason: 'Server name cannot hold line breaks or tabs.' };
  }
  return { ok: true, value: name };
}

/** Known kinds, once each, in the order given. */
export function checkKinds(value: unknown): TelegramCheck<AlertKind[]> {
  if (!Array.isArray(value) || value.some((kind) => !KNOWN_KINDS.has(kind))) {
    return { ok: false, reason: 'Pick the alerts to send from the list.' };
  }
  return { ok: true, value: [...new Set(value as AlertKind[])] };
}
