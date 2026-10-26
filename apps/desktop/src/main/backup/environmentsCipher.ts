import { randomBytes } from 'node:crypto';
import {
  countDotenvKeys,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  isEnvFileName,
  MAX_ENV_FILE_BYTES,
} from '@runova/core';
import type {
  SecretEnvelope,
  StoredEnvCredential,
  StoredEnvFile,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { decryptWithKey, deriveKey, encryptWithKey } from '../crypto/aesGcm';
import { decryptSecret, encryptSecret } from '../ssh/vault';
import { store } from '../store';

/**
 * Project environments in a backup. The local copies are encrypted with this computer's
 * keychain (or the vault passkey), which another computer can't read, so for a backup they are
 * decrypted and sealed again under a key from the password the user picks when exporting.
 *
 * A backup file can be copied anywhere, so the key derivation is made twice as slow as the
 * vault's to make guessing the password offline more expensive.
 */
export interface EncryptedEnvironmentsSection {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  /** How many environments are inside, so a restore can say so before asking for the password. */
  count: number;
}

const SCRYPT = { N: 32768, r: 8, p: 1 };
/** The most a hostile backup can make scrypt allocate. The default cost above needs about 33 MB. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

interface PlainEnvFile {
  id: string;
  fileName: string;
  content: string;
  updatedAt: number;
}

interface PlainEnvCredential {
  id: string;
  label: string;
  username: string;
  url: string;
  secret?: string;
  notes?: string;
  updatedAt: number;
}

interface PlainEnvironment {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  order: number;
  createdAt: number;
  updatedAt: number;
  files: PlainEnvFile[];
  credentials: PlainEnvCredential[];
}

async function openEnvelope(envelope: SecretEnvelope | undefined): Promise<string | undefined> {
  return envelope ? decryptSecret(envelope) : undefined;
}

/** Throws with the vault's own message when it is locked, so the export can show that. */
export async function sealEnvironments(password: string): Promise<EncryptedEnvironmentsSection> {
  const stored = await store.getProjectEnvironments();
  const plain: PlainEnvironment[] = await Promise.all(
    stored.map(async ({ files, credentials, ...environment }) => ({
      ...environment,
      files: await Promise.all(
        files.map(async ({ contentEnvelope, keyCount: _keyCount, ...file }) => ({
          ...file,
          content: await decryptSecret(contentEnvelope),
        })),
      ),
      credentials: await Promise.all(
        credentials.map(async ({ secretEnvelope, notesEnvelope, ...credential }) => ({
          ...credential,
          secret: await openEnvelope(secretEnvelope),
          notes: await openEnvelope(notesEnvelope),
        })),
      ),
    })),
  );

  const salt = randomBytes(16).toString('base64');
  const key = await deriveKey(password, salt, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
  const { iv, authTag, ciphertext } = encryptWithKey(JSON.stringify(plain), key);
  return { kdf: 'scrypt', ...SCRYPT, salt, iv, authTag, ciphertext, count: plain.length };
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** The section's outer shape, or null when the backup has none or it is not one we can open. */
export function readEnvironmentsSection(value: unknown): EncryptedEnvironmentsSection | null {
  if (!isRecord(value) || value.kdf !== 'scrypt') return null;
  const { N, r, p, salt, iv, authTag, ciphertext, count } = value;
  if (typeof N !== 'number' || !isPowerOfTwo(N) || N > 1 << 20) return null;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 32) return null;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (128 * N * r > SCRYPT_MAXMEM) return null;
  if (
    typeof salt !== 'string' ||
    typeof iv !== 'string' ||
    typeof authTag !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    return null;
  }
  return {
    kdf: 'scrypt',
    N,
    r,
    p,
    salt,
    iv,
    authTag,
    ciphertext,
    count: typeof count === 'number' && count >= 0 ? Math.floor(count) : 0,
  };
}

/** The decrypted rows, still unchecked, or null when the password is wrong. */
export async function unsealEnvironments(
  section: EncryptedEnvironmentsSection,
  password: string,
): Promise<unknown[] | null> {
  const key = await deriveKey(password, section.salt, {
    N: section.N,
    r: section.r,
    p: section.p,
    maxmem: SCRYPT_MAXMEM,
  });
  let json: string;
  try {
    json = decryptWithKey(
      {
        mode: 'passphrase',
        iv: section.iv,
        authTag: section.authTag,
        ciphertext: section.ciphertext,
      },
      key,
    );
  } catch {
    return null;
  }
  try {
    const rows = JSON.parse(json);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function text(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : null;
}

async function buildFile(entry: unknown): Promise<StoredEnvFile | null> {
  if (!isRecord(entry)) return null;
  const fileId = id(entry.id);
  const fileName = typeof entry.fileName === 'string' ? entry.fileName : '';
  const content = entry.content;
  if (!fileId || !isEnvFileName(fileName) || typeof content !== 'string') return null;
  if (Buffer.byteLength(content, 'utf-8') > MAX_ENV_FILE_BYTES) return null;
  return {
    id: fileId,
    fileName,
    keyCount: countDotenvKeys(content),
    contentEnvelope: await encryptSecret(content),
    updatedAt: time(entry.updatedAt),
  };
}

async function buildCredential(entry: unknown): Promise<StoredEnvCredential | null> {
  if (!isRecord(entry)) return null;
  const credentialId = id(entry.id);
  const label = text(entry.label, 120).trim();
  if (!credentialId || !label) return null;
  const secret = text(entry.secret, 64 * 1024);
  const notes = text(entry.notes, 64 * 1024);
  return {
    id: credentialId,
    label,
    username: text(entry.username),
    url: text(entry.url),
    secretEnvelope: secret ? await encryptSecret(secret) : undefined,
    notesEnvelope: notes ? await encryptSecret(notes) : undefined,
    updatedAt: time(entry.updatedAt),
  };
}

/**
 * Checks each decrypted row and encrypts its secrets for this computer. Rows for a project the
 * restore doesn't have are dropped, as are files and credentials that don't hold up.
 */
export async function toStoredEnvironments(
  rows: unknown[],
  projectIds: Set<string>,
): Promise<{ environments: StoredProjectEnvironment[]; skipped: number }> {
  const environments: StoredProjectEnvironment[] = [];
  let skipped = 0;

  for (const row of rows) {
    const environmentId = isRecord(row) ? id(row.id) : null;
    const projectId = isRecord(row) ? id(row.projectId) : null;
    const name = isRecord(row) ? text(row.name, 60).trim() : '';
    if (!isRecord(row) || !environmentId || !projectId || !projectIds.has(projectId) || !name) {
      skipped++;
      continue;
    }

    const files: StoredEnvFile[] = [];
    for (const entry of Array.isArray(row.files) ? row.files : []) {
      const file = await buildFile(entry);
      if (file && !files.some((f) => f.fileName === file.fileName)) files.push(file);
      else skipped++;
    }
    const credentials: StoredEnvCredential[] = [];
    for (const entry of Array.isArray(row.credentials) ? row.credentials : []) {
      const credential = await buildCredential(entry);
      if (credential) credentials.push(credential);
      else skipped++;
    }

    environments.push({
      id: environmentId,
      projectId,
      name,
      kind: (ENVIRONMENT_KINDS as readonly unknown[]).includes(row.kind)
        ? (row.kind as EnvironmentKind)
        : 'custom',
      order: typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : 0,
      files,
      credentials,
      createdAt: time(row.createdAt),
      updatedAt: time(row.updatedAt),
    });
  }

  return { environments, skipped };
}
