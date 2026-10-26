import { describe, expect, it } from 'vitest';
import type { AlertKind } from './protocol/generated/Runova.ServerCore.Contracts';
import {
  checkBotToken,
  checkChatId,
  checkKinds,
  checkTelegramServerName,
  MAX_TELEGRAM_SERVER_NAME_LENGTH,
  TELEGRAM_ALERT_KINDS,
} from './telegramValidation';

/**
 * The same cases as the core's TelegramSettingsTests.cs, so the form says "fine" and "no" exactly
 * where the server does. The core still checks everything again.
 */

const TOKEN = '7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';

describe('checkBotToken', () => {
  it.each([TOKEN, '123:abcdefghijklmnopqrstuvwxyz_-0123', `  ${TOKEN} `])(
    'takes a token shaped like BotFather gives: %s',
    (token) => {
      expect(checkBotToken(token)).toEqual({ ok: true, value: token.trim() });
    },
  );

  it.each([
    '',
    'AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE',
    '7712345678:short',
    '7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1g/jE',
    `bot${TOKEN}`,
  ])('refuses %s and points at BotFather', (token) => {
    const result = checkBotToken(token);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('BotFather');
  });

  it('never repeats the token in its reason', () => {
    const result = checkBotToken(`${TOKEN}!`);

    expect(result.ok ? '' : result.reason).not.toContain('AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE');
  });
});

describe('checkChatId', () => {
  it.each(['123456789', '-1001234567890', '-4567890', '@runova_alerts', '  123456789 '])(
    'takes a person, a group or a channel: %s',
    (chat) => {
      expect(checkChatId(chat)).toEqual({ ok: true, value: chat.trim() });
    },
  );

  it.each(['', '12 34', '@ab', 'https://t.me/runova', '--123'])('refuses %s', (chat) => {
    const result = checkChatId(chat);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('chat ID');
  });
});

describe('checkTelegramServerName', () => {
  it('trims the name and leaves an empty one empty, for the machine name', () => {
    expect(checkTelegramServerName('  prod 1 ')).toEqual({ ok: true, value: 'prod 1' });
    expect(checkTelegramServerName('   ')).toEqual({ ok: true, value: '' });
  });

  it('keeps it short and on one line', () => {
    expect(checkTelegramServerName('x'.repeat(MAX_TELEGRAM_SERVER_NAME_LENGTH + 1)).ok).toBe(false);
    expect(checkTelegramServerName('prod\n1').ok).toBe(false);
  });
});

describe('TELEGRAM_ALERT_KINDS', () => {
  it('lists every kind the core knows once, each with a label', () => {
    const every: Record<AlertKind, true> = {
      diskPressure: true,
      jobFailed: true,
      rebootRequired: true,
      firewallRolledBack: true,
      firewallRollbackFailed: true,
      certificateRenewalFailed: true,
      originLockRefreshFailed: true,
      backupFailed: true,
      containerCrashLoop: true,
    };

    expect(TELEGRAM_ALERT_KINDS.map((kind) => kind.value).sort()).toEqual(
      Object.keys(every).sort(),
    );
    for (const kind of TELEGRAM_ALERT_KINDS) expect(kind.label.length).toBeGreaterThan(0);
  });

  it('puts backups and crash loops first, as the ones people ask for most', () => {
    expect(TELEGRAM_ALERT_KINDS.slice(0, 2).map((kind) => kind.value)).toEqual([
      'backupFailed',
      'containerCrashLoop',
    ]);
  });
});

describe('checkKinds', () => {
  it('keeps known kinds once each and refuses anything else', () => {
    expect(checkKinds(['jobFailed', 'diskPressure', 'jobFailed'])).toEqual({
      ok: true,
      value: ['jobFailed', 'diskPressure'],
    });
    expect(checkKinds([])).toEqual({ ok: true, value: [] });
    expect(checkKinds(['nope']).ok).toBe(false);
    expect(checkKinds('diskPressure').ok).toBe(false);
  });
});
