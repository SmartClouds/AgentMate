import { encodeRecaptchaError } from '../../../shared/recaptchaErrors';

/**
 * Google's error answers in words, with a code for the failures the reCAPTCHA page has a fix for.
 * Google's messages do not carry our tokens, but anything shaped like one is hidden all the same.
 */

const RECAPTCHA_SERVICE = 'recaptchaenterprise.googleapis.com';

interface ErrorInfo {
  reason?: string;
  metadata?: Record<string, string>;
}

function scrub(text: string): string {
  return text.replace(/ya29\.[\w.-]+/g, '[hidden]').replace(/1\/\/[\w-]+/g, '[hidden]');
}

function errorInfo(details: unknown): ErrorInfo | null {
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (
      typeof detail === 'object' &&
      detail !== null &&
      String((detail as Record<string, unknown>)['@type']).endsWith('google.rpc.ErrorInfo')
    ) {
      return detail as ErrorInfo;
    }
  }
  return null;
}

export function googleFailure(status: number, body: unknown): Error {
  const error =
    typeof body === 'object' && body !== null
      ? ((body as { error?: Record<string, unknown> }).error ?? null)
      : null;
  const message = typeof error?.message === 'string' ? scrub(error.message) : '';
  const info = errorInfo(error?.details);

  if (info?.reason === 'SERVICE_DISABLED' || info?.reason === 'ACCESS_NOT_CONFIGURED') {
    const service = info.metadata?.service ?? 'An API';
    if (service === RECAPTCHA_SERVICE) {
      return new Error(
        encodeRecaptchaError('api-disabled', 'reCAPTCHA is turned off in this project.'),
      );
    }
    const project = info.metadata?.consumer?.replace(/^projects\//, '');
    const where = project ? ` in Google Cloud project ${project}` : '';
    const link = info.metadata?.activationUrl
      ? ` Turn it on at ${info.metadata.activationUrl},`
      : ' Turn it on in Google Cloud,';
    return new Error(`${service} is turned off${where}.${link} then try again.`);
  }
  if (status === 401) {
    return new Error(
      encodeRecaptchaError(
        'reauth',
        'Google no longer accepts this sign-in. Sign in to Google again.',
      ),
    );
  }
  if (status === 403) {
    return new Error(
      encodeRecaptchaError(
        'permission',
        `Your Google account is not allowed to do that here${message ? ` (${message})` : ''}.`,
      ),
    );
  }
  if (status === 429) {
    return new Error(
      encodeRecaptchaError(
        'quota',
        'Google says this project has used up its quota. Wait a little, or turn on billing for more.',
      ),
    );
  }
  if (status === 404) {
    return new Error(
      encodeRecaptchaError(
        'not-found',
        message || 'Google could not find that. It may have been deleted.',
      ),
    );
  }
  if (message) return new Error(`Google refused that: ${message}`);
  return new Error(`Google answered with HTTP ${status}. Try again.`);
}

export function networkFailure(cause: unknown): Error {
  const detail = cause instanceof Error && cause.message ? ` (${scrub(cause.message)})` : '';
  return new Error(`Could not reach Google${detail}. Check the connection and try again.`);
}
