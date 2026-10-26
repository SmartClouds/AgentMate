import type { AuthErrorCode } from './deploy/protocol/generated/Runova.ServerCore.Contracts';
import { sshErrorMessage } from './sshErrors';

/**
 * A server core's reasons for refusing a sign-in, plus the app's own: "this computer has no
 * device on that core yet", "confirm your password first" (a step-up), "your role cannot do
 * that" and "the direct TLS certificate is not the pinned one". Electron only carries an error's message across IPC, so the code rides inside it, as
 * with the SSH and Vault errors.
 */
export type CoreErrorCode =
  | AuthErrorCode
  | 'notEnrolled'
  | 'stepUpRequired'
  | 'forbidden'
  | 'tlsPinMismatch';

const CODES: ReadonlySet<string> = new Set<CoreErrorCode>([
  'challengeInvalid',
  'deviceUnknown',
  'deviceRevoked',
  'invalidCredentials',
  'lockedOut',
  'totpRequired',
  'totpInvalid',
  'sessionExpired',
  'sessionRevoked',
  'rateLimited',
  'enrollmentCodeInvalid',
  'keyInvalid',
  'notEnrolled',
  'stepUpRequired',
  'forbidden',
  'tlsPinMismatch',
]);
const CODE = /\[core:([A-Za-z]+)\]\s*/;

export function isCoreErrorCode(value: unknown): value is CoreErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

export function encodeCoreError(code: CoreErrorCode, message: string): string {
  return `[core:${code}] ${message}`;
}

export function coreErrorCode(error: unknown): CoreErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(CODE)?.[1];
  return code && CODES.has(code) ? (code as CoreErrorCode) : null;
}

/**
 * The human part of the message, without Electron's wrapper or a code tag. A core call runs over
 * SSH, so the tag can be an SSH one too.
 */
export function coreErrorMessage(error: unknown): string {
  return sshErrorMessage(error).replace(CODE, '');
}
