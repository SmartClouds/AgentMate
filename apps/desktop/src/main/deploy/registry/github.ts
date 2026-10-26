import {
  analyzeGithubScopes,
  GH_REFRESH_COMMAND,
  parseScopesHeader,
} from '../../../shared/deploy/registries';
import type { DeployGithubTokenCheck } from '../../../shared/deployRegistryTypes';

/**
 * GitHub tokens for the container registry (E08 T1, T2). A token is checked with one read of
 * the API as that token: GitHub answers every classic token's request with X-OAuth-Scopes, which
 * says exactly what the token can do. Fine-grained tokens answer without it, and the container
 * registry does not take them, so they are refused with the fix. The GitHub CLI's own sign-in is
 * read with `gh auth token`; it always carries repo and workflow, which is why the app warns.
 */

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

const USER_URL = 'https://api.github.com/user';
const TIMEOUT_MS = 20_000;

export class GithubTokenRejectedError extends Error {}

/** Asks GitHub who the token belongs to and what it can do. Throws when GitHub refuses it. */
export async function checkGithubToken(
  token: string,
  fetchImpl: GithubFetch = (url, init) => globalThis.fetch(url, init),
  source: 'pasted' | 'ghCli' = 'pasted',
): Promise<DeployGithubTokenCheck> {
  if (token.startsWith('github_pat_')) {
    return {
      username: null,
      scopes: [],
      canPull: false,
      broaderScopes: [],
      problem:
        "This is a fine-grained token, and GitHub's container registry only takes classic tokens. Create a classic token with just read:packages.",
    };
  }
  let response: Response;
  try {
    response = await fetchImpl(USER_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Runova',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `GitHub could not be reached to check the token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 401) {
    throw new GithubTokenRejectedError(
      'GitHub did not accept this token. It may have expired or been revoked.',
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub answered the token check with HTTP ${response.status}.`);
  }
  const header = response.headers.get('x-oauth-scopes');
  const body = (await response.json().catch(() => null)) as { login?: unknown } | null;
  const username = typeof body?.login === 'string' ? body.login : null;
  if (header === null) {
    return {
      username,
      scopes: [],
      canPull: false,
      broaderScopes: [],
      problem:
        'GitHub did not say what this token can do, which happens with fine-grained and app tokens. The container registry needs a classic token with read:packages.',
    };
  }
  const scopes = parseScopesHeader(header);
  const { canPull, broaderScopes } = analyzeGithubScopes(scopes);
  return {
    username,
    scopes,
    canPull,
    broaderScopes,
    problem: canPull
      ? null
      : source === 'ghCli'
        ? `The GitHub CLI's sign-in cannot read packages yet. Run "${GH_REFRESH_COMMAND}" in a terminal, then check again.`
        : 'This token cannot read packages. Create a new classic token with read:packages ticked.',
  };
}

export type GhRunner = (args: string[]) => Promise<{ stdout: string }>;

/** The GitHub CLI's token for github.com, or null with the reason when there is none. */
export async function readGhToken(
  run: GhRunner,
): Promise<{ token: string; problem: null } | { token: null; problem: string }> {
  try {
    const { stdout } = await run(['auth', 'token', '--hostname', 'github.com']);
    const token = stdout.trim();
    if (token.length === 0) {
      return {
        token: null,
        problem: 'The GitHub CLI is not signed in. Run "gh auth login" first.',
      };
    }
    return { token, problem: null };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      token: null,
      problem: missing
        ? 'The GitHub CLI (gh) is not installed on this computer.'
        : 'The GitHub CLI is not signed in. Run "gh auth login" first.',
    };
  }
}
