import { describe, expect, it } from 'vitest';
import {
  checkEnvironment,
  checkServerName,
  dsnDestination,
  ERROR_REPORTING_LEVELS,
  MAX_DSN_LENGTH,
  MAX_ENVIRONMENT_LENGTH,
  MAX_SERVER_NAME_LENGTH,
  parseSentryDsn,
} from './errorReportingValidation';

/**
 * The same cases as the core's SentryDsnTests.cs, so the form says "fine" and "no" exactly where
 * the server does. The core still checks everything again.
 */

const KEY = 'd4e5f60718293a4b5c6d7e8f90a1b2c3';

describe('parseSentryDsn', () => {
  it.each([
    [
      `https://${KEY}@o123456.ingest.us.sentry.io/4501`,
      'o123456.ingest.us.sentry.io',
      '4501',
      'https://o123456.ingest.us.sentry.io/api/4501/integration/otlp/v1/logs',
    ],
    [
      `https://${KEY}@o9.ingest.de.sentry.io/77`,
      'o9.ingest.de.sentry.io',
      '77',
      'https://o9.ingest.de.sentry.io/api/77/integration/otlp/v1/logs',
    ],
    [
      `https://${KEY}@sentry.example.com:9000/12`,
      'sentry.example.com:9000',
      '12',
      'https://sentry.example.com:9000/api/12/integration/otlp/v1/logs',
    ],
    [
      `https://${KEY}@example.com/sentry/12`,
      'example.com',
      '12',
      'https://example.com/sentry/api/12/integration/otlp/v1/logs',
    ],
    [
      `  https://${KEY}@sentry.example.com/3\n`,
      'sentry.example.com',
      '3',
      'https://sentry.example.com/api/3/integration/otlp/v1/logs',
    ],
    [
      `http://${KEY}@127.0.0.1:8123/1`,
      '127.0.0.1:8123',
      '1',
      'http://127.0.0.1:8123/api/1/integration/otlp/v1/logs',
    ],
    [
      `http://${KEY}@localhost/1`,
      'localhost',
      '1',
      'http://localhost/api/1/integration/otlp/v1/logs',
    ],
    [`http://${KEY}@[::1]:9/5`, '[::1]:9', '5', 'http://[::1]:9/api/5/integration/otlp/v1/logs'],
  ])('reads a good DSN: %s', (text, authority, projectId, logsUrl) => {
    const parsed = parseSentryDsn(text);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.authority).toBe(authority);
    expect(parsed.value.projectId).toBe(projectId);
    expect(parsed.value.logsUrl).toBe(logsUrl);
    expect(parsed.value.publicKey).toBe(KEY);
  });

  it('drops the old secret part and never lets it into the address', () => {
    const parsed = parseSentryDsn(`https://${KEY}:0123456789abcdef@sentry.example.com/9`);
    expect(parsed.ok && parsed.value.publicKey).toBe(KEY);
    expect(JSON.stringify(parsed)).not.toContain('0123456789abcdef');
  });

  it.each([
    [undefined, 'Paste the DSN'],
    ['', 'Paste the DSN'],
    ['   ', 'Paste the DSN'],
    ['not a dsn', 'not a Sentry DSN'],
    ['sentry.example.com/1', 'not a Sentry DSN'],
    [`ftp://${KEY}@sentry.example.com/1`, 'https'],
    [`http://${KEY}@sentry.example.com/1`, 'https'],
    [`http://${KEY}@192.0.2.10/1`, 'https'],
    ['https://sentry.example.com/1', 'public key'],
    ['https://@sentry.example.com/1', 'public key'],
    ['https://bad key!@sentry.example.com/1', 'public key'],
    [`https://${KEY}@/1`, 'host'],
    [`https://${KEY}@sentry.example.com`, 'project'],
    [`https://${KEY}@sentry.example.com/`, 'project'],
    [`https://${KEY}@sentry.example.com/abc`, 'project'],
    [`https://${KEY}@sentry.example.com/12/`, 'project'],
    [`https://${KEY}@sentry.example.com/12?x=1`, 'query'],
    [`https://${KEY}@sentry.example.com/12#frag`, 'query'],
    [`https://${KEY}@sentry.example.com:0/12`, 'port'],
    [`https://${KEY}@sentry.example.com:70000/12`, 'port'],
    [`https://${KEY}@sentry.example.com/a b/12`, 'path'],
  ])('refuses a bad DSN with a reason: %s', (text, expected) => {
    const parsed = parseSentryDsn(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.toLowerCase()).toContain(expected.toLowerCase());
  });

  it('refuses an over-long DSN', () => {
    const parsed = parseSentryDsn(
      `https://${KEY}@sentry.example.com/${'1'.repeat(MAX_DSN_LENGTH)}`,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('too long');
  });

  it('never writes the key when a parsed DSN is turned into text', () => {
    const parsed = parseSentryDsn(`https://${KEY}@o1.ingest.sentry.io/4`);
    expect(parsed.ok && dsnDestination(parsed.value)).toBe('o1.ingest.sentry.io, project 4');
  });
});

describe('checkEnvironment', () => {
  it('accepts the usual names and an empty one (production)', () => {
    expect(checkEnvironment('staging')).toEqual({ ok: true, value: 'staging' });
    expect(checkEnvironment(' Prod.eu_1-a ')).toEqual({ ok: true, value: 'Prod.eu_1-a' });
    expect(checkEnvironment('')).toEqual({ ok: true, value: 'production' });
    expect(checkEnvironment(undefined)).toEqual({ ok: true, value: 'production' });
  });

  it.each(['pro duction', 'prod/eu', 'a'.repeat(MAX_ENVIRONMENT_LENGTH + 1)])(
    'refuses %s',
    (value) => {
      const checked = checkEnvironment(value);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toContain('Environment');
    },
  );
});

describe('checkServerName', () => {
  it('accepts a name, trims it, and an empty one means the machine name', () => {
    expect(checkServerName(' db server (eu) ')).toEqual({ ok: true, value: 'db server (eu)' });
    expect(checkServerName('')).toEqual({ ok: true, value: '' });
  });

  it.each(['line\nbreak', 'tab\tname', 'a'.repeat(MAX_SERVER_NAME_LENGTH + 1)])(
    'refuses %j',
    (value) => {
      const checked = checkServerName(value);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toContain('Server name');
    },
  );
});

describe('levels', () => {
  it('offers warnings and errors, or errors only', () => {
    expect(ERROR_REPORTING_LEVELS.map((level) => level.value)).toEqual(['warning', 'error']);
  });
});
