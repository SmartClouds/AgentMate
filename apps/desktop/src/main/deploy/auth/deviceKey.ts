import { generateKeyPairSync, sign } from 'node:crypto';
import type { AuthPurpose } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { RUNOVA_CORE } from '../coreLayout';

/**
 * The key a desktop proves itself with to a server core, one per server: ECDSA P-256. The public
 * half goes to the core as SubjectPublicKeyInfo (base64 DER); the private half never leaves this
 * machine and is kept sealed with the Servers vault.
 */

export interface DeviceKeyPair {
  /** SubjectPublicKeyInfo, DER, base64. */
  publicKey: string;
  /** PKCS#8 PEM. Seal it before it goes anywhere near a file. */
  privateKeyPem: string;
}

export function createDeviceKey(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** SHA-256 ECDSA in IEEE P1363 form (r || s, 64 bytes), base64. */
export function signMessage(privateKeyPem: string, message: string): string {
  return sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
}

/**
 * The exact text the core verifies (its AuthMessage): every field that decides what a signature
 * is good for, so a signature for one purpose, challenge, device or session is useless for another.
 * `prefix` is the layout's: a core from before the rename only takes the old one.
 */
export function authMessage(
  purpose: AuthPurpose,
  challengeId: string,
  nonce: string,
  deviceId: string,
  sessionId: string | null,
  prefix: string = RUNOVA_CORE.authPrefix,
): string {
  return [prefix, purpose, challengeId, nonce, deviceId, sessionId ?? '-'].join('\n');
}
