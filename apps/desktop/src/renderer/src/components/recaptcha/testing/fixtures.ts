import type { RecaptchaAccount, RecaptchaKey, RecaptchaStatus } from '@shared/deployRecaptchaTypes';

/** Shared data for the reCAPTCHA page's tests. */

export const ACCOUNT: RecaptchaAccount = {
  id: '3f2b9a8e-4c1d-4e5f-9a7b-1c2d3e4f5a6b',
  email: 'amin@example.com',
  clientMode: 'runova',
  projectId: 'shop-project',
  needsSignIn: false,
  addedAt: '2026-10-01T10:00:00.000Z',
};

export function status(overrides: Partial<RecaptchaStatus> = {}): RecaptchaStatus {
  return { runovaClient: true, locked: false, accounts: [ACCOUNT], ...overrides };
}

export const SCORE_KEY: RecaptchaKey = {
  id: '6LcScoreKey000000000000000000000000000001',
  name: 'Shop',
  type: 'score',
  domains: ['shop.com', 'www.shop.com'],
  allowAllDomains: false,
  challenge: null,
  createdAt: '2026-10-01T10:00:00Z',
};

export const CHECKBOX_KEY: RecaptchaKey = {
  id: '6LcCheckboxKey00000000000000000000000002',
  name: 'Blog comments',
  type: 'checkbox',
  domains: ['blog.com', 'a.blog.com', 'b.blog.com', 'c.blog.com', 'd.blog.com'],
  allowAllDomains: false,
  challenge: 'balance',
  createdAt: null,
};

export function ipcError(channel: string, message: string): Error {
  return new Error(`Error invoking remote method 'deployRecaptcha:${channel}': Error: ${message}`);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
