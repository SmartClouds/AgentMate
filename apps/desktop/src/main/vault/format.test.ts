import type { VaultPayload } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { deriveKey } from '../crypto/aesGcm';
import {
  createVaultFile,
  openVaultFile,
  readVaultFileShape,
  rewrapVaultFile,
  sealVaultData,
  type VaultFileV1,
} from './format';
import { DEFAULT_VAULT_KDF_COST, isKdfWithinBounds, isWeakerThan, type KdfCost } from './kdf';

/** Real scrypt, just cheap enough that the suite stays fast. */
const FAST: KdfCost = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

function payload(title = 'GitHub'): VaultPayload {
  return {
    schemaVersion: 1,
    createdAt: 1,
    entries: [
      {
        id: 'e1',
        type: 'login',
        title,
        tags: [],
        favorite: false,
        notes: '',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        username: 'octo',
        password: 'S3NT1NEL-password',
        urls: [],
        totpSecret: '',
        passwordUpdatedAt: 1,
      },
    ],
    categories: [],
  };
}

function flipByte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

vi.mock('../crypto/aesGcm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/aesGcm')>();
  return { ...actual, deriveKey: vi.fn(actual.deriveKey) };
});

describe('kdf bounds', () => {
  it('accepts the defaults and cheap test params', () => {
    expect(
      isKdfWithinBounds({ name: 'scrypt', ...DEFAULT_VAULT_KDF_COST, salt: 'x'.repeat(44) }),
    ).toBe(true);
    expect(isKdfWithinBounds({ name: 'scrypt', ...FAST, salt: 'x'.repeat(44) })).toBe(true);
  });

  it.each([
    ['N not a power of two', { N: 1000 }],
    ['N too small', { N: 512 }],
    ['N too large', { N: 2 ** 21 }],
    ['r too large', { r: 64 }],
    ['p too large', { p: 32 }],
    ['memory over the cap', { N: 2 ** 20, r: 8 }],
  ])('rejects %s', (_label, change) => {
    expect(
      isKdfWithinBounds({
        name: 'scrypt',
        ...DEFAULT_VAULT_KDF_COST,
        salt: 'x'.repeat(44),
        ...change,
      }),
    ).toBe(false);
  });

  it('rejects a missing or silly salt and unknown algorithms', () => {
    expect(isKdfWithinBounds({ name: 'scrypt', ...FAST, salt: '' })).toBe(false);
    expect(isKdfWithinBounds({ name: 'scrypt', ...FAST, salt: 'x'.repeat(1000) })).toBe(false);
    expect(isKdfWithinBounds({ name: 'argon2' as 'scrypt', ...FAST, salt: 'x'.repeat(44) })).toBe(
      false,
    );
  });

  it('compares cost', () => {
    expect(isWeakerThan(FAST, DEFAULT_VAULT_KDF_COST)).toBe(true);
    expect(isWeakerThan(DEFAULT_VAULT_KDF_COST, DEFAULT_VAULT_KDF_COST)).toBe(false);
  });
});

describe('vault file format', () => {
  it('creates a file that opens with the same password', async () => {
    const { file, dataKey } = await createVaultFile(PASSWORD, payload(), FAST);
    expect(file).toMatchObject({
      format: 'agentmate-vault' as const /* legacy-name */,
      version: 1,
      kdf: { name: 'scrypt', ...FAST },
    });
    expect(dataKey).toHaveLength(32);

    const opened = await openVaultFile(file, PASSWORD);
    if (typeof opened === 'string') throw new Error(opened);
    expect(opened.payload).toEqual(payload());
    expect(opened.dataKey.equals(dataKey)).toBe(true);
  });

  it('keeps every title, username and password out of the file text', async () => {
    const { file } = await createVaultFile(PASSWORD, payload('S3NT1NEL-title'), FAST);
    const text = JSON.stringify(file);
    expect(text).not.toContain('S3NT1NEL');
    expect(text).not.toContain('octo');
    expect(Buffer.from(text).toString('base64')).not.toContain(
      Buffer.from('S3NT1NEL').toString('base64'),
    );
  });

  it('stores the default KDF cost when none is given', async () => {
    const { file } = await createVaultFile(PASSWORD, payload());
    expect(file.kdf).toMatchObject(DEFAULT_VAULT_KDF_COST);
    expect(Buffer.from(file.kdf.salt, 'base64')).toHaveLength(32);
  });

  it('says wrong-password for a wrong password', async () => {
    const { file } = await createVaultFile(PASSWORD, payload(), FAST);
    expect(await openVaultFile(file, 'not the password')).toBe('wrong-password');
  });

  it.each(['iv', 'authTag', 'ciphertext'] as const)(
    'says corrupt when data.%s is changed',
    async (part) => {
      const { file } = await createVaultFile(PASSWORD, payload(), FAST);
      const tampered: VaultFileV1 = {
        ...file,
        data: { ...file.data, [part]: flipByte(file.data[part]) },
      };
      expect(await openVaultFile(tampered, PASSWORD)).toBe('corrupt');
    },
  );

  it('refuses to open when the KDF header or salt was edited, because they are authenticated', async () => {
    const { file } = await createVaultFile(PASSWORD, payload(), FAST);
    const otherSalt = { ...file, kdf: { ...file.kdf, salt: flipByte(file.kdf.salt) } };
    const otherCost = { ...file, kdf: { ...file.kdf, N: 2048 } };
    expect(await openVaultFile(otherSalt, PASSWORD)).toBe('wrong-password');
    expect(await openVaultFile(otherCost, PASSWORD)).toBe('wrong-password');
  });

  it('checks KDF bounds before running scrypt, so a hostile file cannot force a huge allocation', async () => {
    const spy = vi.mocked(deriveKey);
    const { file } = await createVaultFile(PASSWORD, payload(), FAST);
    spy.mockClear();
    const hostile = { ...file, kdf: { ...file.kdf, N: 2 ** 24 } };
    expect(readVaultFileShape(hostile)).toBeNull();
    expect(await openVaultFile(hostile, PASSWORD)).toBe('corrupt');
    expect(spy).not.toHaveBeenCalled();
  });

  it('says corrupt when the decrypted payload does not validate', async () => {
    const { file, dataKey } = await createVaultFile(PASSWORD, payload(), FAST);
    const bad = sealVaultData(file, dataKey, { schemaVersion: 1 } as unknown as VaultPayload);
    expect(await openVaultFile(bad, PASSWORD)).toBe('corrupt');
  });

  it('reseals data with a fresh IV under the same header', async () => {
    const { file, dataKey } = await createVaultFile(PASSWORD, payload(), FAST);
    const resealed = sealVaultData(file, dataKey, payload('GitLab'));
    expect(resealed.kdf).toEqual(file.kdf);
    expect(resealed.keyWrap).toEqual(file.keyWrap);
    expect(resealed.data.iv).not.toBe(file.data.iv);
    const opened = await openVaultFile(resealed, PASSWORD);
    if (typeof opened === 'string') throw new Error(opened);
    expect(opened.payload.entries[0].title).toBe('GitLab');
  });

  it('rewraps under a new password and rotates the data key when asked', async () => {
    const { file, dataKey } = await createVaultFile(PASSWORD, payload(), FAST);
    const opened = await openVaultFile(file, PASSWORD);
    if (typeof opened === 'string') throw new Error(opened);

    const rotated = await rewrapVaultFile(opened.payload, 'a whole new passphrase', FAST, {
      dataKey,
      rotateDataKey: true,
    });
    expect(rotated.dataKey.equals(dataKey)).toBe(false);
    expect(rotated.file.kdf.salt).not.toBe(file.kdf.salt);
    expect(await openVaultFile(rotated.file, PASSWORD)).toBe('wrong-password');
    const reopened = await openVaultFile(rotated.file, 'a whole new passphrase');
    if (typeof reopened === 'string') throw new Error(reopened);
    expect(reopened.payload).toEqual(payload());
  });

  it('can upgrade the KDF cost while keeping the data key', async () => {
    const { file, dataKey } = await createVaultFile(PASSWORD, payload(), FAST);
    const stronger: KdfCost = { N: 4096, r: 8, p: 1 };
    const upgraded = await rewrapVaultFile(payload(), PASSWORD, stronger, {
      dataKey,
      rotateDataKey: false,
    });
    expect(upgraded.dataKey.equals(dataKey)).toBe(true);
    expect(upgraded.file.kdf).toMatchObject(stronger);
    expect(upgraded.file.kdf.salt).not.toBe(file.kdf.salt);
    const opened = await openVaultFile(upgraded.file, PASSWORD);
    expect(typeof opened).not.toBe('string');
  });
});

describe('readVaultFileShape', () => {
  it.each([
    ['null', null],
    ['a string', 'vault'],
    ['an empty object', {}],
    ['the wrong format tag', { format: 'other' }],
  ])('rejects %s', (_label, value) => {
    expect(readVaultFileShape(value)).toBeNull();
  });

  it('rejects missing or non-string cipher fields and unknown versions', async () => {
    const { file } = await createVaultFile(PASSWORD, payload(), FAST);
    expect(readVaultFileShape(file)).toEqual(file);
    expect(readVaultFileShape({ ...file, version: 2 })).toBeNull();
    expect(readVaultFileShape({ ...file, data: { ...file.data, iv: 5 } })).toBeNull();
    expect(readVaultFileShape({ ...file, keyWrap: undefined })).toBeNull();
  });
});
