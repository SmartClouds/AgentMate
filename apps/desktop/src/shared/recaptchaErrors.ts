import { sshErrorMessage } from './sshErrors';

/**
 * reCAPTCHA failures the page reacts to rather than just shows, each with its own fix: the Servers
 * vault is locked, Google wants a fresh sign-in, the API is off in the project, the account lacks
 * a role, the free checks are used up, or the account or key is gone. Electron only carries an
 * error's message across IPC, so the code rides inside it, as with the Cloudflare errors.
 */
export type RecaptchaErrorCode =
  | 'locked'
  | 'reauth'
  | 'no-account'
  | 'api-disabled'
  | 'permission'
  | 'quota'
  | 'not-found';

const CODES: ReadonlySet<string> = new Set<RecaptchaErrorCode>([
  'locked',
  'reauth',
  'no-account',
  'api-disabled',
  'permission',
  'quota',
  'not-found',
]);
const TAG = /\[recaptcha:([a-z-]+)\]\s*/;

export function encodeRecaptchaError(code: RecaptchaErrorCode, message: string): string {
  return `[recaptcha:${code}] ${message}`;
}

export function recaptchaErrorCode(error: unknown): RecaptchaErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(TAG)?.[1];
  return code && CODES.has(code) ? (code as RecaptchaErrorCode) : null;
}

/** The human part of the message, without Electron's wrapper or the code tag. */
export function recaptchaErrorMessage(error: unknown): string {
  return sshErrorMessage(error).replace(TAG, '');
}
