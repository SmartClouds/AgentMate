import type { OAuthProvider } from '../oauth/loopback';
import { GOOGLE_TOKEN_URL } from './tokens';

/**
 * Signing in to Google Cloud (E40). reCAPTCHA's API takes no narrower scope than `cloud-platform`;
 * `openid email` tells the app whose account it is. `select_account` lets a person with several
 * Google accounts pick one, and `consent` makes Google hand out a refresh token every time.
 */
export const GOOGLE_CLOUD_PROVIDER: OAuthProvider = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: GOOGLE_TOKEN_URL,
  scope: 'openid email https://www.googleapis.com/auth/cloud-platform',
  extra: { access_type: 'offline', prompt: 'select_account consent' },
  label: 'Google',
};

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
