import { describe, expect, it } from 'vitest';
import { redactHealthText } from './redact.js';

/**
 * A health report is written by the project's own code, which is exactly where a careless error
 * handler dumps a connection string. Everything that leaves the probe goes through this, so both
 * directions matter: no secret survives, and ordinary error text stays readable.
 */

describe('redactHealthText', () => {
  it('masks the password inside a connection URL', () => {
    const text = 'connect failed: postgres://app:S3cretPass@10.0.0.5:5432/app';
    const out = redactHealthText(text);
    expect(out).not.toContain('S3cretPass');
    expect(out).toContain('postgres://app:[redacted]@10.0.0.5:5432/app');
  });

  it('masks values under secret-looking names in key=value, key: value and JSON forms', () => {
    const cases = [
      ['DB_PASSWORD=hunter22', 'hunter22'],
      ['api_key: abc123xyz', 'abc123xyz'],
      ['"clientSecret": "very-secret-value"', 'very-secret-value'],
      ["token='tkn_live_9988'", 'tkn_live_9988'],
    ];
    for (const [text, secret] of cases) {
      const out = redactHealthText(text);
      expect(out, text).not.toContain(secret);
      expect(out, text).toContain('[redacted]');
    }
  });

  it('masks bearer and basic credentials in quoted headers', () => {
    expect(redactHealthText('Authorization: Bearer amh_abcdefghijklmnop')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactHealthText('authorization: Basic dXNlcjpwYXNz')).toBe(
      'authorization: Basic [redacted]',
    );
  });

  it('masks a Runova health key wherever it appears, including ones made before the rename', () => {
    for (const prefix of ['rnh_', 'amh_']) {
      const key = `${prefix}${'Q'.repeat(43)}`;
      expect(redactHealthText(`echoed ${key} back`)).not.toContain(key);
    }
  });

  it('masks the known token shapes and private keys', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
    const out = redactHealthText(`jwt ${jwt}\n${pem}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('MIIEv');
  });

  it('masks key-value pairs in a connection string', () => {
    const out = redactHealthText(
      'Server=db;Database=app;User Id=sa;Password=P@ssw0rd!;TrustServerCertificate=True',
    );
    expect(out).not.toContain('P@ssw0rd!');
    expect(out).toContain('Server=db');
  });

  it('leaves ordinary error text alone', () => {
    const text = 'connect ECONNREFUSED 10.0.0.5:5432 after 3 retries (timeout 2000 ms)';
    expect(redactHealthText(text)).toBe(text);
    expect(redactHealthText('The key column was missing from table users')).toBe(
      'The key column was missing from table users',
    );
  });

  it('only treats whole words as secret names', () => {
    for (const text of ['Passing: redis:ping', 'tokenizer=fast', 'monkey: 3', 'https://x.io/a']) {
      expect(redactHealthText(text), text).toBe(text);
    }
    expect(redactHealthText('authToken=abc123')).toBe('authToken=[redacted]');
    expect(redactHealthText('AWS_SECRET_ACCESS_KEY=abcd1234')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]',
    );
  });

  it('masks an assignment that follows a label, such as "error: DB_PASSWORD=x"', () => {
    expect(redactHealthText('db error: DB_PASSWORD=hunter2 rejected')).toBe(
      'db error: DB_PASSWORD=[redacted] rejected',
    );
    expect(redactHealthText('Detail: password=hunter2')).toBe('Detail: password=[redacted]');
    expect(redactHealthText('url: https://x.io/a')).toBe('url: https://x.io/a');
  });

  it('masks known literal secrets passed by the caller', () => {
    expect(redactHealthText('got hunter2hunter2', ['hunter2hunter2'])).toBe('got [redacted]');
  });
});
