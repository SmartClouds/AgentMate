import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ENV_FILE_BYTES } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  SecretEnvelope,
  StoredEnvCredential,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { deriveKey, encryptWithKey } from '../crypto/aesGcm';
import { decryptSecret, lockVault, setPasskey } from '../ssh/vault';
import { store } from '../store';
import {
  type EncryptedEnvironmentsSection,
  readEnvironmentsSection,
  sealEnvironments,
  toStoredEnvironments,
  unsealEnvironments,
} from './environmentsCipher';

/**
 * Project environments hold .env files and logins. On this machine they are encrypted with the
 * keychain or the Servers passkey, neither of which another computer can read, so an export
 * decrypts them and seals them again under a password the user types. These tests cover both
 * halves plus the checks on the way back in, since a backup file can come from anywhere.
 */

/** scrypt at the real export cost is deliberately slow; crafted sections use this instead. */
const CHEAP = { N: 1024, r: 8, p: 1 } as const;

const userData = { dir: '' };

beforeEach(() => {
  userData.dir = tempDir('runova-envcipher-');
  mkdirSync(join(userData.dir, 'data'), { recursive: true });
  setElectronPath('userData', userData.dir);
  // The unlocked passkey lives in a module-level variable, so it has to be dropped by hand.
  lockVault();
});

/** What the fake safeStorage in the electron mock produces, which is what a local store holds. */
function localEnvelope(plaintext: string): SecretEnvelope {
  return {
    mode: 'safeStorage',
    ciphertext: Buffer.from(`enc:${plaintext}`, 'utf-8').toString('base64'),
  };
}

function writeEnvironments(rows: StoredProjectEnvironment[]): void {
  writeFileSync(
    join(userData.dir, 'data', 'project-environments.json'),
    JSON.stringify(rows),
    'utf-8',
  );
}

function environment(overrides: Partial<StoredProjectEnvironment> = {}): StoredProjectEnvironment {
  return {
    id: 'env-1',
    projectId: 'p1',
    name: 'Production',
    kind: 'production',
    order: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    files: [
      {
        id: 'f1',
        fileName: '.env.production',
        keyCount: 2,
        contentEnvelope: localEnvelope('API_KEY=abc\nDB_URL=postgres://localhost/app\n'),
        updatedAt: 1_700_000_000_002,
      },
    ],
    credentials: [
      {
        id: 'c1',
        label: 'Postgres',
        username: 'app',
        url: 'postgres://localhost/app',
        secretEnvelope: localEnvelope('s3cret'),
        notesEnvelope: localEnvelope('read replica only'),
        updatedAt: 1_700_000_000_003,
      },
    ],
    ...overrides,
  };
}

/** A section built at the cheap cost, so the password tests do not pay the export price. */
async function craftSection(
  payload: unknown,
  password: string,
  count = 1,
): Promise<EncryptedEnvironmentsSection> {
  const salt = Buffer.from('a-fixed-test-salt').toString('base64');
  const key = await deriveKey(password, salt, { ...CHEAP });
  const { iv, authTag, ciphertext } = encryptWithKey(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    key,
  );
  return { kdf: 'scrypt', ...CHEAP, salt, iv, authTag, ciphertext, count };
}

describe('sealing and unsealing', () => {
  it('round-trips the local store through a password', async () => {
    writeEnvironments([environment(), environment({ id: 'env-2', name: 'Staging' })]);

    const section = await sealEnvironments('a long backup password');
    expect(section.kdf).toBe('scrypt');
    expect(section.count).toBe(2);
    // Nothing recognizable is left in the section itself.
    expect(section.ciphertext).not.toContain('API_KEY');
    expect(Buffer.from(section.salt, 'base64')).toHaveLength(16);

    const rows = (await unsealEnvironments(section, 'a long backup password')) as {
      name: string;
      files: { content: string }[];
      credentials: { secret: string; notes: string }[];
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Production');
    expect(rows[0].files[0].content).toContain('API_KEY=abc');

    // The local-only fields are gone, replaced by the plaintext the other machine needs.
    expect(rows[0].files[0]).not.toHaveProperty('contentEnvelope');
    expect(rows[0].files[0]).not.toHaveProperty('keyCount');
    expect(rows[0].credentials[0].secret).toBe('s3cret');
    expect(rows[0].credentials[0].notes).toBe('read replica only');
  });

  it('refuses the wrong password rather than returning nonsense', async () => {
    writeEnvironments([environment()]);
    const section = await sealEnvironments('right password');
    expect(await unsealEnvironments(section, 'wrong password')).toBeNull();
    expect(await unsealEnvironments(section, '')).toBeNull();
  });

  it('seals an empty store without asking for anything', async () => {
    const section = await sealEnvironments('password');
    expect(section.count).toBe(0);
    expect(await unsealEnvironments(section, 'password')).toEqual([]);
  });

  it('leaves out a credential that had no secret or notes', async () => {
    const bare: StoredEnvCredential = {
      id: 'c2',
      label: 'Dashboard',
      username: 'admin',
      url: 'https://dash.example',
      updatedAt: 1,
    };
    writeEnvironments([environment({ credentials: [bare] })]);
    const section = await sealEnvironments('password');
    const rows = (await unsealEnvironments(section, 'password')) as {
      credentials: { secret?: string; notes?: string }[];
    }[];
    expect(rows[0].credentials[0].secret).toBeUndefined();
    expect(rows[0].credentials[0].notes).toBeUndefined();
  });

  it('survives a JSON round trip, which is how the section reaches a backup file', async () => {
    writeEnvironments([environment()]);
    const section = await sealEnvironments('password');
    const reread = readEnvironmentsSection(JSON.parse(JSON.stringify(section)));
    expect(reread).toEqual(section);
    expect(
      await unsealEnvironments(reread as EncryptedEnvironmentsSection, 'password'),
    ).toHaveLength(1);
  });

  it('fails with the vault message when the passkey is locked', async () => {
    // Local secrets under the passkey cannot be read without it, so the export has to stop and
    // say why instead of writing a backup with holes in it.
    writeFileSync(
      join(userData.dir, 'data', 'ssh-vault.json'),
      JSON.stringify({ salt: 'c2FsdA==', verifier: 'bm90LXVzZWQ=' }),
      'utf-8',
    );
    writeEnvironments([
      environment({
        files: [
          {
            id: 'f1',
            fileName: '.env',
            keyCount: 1,
            contentEnvelope: { mode: 'passphrase', iv: 'AA', authTag: 'AA', ciphertext: 'AA' },
            updatedAt: 1,
          },
        ],
        credentials: [],
      }),
    ]);

    await expect(sealEnvironments('password')).rejects.toThrow(/vault is locked/i);
  });

  it('exports secrets that were re-encrypted under a passkey', async () => {
    // The whole path: local safeStorage copies move under the passkey, and the export then has
    // to open them with the unlocked key before sealing them for the backup.
    writeEnvironments([environment()]);
    expect(await setPasskey('a servers passkey')).toEqual({ ok: true });

    const moved = await store.getProjectEnvironments();
    expect(moved[0].files[0].contentEnvelope.mode).toBe('passphrase');
    expect(moved[0].credentials[0].secretEnvelope?.mode).toBe('passphrase');

    const section = await sealEnvironments('a backup password');
    const rows = (await unsealEnvironments(section, 'a backup password')) as {
      files: { content: string }[];
    }[];
    expect(rows[0].files[0].content).toContain('API_KEY=abc');
  });
});

describe('readEnvironmentsSection', () => {
  const valid: EncryptedEnvironmentsSection = {
    kdf: 'scrypt',
    N: 32768,
    r: 8,
    p: 1,
    salt: 'c2FsdA==',
    iv: 'aXY=',
    authTag: 'dGFn',
    ciphertext: 'Y2lwaGVy',
    count: 3,
  };

  it('accepts a section this app wrote', () => {
    expect(readEnvironmentsSection({ ...valid })).toEqual(valid);
  });

  it('ignores extra keys in the section', () => {
    expect(readEnvironmentsSection({ ...valid, note: 'hello' })).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['a string', 'scrypt'],
    ['an array', [valid]],
    ['a number', 1],
  ])('refuses %s', (_label, value) => {
    expect(readEnvironmentsSection(value)).toBeNull();
  });

  it('refuses a derivation it does not implement', () => {
    expect(readEnvironmentsSection({ ...valid, kdf: 'pbkdf2' })).toBeNull();
    expect(readEnvironmentsSection({ ...valid, kdf: undefined })).toBeNull();
  });

  it.each([
    ['not a number', '32768'],
    ['not a power of two', 30000],
    ['one', 1],
    ['zero', 0],
    ['negative', -1024],
    ['fractional', 1024.5],
    ['past the cap', 1 << 21],
  ])('refuses an N that is %s', (_label, N) => {
    expect(readEnvironmentsSection({ ...valid, N })).toBeNull();
  });

  it.each([
    ['r', 0],
    ['r', 33],
    ['r', 1.5],
    ['r', '8'],
  ])('refuses %s of %s', (_key, r) => {
    expect(readEnvironmentsSection({ ...valid, r })).toBeNull();
  });

  it.each([
    ['p', 0],
    ['p', 17],
    ['p', 2.5],
    ['p', null],
  ])('refuses %s of %s', (_key, p) => {
    expect(readEnvironmentsSection({ ...valid, p })).toBeNull();
  });

  it('refuses parameters that would make scrypt allocate more than the cap', () => {
    // A hostile backup should not be able to turn an import into an out-of-memory crash.
    expect(readEnvironmentsSection({ ...valid, N: 1 << 20, r: 8 })).toBeNull();
    expect(readEnvironmentsSection({ ...valid, N: 1 << 20, r: 2 })).toBeNull();
    // Right at the limit: 128 * 65536 * 8 is 64 MB, which is allowed.
    expect(readEnvironmentsSection({ ...valid, N: 65536, r: 8 })).not.toBeNull();
  });

  it.each(['salt', 'iv', 'authTag', 'ciphertext'] as const)(
    'refuses a %s that is not a string',
    (field) => {
      expect(readEnvironmentsSection({ ...valid, [field]: 42 })).toBeNull();
      expect(readEnvironmentsSection({ ...valid, [field]: undefined })).toBeNull();
    },
  );

  it.each([
    ['missing', undefined, 0],
    ['negative', -5, 0],
    ['text', '3', 0],
    ['fractional', 3.9, 3],
  ])('reads a count that is %s as %s', (_label, count, expected) => {
    // The count is only shown to the user before the password prompt, so it is clamped
    // rather than treated as a reason to refuse the whole section.
    expect(readEnvironmentsSection({ ...valid, count })?.count).toBe(expected);
  });
});

describe('unsealEnvironments', () => {
  it('opens a section with the right password', async () => {
    const section = await craftSection([{ id: 'env-1' }], 'password');
    expect(await unsealEnvironments(section, 'password')).toEqual([{ id: 'env-1' }]);
  });

  it('returns null for the wrong password', async () => {
    const section = await craftSection([{ id: 'env-1' }], 'password');
    expect(await unsealEnvironments(section, 'Password')).toBeNull();
  });

  it('returns null for a section whose bytes were changed', async () => {
    const section = await craftSection([{ id: 'env-1' }], 'password');
    const bytes = Buffer.from(section.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(
      await unsealEnvironments({ ...section, ciphertext: bytes.toString('base64') }, 'password'),
    ).toBeNull();
  });

  it('returns null when the recorded cost no longer matches', async () => {
    // The key depends on N, so a section whose parameters were edited cannot be opened.
    const section = await craftSection([{ id: 'env-1' }], 'password');
    expect(await unsealEnvironments({ ...section, N: 2048 }, 'password')).toBeNull();
  });

  it('returns an empty list when the plaintext is not a list of rows', async () => {
    // Decryption succeeded, so the password was right; there is simply nothing to import.
    expect(await unsealEnvironments(await craftSection({ env: 1 }, 'p'), 'p')).toEqual([]);
    expect(await unsealEnvironments(await craftSection('"text"', 'p'), 'p')).toEqual([]);
    expect(await unsealEnvironments(await craftSection('null', 'p'), 'p')).toEqual([]);
  });

  it('returns an empty list when the plaintext is not JSON at all', async () => {
    expect(await unsealEnvironments(await craftSection('{ truncated', 'p'), 'p')).toEqual([]);
    expect(await unsealEnvironments(await craftSection('', 'p'), 'p')).toEqual([]);
  });
});

describe('toStoredEnvironments', () => {
  const projects = new Set(['p1', 'p2']);

  const row = {
    id: 'env-1',
    projectId: 'p1',
    name: 'Production',
    kind: 'production',
    order: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    files: [{ id: 'f1', fileName: '.env.production', content: 'A=1\nB=2\nA=3\n', updatedAt: 5 }],
    credentials: [
      {
        id: 'c1',
        label: '  Postgres  ',
        username: 'app',
        url: 'postgres://localhost/app',
        secret: 's3cret',
        notes: 'a note',
        updatedAt: 6,
      },
    ],
  };

  it('keeps a good row and encrypts its secrets for this computer', async () => {
    const { environments, skipped } = await toStoredEnvironments([row], projects);
    expect(skipped).toBe(0);
    expect(environments).toHaveLength(1);

    const stored = environments[0];
    expect(stored).toMatchObject({ id: 'env-1', projectId: 'p1', name: 'Production', order: 2 });
    expect(stored.kind).toBe('production');
    // A key set twice counts once, the way dotenv reads the file.
    expect(stored.files[0].keyCount).toBe(2);
    expect(stored.files[0].contentEnvelope.mode).toBe('safeStorage');
    expect(await decryptSecret(stored.files[0].contentEnvelope)).toBe('A=1\nB=2\nA=3\n');
    expect(stored.credentials[0].label).toBe('Postgres');
    expect(await decryptSecret(stored.credentials[0].secretEnvelope as SecretEnvelope)).toBe(
      's3cret',
    );
    expect(await decryptSecret(stored.credentials[0].notesEnvelope as SecretEnvelope)).toBe(
      'a note',
    );
  });

  it('encrypts under the passkey when one is unlocked', async () => {
    expect(await setPasskey('a servers passkey')).toEqual({ ok: true });
    const { environments } = await toStoredEnvironments([row], projects);
    expect(environments[0].files[0].contentEnvelope.mode).toBe('passphrase');
    expect(await decryptSecret(environments[0].files[0].contentEnvelope)).toBe('A=1\nB=2\nA=3\n');
  });

  it('drops a row for a project this machine does not have', async () => {
    // Restoring environments for a project that was not imported would orphan the secrets.
    const { environments, skipped } = await toStoredEnvironments(
      [{ ...row, projectId: 'p9' }],
      projects,
    );
    expect(environments).toEqual([]);
    expect(skipped).toBe(1);
  });

  it.each([
    ['not an object', 'a string'],
    ['null', null],
    ['an array', []],
    ['missing an id', { projectId: 'p1', name: 'x' }],
    ['missing a project', { id: 'e1', name: 'x' }],
    ['missing a name', { id: 'e1', projectId: 'p1' }],
    ['blank of name', { id: 'e1', projectId: 'p1', name: '   ' }],
    ['carrying an id far too long', { id: 'e'.repeat(101), projectId: 'p1', name: 'x' }],
    ['carrying an empty id', { id: '', projectId: 'p1', name: 'x' }],
  ])('drops a row that is %s', async (_label, bad) => {
    const { environments, skipped } = await toStoredEnvironments([bad], projects);
    expect(environments).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('falls back to a custom kind and a zero order', async () => {
    const { environments } = await toStoredEnvironments(
      [{ ...row, kind: 'preprod', order: 'second' }],
      projects,
    );
    expect(environments[0].kind).toBe('custom');
    expect(environments[0].order).toBe(0);
  });

  it('fills in timestamps that are not numbers', async () => {
    const before = Date.now();
    const { environments } = await toStoredEnvironments(
      [{ ...row, createdAt: '2026-01-01', updatedAt: Number.NaN }],
      projects,
    );
    expect(environments[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(environments[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('trims and caps the text fields', async () => {
    const { environments } = await toStoredEnvironments(
      [
        {
          ...row,
          name: `${'n'.repeat(80)} tail`,
          credentials: [
            {
              id: 'c1',
              label: 'L'.repeat(200),
              username: 'u'.repeat(5000),
              url: 'x'.repeat(5000),
            },
          ],
        },
      ],
      projects,
    );
    expect(environments[0].name).toHaveLength(60);
    expect(environments[0].credentials[0].label).toHaveLength(120);
    expect(environments[0].credentials[0].username).toHaveLength(2000);
    expect(environments[0].credentials[0].url).toHaveLength(2000);
  });

  it.each([
    [
      'a name that is not in the .env family',
      { id: 'f1', fileName: 'secrets.txt', content: 'A=1' },
    ],
    ['a name with a path in it', { id: 'f1', fileName: '../.env', content: 'A=1' }],
    ['a missing name', { id: 'f1', content: 'A=1' }],
    ['no id', { fileName: '.env', content: 'A=1' }],
    ['content that is not text', { id: 'f1', fileName: '.env', content: 42 }],
    ['no content at all', { id: 'f1', fileName: '.env' }],
    ['not an object', 'just a string'],
  ])('drops a file with %s', async (_label, file) => {
    // A stored file name is joined onto the project folder, so only bare .env names pass.
    const { environments, skipped } = await toStoredEnvironments(
      [{ ...row, files: [file] }],
      projects,
    );
    expect(environments[0].files).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('drops a file larger than any .env anyone keeps by hand', async () => {
    const { environments, skipped } = await toStoredEnvironments(
      [
        {
          ...row,
          files: [{ id: 'f1', fileName: '.env', content: 'x'.repeat(MAX_ENV_FILE_BYTES + 1) }],
        },
      ],
      projects,
    );
    expect(environments[0].files).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('keeps the first of two files with the same name', async () => {
    // Two .env.production files in one environment would write over each other on export.
    const { environments, skipped } = await toStoredEnvironments(
      [
        {
          ...row,
          files: [
            { id: 'f1', fileName: '.env', content: 'FIRST=1' },
            { id: 'f2', fileName: '.env', content: 'SECOND=1' },
          ],
        },
      ],
      projects,
    );
    expect(environments[0].files).toHaveLength(1);
    expect(await decryptSecret(environments[0].files[0].contentEnvelope)).toBe('FIRST=1');
    expect(skipped).toBe(1);
  });

  it.each([
    ['no label', { id: 'c1', username: 'u' }],
    ['a blank label', { id: 'c1', label: '   ' }],
    ['no id', { label: 'Postgres' }],
    ['not an object', 7],
  ])('drops a credential with %s', async (_label, credential) => {
    const { environments, skipped } = await toStoredEnvironments(
      [{ ...row, credentials: [credential] }],
      projects,
    );
    expect(environments[0].credentials).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('leaves the envelopes off a credential that carries no secret', async () => {
    const { environments, skipped } = await toStoredEnvironments(
      [{ ...row, credentials: [{ id: 'c1', label: 'Dashboard', url: 'https://dash' }] }],
      projects,
    );
    expect(skipped).toBe(0);
    expect(environments[0].credentials[0].secretEnvelope).toBeUndefined();
    expect(environments[0].credentials[0].notesEnvelope).toBeUndefined();
    expect(environments[0].credentials[0].username).toBe('');
  });

  it('treats missing file and credential lists as empty', async () => {
    const { environments, skipped } = await toStoredEnvironments(
      [{ id: 'e1', projectId: 'p2', name: 'Bare', files: 'nope', credentials: null }],
      projects,
    );
    expect(environments[0]).toMatchObject({ files: [], credentials: [] });
    expect(skipped).toBe(0);
  });

  it('reads a whole list, counting what it dropped along the way', async () => {
    const { environments, skipped } = await toStoredEnvironments(
      [row, { ...row, id: 'env-2', projectId: 'nope' }, { ...row, id: 'env-3', projectId: 'p2' }],
      projects,
    );
    expect(environments.map((one) => one.id)).toEqual(['env-1', 'env-3']);
    expect(skipped).toBe(1);
  });

  it('reads nothing from an empty list', async () => {
    expect(await toStoredEnvironments([], projects)).toEqual({ environments: [], skipped: 0 });
  });
});
