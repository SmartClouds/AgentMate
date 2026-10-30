import { describe, expect, it } from 'vitest';
import { encodeRecaptchaError, recaptchaErrorCode, recaptchaErrorMessage } from './recaptchaErrors';

/** The code rides inside the message, since Electron only carries an error's message over IPC. */
describe('recaptcha error codes', () => {
  it('reads the code back out of a message Electron wrapped', () => {
    const wrapped = new Error(
      `Error invoking remote method 'deployRecaptcha:listKeys': Error: ${encodeRecaptchaError('api-disabled', 'reCAPTCHA is off in this project.')}`,
    );
    expect(recaptchaErrorCode(wrapped)).toBe('api-disabled');
    expect(recaptchaErrorMessage(wrapped)).toBe('reCAPTCHA is off in this project.');
  });

  it('has no code for a plain error, and keeps its words', () => {
    expect(recaptchaErrorCode(new Error('offline'))).toBeNull();
    expect(recaptchaErrorCode('[recaptcha:made-up] x')).toBeNull();
    expect(recaptchaErrorMessage(new Error('offline'))).toBe('offline');
  });
});
