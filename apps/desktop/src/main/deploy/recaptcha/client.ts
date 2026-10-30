import type {
  RecaptchaChallenge,
  RecaptchaKey,
  RecaptchaKeyInput,
  RecaptchaKeyType,
  RecaptchaKeyUpdate,
  RecaptchaProject,
} from '../../../shared/deployRecaptchaTypes';
import { googleFailure, networkFailure } from './errors';

/**
 * The thin REST client the reCAPTCHA page runs on (E40): Resource Manager for the user's projects,
 * Service Usage to turn the reCAPTCHA API on, and reCAPTCHA for the keys. Every call carries the
 * account's access token. reCAPTCHA calls also name the project in `x-goog-user-project`, so they
 * count against the user's project and not against the OAuth client's. Ids go into paths escaped.
 */

export interface GoogleApiBases {
  resourceManager: string;
  serviceUsage: string;
  recaptcha: string;
}

export const GOOGLE_API_BASES: GoogleApiBases = {
  resourceManager: 'https://cloudresourcemanager.googleapis.com',
  serviceUsage: 'https://serviceusage.googleapis.com',
  recaptcha: 'https://recaptchaenterprise.googleapis.com',
};

const RECAPTCHA_SERVICE = 'recaptchaenterprise.googleapis.com';
/** Operations (a new project, turning an API on) usually finish within a minute. */
const POLL_DELAYS_MS = [
  1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000, 5000, 5000, 10_000, 10_000, 10_000, 10_000,
];

export interface RecaptchaClientDeps {
  fetch: typeof fetch;
  accessToken: () => Promise<string>;
  bases?: GoogleApiBases;
  sleep?: (ms: number) => Promise<void>;
}

/** What `getMetrics` answers: daily score counts from `startTime` on. */
export interface GoogleKeyMetrics {
  startTime?: string;
  scoreMetrics?: { overallMetrics?: { scoreBuckets?: Record<string, string | number> } }[];
}

interface GoogleKey {
  name?: string;
  displayName?: string;
  createTime?: string;
  webSettings?: {
    integrationType?: string;
    allowedDomains?: string[];
    allowAllDomains?: boolean;
    challengeSecurityPreference?: string;
  };
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: Record<string, unknown>;
}

const TYPES: Record<string, RecaptchaKeyType> = {
  SCORE: 'score',
  CHECKBOX: 'checkbox',
  INVISIBLE: 'invisible',
};
const CHALLENGES: Record<string, RecaptchaChallenge> = {
  USABILITY: 'usability',
  BALANCE: 'balance',
  SECURITY: 'security',
};

const e = encodeURIComponent;

function webSettings(
  type: RecaptchaKeyType,
  domains: string[],
  challenge: RecaptchaChallenge | undefined,
): Record<string, unknown> {
  return {
    integrationType: type.toUpperCase(),
    allowedDomains: domains,
    ...(challenge && type !== 'score'
      ? { challengeSecurityPreference: challenge.toUpperCase() }
      : {}),
  };
}

function toKey(raw: GoogleKey): RecaptchaKey | null {
  const settings = raw.webSettings;
  const type = TYPES[settings?.integrationType ?? ''];
  const id = raw.name?.split('/').pop();
  if (!settings || !type || !id) return null;
  return {
    id,
    name: raw.displayName ?? id,
    type,
    domains: settings.allowedDomains ?? [],
    allowAllDomains: settings.allowAllDomains === true,
    challenge: CHALLENGES[settings.challengeSecurityPreference ?? ''] ?? null,
    createdAt: raw.createTime ?? null,
  };
}

function toProject(raw: Record<string, unknown>): RecaptchaProject | null {
  if (typeof raw.projectId !== 'string' || !raw.projectId) return null;
  const name =
    typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.projectId;
  return { projectId: raw.projectId, name };
}

export class RecaptchaClient {
  private readonly bases: GoogleApiBases;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RecaptchaClientDeps) {
    this.bases = deps.bases ?? GOOGLE_API_BASES;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Every active project the account can see, sorted by name. */
  async projects(): Promise<RecaptchaProject[]> {
    const projects: RecaptchaProject[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ query: 'state:ACTIVE', pageSize: '500' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.call<{
        projects?: Record<string, unknown>[];
        nextPageToken?: string;
      }>('GET', `${this.bases.resourceManager}/v3/projects:search?${query}`);
      for (const raw of page.projects ?? []) {
        const project = toProject(raw);
        if (project) projects.push(project);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(projectId: string, name: string): Promise<RecaptchaProject> {
    const operation = await this.call<Operation>(
      'POST',
      `${this.bases.resourceManager}/v3/projects`,
      {
        body: { projectId, displayName: name },
      },
    );
    const done = await this.wait(`${this.bases.resourceManager}/v3`, operation);
    return toProject(done.response ?? {}) ?? { projectId, name };
  }

  async apiEnabled(projectId: string): Promise<boolean> {
    const service = await this.call<{ state?: string }>(
      'GET',
      `${this.bases.serviceUsage}/v1/projects/${e(projectId)}/services/${RECAPTCHA_SERVICE}`,
    );
    return service.state === 'ENABLED';
  }

  async enableApi(projectId: string): Promise<void> {
    const operation = await this.call<Operation>(
      'POST',
      `${this.bases.serviceUsage}/v1/projects/${e(projectId)}/services/${RECAPTCHA_SERVICE}:enable`,
    );
    await this.wait(`${this.bases.serviceUsage}/v1`, operation);
  }

  /** The project's website keys; Android, iOS and other keys are left out. */
  async keys(projectId: string): Promise<RecaptchaKey[]> {
    const keys: RecaptchaKey[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.call<{ keys?: GoogleKey[]; nextPageToken?: string }>(
        'GET',
        `${this.keysUrl(projectId)}?${query}`,
        { project: projectId },
      );
      for (const raw of page.keys ?? []) {
        const key = toKey(raw);
        if (key) keys.push(key);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return keys;
  }

  async createKey(projectId: string, input: RecaptchaKeyInput): Promise<RecaptchaKey> {
    const raw = await this.call<GoogleKey>('POST', this.keysUrl(projectId), {
      project: projectId,
      body: {
        displayName: input.name,
        webSettings: webSettings(input.type, input.domains, input.challenge),
      },
    });
    return this.keyFrom(raw);
  }

  async updateKey(
    projectId: string,
    keyId: string,
    type: RecaptchaKeyType,
    update: RecaptchaKeyUpdate,
  ): Promise<RecaptchaKey> {
    const settings = webSettings(type, update.domains, update.challenge);
    const mask = ['displayName', 'webSettings.allowedDomains'];
    if ('challengeSecurityPreference' in settings)
      mask.push('webSettings.challengeSecurityPreference');
    const raw = await this.call<GoogleKey>(
      'PATCH',
      `${this.keyUrl(projectId, keyId)}?${new URLSearchParams({ updateMask: mask.join(',') })}`,
      { project: projectId, body: { displayName: update.name, webSettings: settings } },
    );
    return this.keyFrom(raw);
  }

  async deleteKey(projectId: string, keyId: string): Promise<void> {
    await this.call('DELETE', this.keyUrl(projectId, keyId), { project: projectId });
  }

  async legacySecret(projectId: string, keyId: string): Promise<string> {
    const answer = await this.call<{ legacySecretKey?: string }>(
      'GET',
      `${this.keyUrl(projectId, keyId)}:retrieveLegacySecretKey`,
      { project: projectId },
    );
    if (!answer.legacySecretKey) throw new Error('Google sent no secret for this key. Try again.');
    return answer.legacySecretKey;
  }

  metrics(projectId: string, keyId: string): Promise<GoogleKeyMetrics> {
    return this.call<GoogleKeyMetrics>('GET', `${this.keyUrl(projectId, keyId)}/metrics`, {
      project: projectId,
    });
  }

  private keysUrl(projectId: string): string {
    return `${this.bases.recaptcha}/v1/projects/${e(projectId)}/keys`;
  }

  private keyUrl(projectId: string, keyId: string): string {
    return `${this.keysUrl(projectId)}/${e(keyId)}`;
  }

  private keyFrom(raw: GoogleKey): RecaptchaKey {
    const key = toKey(raw);
    if (!key) throw new Error('Google answered with a key Runova cannot read. Reload the keys.');
    return key;
  }

  /** Polls a long-running operation under `prefix` (the API and its version) until it is done. */
  private async wait(prefix: string, first: Operation): Promise<Operation> {
    const { name } = first;
    let operation = first;
    for (const delay of POLL_DELAYS_MS) {
      if (operation.done) break;
      if (!name) throw new Error('Google started the change but gave no way to follow it. Reload.');
      await this.sleep(delay);
      operation = await this.call<Operation>('GET', `${prefix}/${name}`);
    }
    if (!operation.done) {
      throw new Error('Google is taking longer than usual. Give it a minute, then reload.');
    }
    if (operation.error) {
      throw new Error(
        `Google could not finish that: ${operation.error.message ?? 'unknown error'}`,
      );
    }
    return operation;
  }

  private async call<T>(
    method: string,
    url: string,
    options: { project?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.deps.accessToken()}`,
      accept: 'application/json',
    };
    if (options.project) headers['x-goog-user-project'] = options.project;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw networkFailure(error);
    }
    let json: unknown = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = text;
      }
    }
    if (!response.ok) throw googleFailure(response.status, json);
    return (json ?? {}) as T;
  }
}
