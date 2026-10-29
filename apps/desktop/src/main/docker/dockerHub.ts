import type { DockerHubRepository, DockerHubTag } from '../../shared/apiTypes';

/**
 * The Docker page's Hub view: the signed-in account's repositories and their tags, read from
 * Docker Hub's HTTP API with the Docker Hub sign-in Runova already keeps for deploys. The sign-in
 * is traded for a short-lived token, which is kept in memory only and never leaves Hub's host.
 */

export type DockerHubFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DockerHubSignIn {
  username: string;
  secret: string;
}

export interface DockerHubClientDeps {
  /** The saved sign-in, unsealed. Null when there is none. */
  signIn: () => Promise<DockerHubSignIn | null>;
  fetch?: DockerHubFetch;
  now?: () => number;
}

export class DockerHubSignedOutError extends Error {}
export class DockerHubRejectedError extends Error {}

const HUB = 'https://hub.docker.com';
const TIMEOUT_MS = 20_000;
/** Hub's tokens last longer than this; staying well under it means no call meets an expired one. */
const TOKEN_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 100;
/** A thousand repositories is more than one screen can use, and keeps a huge org from stalling. */
const MAX_PAGES = 10;

interface RawRepository {
  name?: unknown;
  namespace?: unknown;
  description?: unknown;
  is_private?: unknown;
  star_count?: unknown;
  pull_count?: unknown;
  last_updated?: unknown;
}

interface RawTag {
  name?: unknown;
  full_size?: unknown;
  last_updated?: unknown;
  digest?: unknown;
  images?: { os?: unknown; architecture?: unknown; variant?: unknown }[];
}

interface Page<T> {
  next?: unknown;
  results?: T[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function newestFirst<T>(items: T[], at: (item: T) => number | null): T[] {
  return [...items].sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0));
}

function toRepository(raw: RawRepository, fallbackNamespace: string): DockerHubRepository {
  return {
    namespace: text(raw.namespace) || fallbackNamespace,
    name: text(raw.name),
    description: text(raw.description),
    isPrivate: raw.is_private === true,
    starCount: count(raw.star_count),
    pullCount: count(raw.pull_count),
    lastUpdated: time(raw.last_updated),
  };
}

function platformsOf(images: RawTag['images']): string[] {
  const platforms = new Set<string>();
  for (const image of images ?? []) {
    const os = text(image.os);
    const architecture = text(image.architecture);
    // Build attestations are listed as their own "unknown/unknown" image.
    if (!os || !architecture || os === 'unknown') continue;
    const variant = text(image.variant);
    platforms.add([os, architecture, variant].filter(Boolean).join('/'));
  }
  return [...platforms];
}

function toTag(raw: RawTag): DockerHubTag {
  return {
    name: text(raw.name),
    sizeBytes: typeof raw.full_size === 'number' ? raw.full_size : null,
    lastPushed: time(raw.last_updated),
    digest: text(raw.digest) || null,
    platforms: platformsOf(raw.images),
  };
}

function statusError(status: number): Error {
  if (status === 429) {
    return new Error('Docker Hub answered with too many requests. Try again in a minute.');
  }
  return new Error(`Docker Hub answered with HTTP ${status}.`);
}

export class DockerHubClient {
  private token: { value: string; key: string; at: number } | null = null;

  constructor(private readonly deps: DockerHubClientDeps) {}

  /** The signed-in account's repositories, the most recently pushed first. */
  async repositories(): Promise<DockerHubRepository[]> {
    const signIn = await this.requireSignIn();
    const namespace = encodeURIComponent(signIn.username);
    const raw = await this.readPages<RawRepository>(
      `${HUB}/v2/namespaces/${namespace}/repositories?page_size=${PAGE_SIZE}&ordering=last_updated`,
      MAX_PAGES,
    );
    return newestFirst(
      raw.map((item) => toRepository(item, signIn.username)),
      (item) => item.lastUpdated,
    );
  }

  /** One repository's most recent tags (the first hundred), the most recently pushed first. */
  async tags(namespace: string, name: string): Promise<DockerHubTag[]> {
    const raw = await this.readPages<RawTag>(
      `${HUB}/v2/namespaces/${encodeURIComponent(namespace)}/repositories/${encodeURIComponent(name)}/tags?page_size=${PAGE_SIZE}&ordering=last_updated`,
      1,
    );
    return newestFirst(raw.map(toTag), (item) => item.lastPushed);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async requireSignIn(): Promise<DockerHubSignIn> {
    const signIn = await this.deps.signIn();
    if (!signIn)
      throw new DockerHubSignedOutError('Sign in to Docker Hub to see your repositories.');
    return signIn;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.deps.fetch ?? ((target, options) => globalThis.fetch(target, options));
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(
        `Docker Hub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.send(`${HUB}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Runova' },
      body: JSON.stringify(body),
    });
  }

  /** A token for the saved sign-in, from the cache while it is fresh and the sign-in unchanged. */
  private async bearer(): Promise<string> {
    const signIn = await this.requireSignIn();
    const key = `${signIn.username}\u0000${signIn.secret}`;
    if (this.token && this.token.key === key && this.now() - this.token.at < TOKEN_TTL_MS) {
      return this.token.value;
    }
    this.token = null;
    let response = await this.post('/v2/auth/token', {
      identifier: signIn.username,
      secret: signIn.secret,
    });
    let field = 'access_token';
    if (response.status === 404) {
      response = await this.post('/v2/users/login', {
        username: signIn.username,
        password: signIn.secret,
      });
      field = 'token';
    }
    if (response.status === 401 || response.status === 403) {
      throw new DockerHubRejectedError(
        'Docker Hub did not accept the saved sign-in. The access token may have expired or been revoked.',
      );
    }
    if (!response.ok) throw statusError(response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const value = body?.[field];
    if (typeof value !== 'string' || !value) {
      throw new Error('Docker Hub signed in but sent no token back.');
    }
    this.token = { value, key, at: this.now() };
    return value;
  }

  private async get<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.send(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${await this.bearer()}`, 'User-Agent': 'Runova' },
      });
      if (response.status === 401 && attempt === 0) {
        // Hub stopped taking the cached token early; one fresh sign-in, then give up.
        this.token = null;
        continue;
      }
      if (response.status === 401) {
        throw new DockerHubRejectedError('Docker Hub did not accept the saved sign-in.');
      }
      if (!response.ok) throw statusError(response.status);
      return (await response.json()) as T;
    }
  }

  private async readPages<T>(first: string, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = first;
    for (let page = 0; url && page < maxPages; page++) {
      const body: Page<T> = await this.get<Page<T>>(url);
      items.push(...(body.results ?? []));
      // The bearer token goes with every page, so a next link is only followed on Hub itself.
      const next = typeof body.next === 'string' ? body.next : null;
      url = next?.startsWith(`${HUB}/`) ? next : null;
    }
    return items;
  }
}
