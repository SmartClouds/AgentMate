import { randomBytes } from 'node:crypto';
import { type VaultPayload, VaultPayloadSchema } from '@runova/core';
import { decryptWithKey, encryptWithKey } from '../crypto/aesGcm';
import {
  DEFAULT_VAULT_KDF_COST,
  deriveVaultKey,
  isKdfWithinBounds,
  type KdfCost,
  newKdfParams,
  type VaultKdfParams,
} from './kdf';

export interface VaultCipherBlock {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * vault.json. The whole payload (titles and usernames included) is one encrypted block, so the
 * file shows nothing but its size. The payload key is random and wrapped by the password key,
 * which lets the password change without re-encrypting everything and leaves room for another
 * unlock method later.
 */
export interface VaultFileV1 {
  format: 'agentmate-vault'; // legacy-name, see FORMAT
  version: 1;
  kdf: VaultKdfParams;
  keyWrap: VaultCipherBlock;
  data: VaultCipherBlock;
}

export type OpenVaultResult =
  | { dataKey: Buffer; payload: VaultPayload }
  | 'wrong-password'
  | 'corrupt';

// Part of the authenticated data of every block, so it keeps the name it had when vaults were
// first written (before the app was renamed to Runova). Changing it would lock every vault.
const FORMAT = 'agentmate-vault'; // legacy-name
const DATA_KEY_BYTES = 32;

// Both blocks authenticate the header they were written under, so editing the KDF params or
// salt in the file makes it fail to open instead of silently deriving a different key.
function keyWrapAad(kdf: VaultKdfParams): Buffer {
  return Buffer.from(`${FORMAT}|1|keyWrap|${kdf.name}|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt}`);
}

function dataAad(): Buffer {
  return Buffer.from(`${FORMAT}|1|data`);
}

function block(envelope: VaultCipherBlock): VaultCipherBlock {
  return { iv: envelope.iv, authTag: envelope.authTag, ciphertext: envelope.ciphertext };
}

function isBase64Of(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return bytes === undefined || Buffer.from(value, 'base64').length === bytes;
}

function readBlock(value: unknown): VaultCipherBlock | null {
  if (!value || typeof value !== 'object') return null;
  const { iv, authTag, ciphertext } = value as Record<string, unknown>;
  // A full 16-byte tag only: GCM will happily check a truncated one, which is much weaker.
  if (!isBase64Of(iv, 12) || !isBase64Of(authTag, 16) || !isBase64Of(ciphertext)) return null;
  return { iv, authTag, ciphertext };
}

/** Structure and KDF bounds only, no crypto. Anything unexpected comes back as null. */
export function readVaultFileShape(value: unknown): VaultFileV1 | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== FORMAT || raw.version !== 1) return null;
  const kdf = raw.kdf as VaultKdfParams | undefined;
  if (!kdf || typeof kdf !== 'object' || !isKdfWithinBounds(kdf)) return null;
  const keyWrap = readBlock(raw.keyWrap);
  const data = readBlock(raw.data);
  if (!keyWrap || !data) return null;
  return {
    format: FORMAT,
    version: 1,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    keyWrap,
    data,
  };
}

export function sealVaultData(
  file: VaultFileV1,
  dataKey: Buffer,
  payload: VaultPayload,
): VaultFileV1 {
  return { ...file, data: block(encryptWithKey(JSON.stringify(payload), dataKey, dataAad())) };
}

async function wrap(
  password: string,
  cost: KdfCost,
  dataKey: Buffer,
  payload: VaultPayload,
): Promise<VaultFileV1> {
  const kdf = newKdfParams(cost);
  const passwordKey = await deriveVaultKey(password, kdf);
  try {
    const header = {
      format: FORMAT,
      version: 1,
      kdf,
      keyWrap: block(encryptWithKey(dataKey.toString('base64'), passwordKey, keyWrapAad(kdf))),
    } as const;
    return sealVaultData({ ...header, data: header.keyWrap }, dataKey, payload);
  } finally {
    passwordKey.fill(0);
  }
}

export async function createVaultFile(
  password: string,
  payload: VaultPayload,
  cost: KdfCost = DEFAULT_VAULT_KDF_COST,
): Promise<{ file: VaultFileV1; dataKey: Buffer }> {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  return { file: await wrap(password, cost, dataKey, payload), dataKey };
}

export async function openVaultFile(value: unknown, password: string): Promise<OpenVaultResult> {
  const file = readVaultFileShape(value);
  if (!file) return 'corrupt';

  const passwordKey = await deriveVaultKey(password, file.kdf);
  let dataKey: Buffer;
  try {
    // A wrong password and a damaged key block look the same to GCM. The first is far likelier.
    dataKey = Buffer.from(
      decryptWithKey(file.keyWrap, passwordKey, keyWrapAad(file.kdf)),
      'base64',
    );
  } catch {
    return 'wrong-password';
  } finally {
    passwordKey.fill(0);
  }
  if (dataKey.length !== DATA_KEY_BYTES) return 'corrupt';

  try {
    const json = decryptWithKey(file.data, dataKey, dataAad());
    const parsed = VaultPayloadSchema.safeParse(JSON.parse(json));
    if (!parsed.success) throw new Error('invalid payload');
    return { dataKey, payload: parsed.data };
  } catch {
    dataKey.fill(0);
    return 'corrupt';
  }
}

/**
 * Writes the payload under a new salt and password key. Changing the password also swaps in a
 * new data key, so an old copy of the file plus the old password can't open the new one.
 */
export async function rewrapVaultFile(
  payload: VaultPayload,
  password: string,
  cost: KdfCost,
  options: { dataKey: Buffer; rotateDataKey: boolean },
): Promise<{ file: VaultFileV1; dataKey: Buffer }> {
  const dataKey = options.rotateDataKey ? randomBytes(DATA_KEY_BYTES) : options.dataKey;
  return { file: await wrap(password, cost, dataKey, payload), dataKey };
}
