import { randomBytes, randomUUID } from 'node:crypto';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type {
  RecaptchaAccount,
  RecaptchaKey,
  RecaptchaKeyInput,
  RecaptchaKeyRef,
  RecaptchaKeyType,
  RecaptchaKeyUpdate,
  RecaptchaProject,
  RecaptchaProjectRef,
  RecaptchaSetupProgress,
  RecaptchaSignInInput,
  RecaptchaStatus,
  RecaptchaUsage,
} from '../../../shared/deployRecaptchaTypes';
import { encodeRecaptchaError, recaptchaErrorCode } from '../../../shared/recaptchaErrors';
import { GOOGLE_CLOUD_PROVIDER } from '../../google/provider';
import type { GoogleClient } from '../../google/runovaClient';
import type { GoogleCloudState, StoredGoogleAccount } from '../../google/state';
import type { GoogleCredentials, GoogleTokens } from '../../google/tokens';
import type { LoopbackSignInRequest, LoopbackTokens, OAuthProvider } from '../../oauth/loopback';
import type { RecaptchaClient } from './client';
import { monthAssessments } from './usage';

/**
 * The reCAPTCHA page's main-process side (E40). A Google sign-in (Runova's own OAuth client, or
 * one the user brings) is kept as a sealed refresh token per account. Every call on an account
 * unseals only what it needs, through `GoogleTokens`, and nothing that comes back out carries a
 * token, an envelope or a client secret. When Google refuses the sign-in, the account is marked so
 * the page can ask for a fresh one.
 */

export type RecaptchaApi = Pick<
  RecaptchaClient,
  | 'projects'
  | 'createProject'
  | 'apiEnabled'
  | 'enableApi'
  | 'keys'
  | 'createKey'
  | 'updateKey'
  | 'deleteKey'
  | 'legacySecret'
  | 'metrics'
>;

export interface RecaptchaServiceDeps {
  state: GoogleCloudState;
  tokens: GoogleTokens;
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  isLocked: (envelope: SecretEnvelope) => boolean;
  /** The browser sign-in (`signInWithLoopback` with its deps bound). */
  signIn: (request: LoopbackSignInRequest, signal: AbortSignal) => Promise<LoopbackTokens>;
  /** Asks Google to drop a refresh token; best effort. */
  revoke: (refreshToken: string) => Promise<void>;
  runovaClient: GoogleClient | null;
  client: (accessToken: () => Promise<string>) => RecaptchaApi;
  provider?: OAuthProvider;
  onProgress?: (progress: RecaptchaSetupProgress) => void;
  now?: () => Date;
}

const PROJECT_NAME = 'Runova reCAPTCHA';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as unknown;
    const email = (claims as { email?: unknown }).email;
    return typeof email === 'string' && email ? email : null;
  } catch {
    return null;
  }
}

function projectSuffix(): string {
  return Array.from(randomBytes(6), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

function summary(account: StoredGoogleAccount): RecaptchaAccount {
  return {
    id: account.id,
    email: account.email,
    clientMode: account.clientMode,
    projectId: account.projectId,
    needsSignIn: account.needsSignIn,
    addedAt: account.addedAt,
  };
}

export class RecaptchaService {
  private signingIn: AbortController | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: RecaptchaServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async status(): Promise<RecaptchaStatus> {
    const accounts = await this.deps.state.accounts();
    return {
      runovaClient: this.deps.runovaClient !== null,
      locked: accounts.some((account) => this.deps.isLocked(account.refreshToken)),
      accounts: accounts.map(summary),
    };
  }

  /** Opens Google's consent page and keeps the account it comes back with. */
  async signIn(input: RecaptchaSignInInput): Promise<RecaptchaAccount> {
    const client = this.clientFor(input);
    this.signingIn?.abort();
    const controller = new AbortController();
    this.signingIn = controller;
    let tokens: LoopbackTokens;
    try {
      tokens = await this.deps.signIn(
        { provider: this.deps.provider ?? GOOGLE_CLOUD_PROVIDER, ...client },
        controller.signal,
      );
    } finally {
      if (this.signingIn === controller) this.signingIn = null;
    }

    const email = emailFromIdToken(tokens.idToken) ?? 'Google account';
    const existing = (await this.deps.state.accounts()).find(
      (account) => account.email === email && account.clientId === client.clientId,
    );
    const account: StoredGoogleAccount = {
      id: existing?.id ?? randomUUID(),
      email,
      clientMode: input.mode,
      clientId: client.clientId,
      clientSecret:
        input.mode === 'own' && client.clientSecret
          ? await this.deps.seal(client.clientSecret)
          : null,
      refreshToken: await this.deps.seal(tokens.refreshToken),
      projectId: existing?.projectId ?? null,
      needsSignIn: false,
      addedAt: existing?.addedAt ?? this.now().toISOString(),
    };
    await this.deps.state.save(account);
    this.deps.tokens.forget(account.id);
    if (tokens.accessToken) {
      this.deps.tokens.remember(account.id, tokens.accessToken, tokens.expiresIn ?? 3600);
    }
    return summary(account);
  }

  cancelSignIn(): void {
    this.signingIn?.abort();
    this.signingIn = null;
  }

  /** Forgets the account here, and asks Google to drop the sign-in when it can be read. */
  async removeAccount(accountId: string): Promise<void> {
    const account = await this.deps.state.account(accountId);
    if (!account) return;
    await this.deps.state.remove(accountId);
    this.deps.tokens.forget(accountId);
    if (this.deps.isLocked(account.refreshToken)) return;
    try {
      await this.deps.revoke(await this.deps.unseal(account.refreshToken));
    } catch {
      // The sign-in is gone from this computer either way; the user can also remove it in Google.
    }
  }

  projects(accountId: string): Promise<RecaptchaProject[]> {
    return this.withAccount(accountId, (google) => google.projects());
  }

  /** A new project just for reCAPTCHA, made the account's project. */
  async createProject(accountId: string): Promise<RecaptchaProject> {
    const project = await this.withAccount(accountId, (google) =>
      google.createProject(`runova-recaptcha-${projectSuffix()}`, PROJECT_NAME),
    );
    await this.deps.state.setProject(accountId, project.projectId);
    return project;
  }

  /** Checks the project can be reached and turns reCAPTCHA on in it when it is off. */
  async prepareProject(ref: RecaptchaProjectRef): Promise<void> {
    const report = (step: RecaptchaSetupProgress['step'], state: RecaptchaSetupProgress['state']) =>
      this.deps.onProgress?.({ ...ref, step, state });
    await this.withAccount(ref.accountId, async (google) => {
      report('project', 'running');
      const enabled = await google.apiEnabled(ref.projectId);
      report('project', 'done');
      if (!enabled) {
        report('api', 'running');
        await google.enableApi(ref.projectId);
      }
      report('api', 'done');
    });
    await this.deps.state.setProject(ref.accountId, ref.projectId);
  }

  keys(ref: RecaptchaProjectRef): Promise<RecaptchaKey[]> {
    return this.withAccount(ref.accountId, (google) => google.keys(ref.projectId));
  }

  createKey(ref: RecaptchaProjectRef, input: RecaptchaKeyInput): Promise<RecaptchaKey> {
    return this.withAccount(ref.accountId, (google) => google.createKey(ref.projectId, input));
  }

  updateKey(
    ref: RecaptchaKeyRef,
    type: RecaptchaKeyType,
    update: RecaptchaKeyUpdate,
  ): Promise<RecaptchaKey> {
    return this.withAccount(ref.accountId, (google) =>
      google.updateKey(ref.projectId, ref.keyId, type, update),
    );
  }

  deleteKey(ref: RecaptchaKeyRef): Promise<void> {
    return this.withAccount(ref.accountId, (google) => google.deleteKey(ref.projectId, ref.keyId));
  }

  /** The secret for Google's classic `siteverify` check, fetched only when the user asks. */
  secret(ref: RecaptchaKeyRef): Promise<string> {
    return this.withAccount(ref.accountId, (google) =>
      google.legacySecret(ref.projectId, ref.keyId),
    );
  }

  usage(ref: RecaptchaProjectRef): Promise<RecaptchaUsage> {
    return this.withAccount(ref.accountId, async (google) => {
      const keys = await google.keys(ref.projectId);
      const metrics = await Promise.all(keys.map((key) => google.metrics(ref.projectId, key.id)));
      return monthAssessments(metrics, this.now());
    });
  }

  private clientFor(input: RecaptchaSignInInput): { clientId: string; clientSecret?: string } {
    if (input.mode === 'own') {
      return input.clientSecret
        ? { clientId: input.clientId, clientSecret: input.clientSecret }
        : { clientId: input.clientId };
    }
    if (!this.deps.runovaClient) {
      throw new Error(
        'This build of Runova has no Google sign-in of its own. Use your own OAuth client instead.',
      );
    }
    return this.deps.runovaClient;
  }

  private async credentials(account: StoredGoogleAccount): Promise<GoogleCredentials> {
    const refreshToken = await this.deps.unseal(account.refreshToken);
    if (account.clientMode === 'runova') {
      if (!this.deps.runovaClient) {
        throw new Error(
          encodeRecaptchaError(
            'reauth',
            'This sign-in used Runova Google client, which this build does not have. Sign in again with your own OAuth client.',
          ),
        );
      }
      return { ...this.deps.runovaClient, refreshToken };
    }
    return account.clientSecret
      ? {
          clientId: account.clientId,
          clientSecret: await this.deps.unseal(account.clientSecret),
          refreshToken,
        }
      : { clientId: account.clientId, refreshToken };
  }

  private async withAccount<T>(
    accountId: string,
    work: (google: RecaptchaApi) => Promise<T>,
  ): Promise<T> {
    const account = await this.deps.state.account(accountId);
    if (!account) {
      throw new Error(
        encodeRecaptchaError('no-account', 'That Google account is no longer signed in here.'),
      );
    }
    if (this.deps.isLocked(account.refreshToken)) {
      throw new Error(
        encodeRecaptchaError('locked', 'Unlock the Servers vault to use your Google sign-in.'),
      );
    }
    const google = this.deps.client(() =>
      this.deps.tokens.accessToken(account.id, () => this.credentials(account)),
    );
    try {
      return await work(google);
    } catch (error) {
      if (recaptchaErrorCode(error) === 'reauth') {
        await this.deps.state.setNeedsSignIn(account.id, true);
      }
      throw error;
    }
  }
}
