import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateHealthPassword, generateHealthToken, sha256Hex } from './token';

/**
 * The key or password a healthcheck target sends. The server keeps only its SHA-256, so the
 * hash here has to match what `crypto.createHash` (or any other stack) makes of the same text.
 */

describe('generateHealthToken', () => {
  it('is rnh_ followed by 32 random bytes in base64url', () => {
    const token = generateHealthToken();
    expect(token).toMatch(/^rnh_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
  });

  it('is different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateHealthToken));
    expect(tokens.size).toBe(50);
  });
});

describe('generateHealthPassword', () => {
  it('is 32 base64url characters with no prefix and no colon', () => {
    const password = generateHealthPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(password.startsWith('rnh_')).toBe(false);
  });

  it('is different every time', () => {
    const passwords = new Set(Array.from({ length: 50 }, generateHealthPassword));
    expect(passwords.size).toBe(50);
  });
});

describe('sha256Hex', () => {
  it('hashes the UTF-8 bytes to lowercase hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('héllo')).toBe(createHash('sha256').update('héllo', 'utf8').digest('hex'));
  });

  it('matches what the server computes for a generated key', () => {
    const token = generateHealthToken();
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });
});
