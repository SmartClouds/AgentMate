import { describe, expect, it } from 'vitest';
import { recaptchaErrorCode, recaptchaErrorMessage } from '../../../shared/recaptchaErrors';
import { googleFailure, networkFailure } from './errors';

/**
 * Google answers with `{ error: { code, message, status, details } }`. The page needs a code for
 * the failures it has a fix for, and plain words for the rest, never a token.
 */

function disabled(service: string, consumer = 'projects/123') {
  return {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      message: `${service} has not been used in project 123 before or it is disabled.`,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_DISABLED',
          metadata: {
            service,
            consumer,
            activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=123`,
          },
        },
      ],
    },
  };
}

describe('googleFailure', () => {
  it('turns reCAPTCHA being off in the project into api-disabled', () => {
    const error = googleFailure(403, disabled('recaptchaenterprise.googleapis.com'));
    expect(recaptchaErrorCode(error)).toBe('api-disabled');
    expect(recaptchaErrorMessage(error)).toMatch(/reCAPTCHA is turned off in this project/);
  });

  it('names another API that is off, where to turn it on, and has no code', () => {
    const error = googleFailure(403, disabled('cloudresourcemanager.googleapis.com', 'projects/9'));
    expect(recaptchaErrorCode(error)).toBeNull();
    expect(error.message).toMatch(/cloudresourcemanager\.googleapis\.com is turned off/);
    expect(error.message).toMatch(/project 9/);
    expect(error.message).toMatch(/https:\/\/console\.developers\.google\.com\/apis\/api/);
  });

  it.each([
    [401, { error: { status: 'UNAUTHENTICATED', message: 'Invalid Credentials' } }, 'reauth'],
    [
      403,
      { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
      'permission',
    ],
    [429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 'quota'],
    [404, { error: { status: 'NOT_FOUND', message: 'Key not found' } }, 'not-found'],
  ])('HTTP %i becomes %s', (status, body, code) => {
    expect(recaptchaErrorCode(googleFailure(status, body))).toBe(code);
  });

  it('keeps Google words for anything else', () => {
    const error = googleFailure(400, {
      error: { status: 'INVALID_ARGUMENT', message: 'Display name is too long.' },
    });
    expect(recaptchaErrorCode(error)).toBeNull();
    expect(error.message).toBe('Google refused that: Display name is too long.');
    expect(googleFailure(502, 'not json').message).toBe(
      'Google answered with HTTP 502. Try again.',
    );
  });

  it('never repeats a token that slipped into a message', () => {
    const error = googleFailure(400, {
      error: { message: 'bad token ya29.a0AfH6SMBx-secret and 1//0gRefresh-Token_here' },
    });
    expect(error.message).not.toContain('ya29.a0AfH6SMBx-secret');
    expect(error.message).not.toContain('1//0gRefresh-Token_here');
  });
});

describe('networkFailure', () => {
  it('says Google could not be reached', () => {
    expect(networkFailure(new TypeError('fetch failed')).message).toMatch(/Could not reach Google/);
  });
});
