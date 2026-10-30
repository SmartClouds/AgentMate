/**
 * reCAPTCHA keys on the Deploy page (E40). The app signs in to Google, picks a Google Cloud
 * project and manages that project's reCAPTCHA keys. Nothing here ever carries a Google token;
 * those stay sealed in the main process.
 */

/** How a key checks people: a score only (v3), the "I'm not a robot" box, or invisible (v2). */
export type RecaptchaKeyType = 'score' | 'checkbox' | 'invisible';

/** How hard the challenges are, for checkbox and invisible keys. */
export type RecaptchaChallenge = 'usability' | 'balance' | 'security';

/** Runova's own OAuth client, or one the user made in their Google Cloud. */
export type RecaptchaClientMode = 'runova' | 'own';

/** Google gives this many checks a month for free, across the whole Google organization. */
export const RECAPTCHA_FREE_ASSESSMENTS = 10_000;

export interface RecaptchaAccount {
  id: string;
  email: string;
  clientMode: RecaptchaClientMode;
  /** The project last used with this account, so the page opens on it. */
  projectId: string | null;
  /** Google turned the sign-in down (revoked or expired); it needs a fresh one. */
  needsSignIn: boolean;
  addedAt: string;
}

export interface RecaptchaStatus {
  /** Whether this build ships Runova's own Google client, for the one-click sign-in. */
  runovaClient: boolean;
  /** The Servers vault is locked, so the sign-ins cannot be read until it is unlocked. */
  locked: boolean;
  accounts: RecaptchaAccount[];
}

export type RecaptchaSignInInput =
  | { mode: 'runova' }
  | { mode: 'own'; clientId: string; clientSecret?: string };

export interface RecaptchaProject {
  projectId: string;
  name: string;
}

export interface RecaptchaKey {
  /** The site key, which is also the key's id in Google. */
  id: string;
  name: string;
  type: RecaptchaKeyType;
  domains: string[];
  /** Set in Google Cloud by hand; the app shows it but never turns it on. */
  allowAllDomains: boolean;
  challenge: RecaptchaChallenge | null;
  createdAt: string | null;
}

export interface RecaptchaKeyInput {
  name: string;
  type: RecaptchaKeyType;
  domains: string[];
  challenge?: RecaptchaChallenge;
}

/** A key's type cannot change; everything else can. */
export interface RecaptchaKeyUpdate {
  name: string;
  domains: string[];
  challenge?: RecaptchaChallenge;
}

export interface RecaptchaProjectRef {
  accountId: string;
  projectId: string;
}

export interface RecaptchaKeyRef extends RecaptchaProjectRef {
  keyId: string;
}

export interface RecaptchaUsage {
  /** `YYYY-MM`, the month the count covers (Pacific time, as Google counts). */
  month: string;
  /** Checks this month across the project's keys. */
  assessments: number;
}

export type RecaptchaSetupStep = 'project' | 'api';

/** Where getting a project ready has got to, sent while it runs. */
export interface RecaptchaSetupProgress {
  accountId: string;
  projectId: string;
  step: RecaptchaSetupStep;
  state: 'running' | 'done';
}
