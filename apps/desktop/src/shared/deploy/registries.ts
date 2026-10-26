/**
 * Registry names and GitHub scope rules for private registries (E08), shared by the main process
 * and the renderer. The registry rules are the server core's own (RegistryNames.cs): a registry is
 * its host and port, lowercase, and Docker Hub's names all become docker.io.
 */

export const DOCKER_HUB = 'docker.io';
export const GITHUB_REGISTRY = 'ghcr.io';
export const GITHUB_PACKAGES_SCOPE = 'read:packages';
/** gh adds a scope to its sign-in through the browser, so this runs in a terminal. */
export const GH_REFRESH_COMMAND = 'gh auth refresh -h github.com -s read:packages';
export const MAX_SECRET_LENGTH = 4096;
const MIN_SECRET_LENGTH = 4;
const MAX_USERNAME_LENGTH = 255;

const DOCKER_HUB_ALIASES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'registry.hub.docker.com',
]);
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([0-9]{1,5}))?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The registry host, or null when the text is not one. "https://" and a trailing "/" or "/v1/" are allowed. */
export function normalizeRegistry(value: string): string | null {
  if (value.length === 0 || value.length > 300 || CONTROL.test(value)) return null;
  let text = value.toLowerCase();
  if (text.startsWith('https://')) {
    text = text.slice('https://'.length);
    if (text.endsWith('/v1/')) text = text.slice(0, -'/v1/'.length);
    else if (text.endsWith('/')) text = text.slice(0, -1);
  }
  const match = HOST.exec(text);
  if (!match || text.length > 260) return null;
  if (match[1] !== undefined) {
    const port = Number(match[1]);
    if (port < 1 || port > 65535) return null;
  }
  return DOCKER_HUB_ALIASES.has(text) ? DOCKER_HUB : text;
}

/** Where an image comes from: its first part when that looks like a host, Docker Hub otherwise. */
export function registryOfImage(image: string): string {
  const slash = image.indexOf('/');
  if (slash < 0) return DOCKER_HUB;
  const first = image.slice(0, slash);
  if (!first.includes('.') && !first.includes(':') && first !== 'localhost') return DOCKER_HUB;
  return normalizeRegistry(first) ?? first.toLowerCase();
}

export function registryLabel(registry: string): string {
  if (registry === GITHUB_REGISTRY) return 'GitHub Container Registry';
  if (registry === DOCKER_HUB) return 'Docker Hub';
  return registry;
}

/** GitHub's new classic token page with only read:packages ticked. */
export function githubNewTokenUrl(): string {
  const params = new URLSearchParams({
    scopes: GITHUB_PACKAGES_SCOPE,
    description: 'Runova server pulls',
  });
  return `https://github.com/settings/tokens/new?${params.toString()}`;
}

/** X-OAuth-Scopes, "repo, workflow, read:packages", as a list. */
export function parseScopesHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Whether the scopes let a server pull packages (write:packages includes read:packages), and
 * every scope beyond read:packages: what a compromised server could do with the token.
 */
export function analyzeGithubScopes(scopes: readonly string[]): {
  canPull: boolean;
  broaderScopes: string[];
} {
  return {
    canPull: scopes.includes(GITHUB_PACKAGES_SCOPE) || scopes.includes('write:packages'),
    broaderScopes: scopes.filter((scope) => scope !== GITHUB_PACKAGES_SCOPE),
  };
}

/** What is wrong with a user name and secret, in the words the form shows, or null. */
export function registryCredentialProblem(username: string, secret: string): string | null {
  if (username.length === 0) return 'Enter the user name for the registry.';
  if (username.length > MAX_USERNAME_LENGTH) return 'That user name is too long.';
  if (username.includes(':')) return 'A registry user name cannot have a colon in it.';
  if (CONTROL.test(username) || username.trim() !== username) {
    return 'The user name has spaces or characters a registry does not accept.';
  }
  if (secret.length > MAX_SECRET_LENGTH)
    return `A token is at most ${MAX_SECRET_LENGTH} characters.`;
  if (CONTROL.test(secret)) return 'Paste the token on one line.';
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    return `A token or password has at least ${MIN_SECRET_LENGTH} characters.`;
  }
  return null;
}
