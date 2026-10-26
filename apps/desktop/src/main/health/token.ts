import { createHash, randomBytes } from 'node:crypto';

/**
 * The secrets a healthcheck target sends (E22). Runova makes them, shows them once, and keeps
 * them sealed with the Servers vault; the project's server stores only their SHA-256.
 */

/** A Bearer key: `rnh_` and 32 random bytes in base64url (43 characters). */
export function generateHealthToken(): string {
  return `rnh_${randomBytes(32).toString('base64url')}`;
}

/** An HTTP Basic password: 24 random bytes in base64url, 32 characters and never a colon. */
export function generateHealthPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Lowercase hex SHA-256 of the UTF-8 bytes, the form the server compares against. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
