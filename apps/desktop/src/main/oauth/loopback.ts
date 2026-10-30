import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Signing in with OAuth from the desktop: the browser opens the provider's consent page and comes
 * back to a listener on 127.0.0.1 at a random port (the loopback redirect providers allow for
 * desktop clients), with PKCE (S256) and a random state. The code is traded for tokens here. The
 * listener only lives for the sign-in and answers nothing but its one callback.
 */

export interface OAuthProvider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** What the provider needs on top to hand out a refresh token. */
  extra: Record<string, string>;
  label: string;
}

/** What the token endpoint gave back. Only the refresh token is sure to be there. */
export interface LoopbackTokens {
  refreshToken: string;
  accessToken?: string;
  /** Seconds the access token lasts. */
  expiresIn?: number;
  idToken?: string;
}

const TIMEOUT_MS = 5 * 60_000;
const CALLBACK = '/callback';

export interface LoopbackSignInDeps {
  openExternal: (url: string) => Promise<void>;
  fetch: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoopbackSignInRequest {
  provider: OAuthProvider;
  clientId: string;
  clientSecret?: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function authorizationUrl(
  provider: OAuthProvider,
  options: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    ...provider.extra,
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

function page(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f6f6f7;color:#222}@media (prefers-color-scheme:dark){body{background:#18181b;color:#eee}}main{max-width:28rem;text-align:center}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function answer(response: ServerResponse, status: number, title: string, text: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(page(title, text));
}

function tokensFrom(json: Record<string, unknown>): Omit<LoopbackTokens, 'refreshToken'> {
  const tokens: Omit<LoopbackTokens, 'refreshToken'> = {};
  if (typeof json.access_token === 'string' && json.access_token) {
    tokens.accessToken = json.access_token;
  }
  if (typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)) {
    tokens.expiresIn = json.expires_in;
  }
  if (typeof json.id_token === 'string' && json.id_token) tokens.idToken = json.id_token;
  return tokens;
}

/** Runs the whole sign-in and gives back the tokens. */
export async function signInWithLoopback(
  deps: LoopbackSignInDeps,
  request: LoopbackSignInRequest,
): Promise<LoopbackTokens> {
  const { provider } = request;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A refusal can land before anything awaits the code; it is still read below.
  code.catch(() => undefined);

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    if (incoming.method !== 'GET' || url.pathname !== CALLBACK) {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    // A request without this sign-in's state is not the browser coming back from it.
    if (url.searchParams.get('state') !== state) {
      answer(response, 400, 'Not this sign-in', 'Start the sign-in again from Runova.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? error;
      answer(response, 200, 'Sign-in stopped', 'You can close this tab and go back to Runova.');
      settle?.reject(new Error(`${provider.label} did not sign in: ${description}`));
      return;
    }
    const value = url.searchParams.get('code');
    if (!value) {
      answer(response, 400, 'No code', 'Start the sign-in again from Runova.');
      return;
    }
    answer(response, 200, 'Signed in', 'You can close this tab and go back to Runova.');
    settle?.resolve(value);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK}`;

  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      settle?.reject(
        new Error(
          `The ${provider.label} sign-in did not finish within ${Math.round(timeoutMs / 60_000) || 1} minutes. Try again.`,
        ),
      ),
    timeoutMs,
  );
  const onAbort = () => settle?.reject(new Error('The sign-in was cancelled.'));
  if (deps.signal?.aborted) onAbort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await deps.openExternal(
      authorizationUrl(provider, { clientId: request.clientId, redirectUri, state, challenge }),
    );
    const received = await code;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: received,
      redirect_uri: redirectUri,
      client_id: request.clientId,
      code_verifier: verifier,
      ...(request.clientSecret ? { client_secret: request.clientSecret } : {}),
    });
    const response = await deps.fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      // The status below says enough.
    }
    if (!response.ok) {
      const reason =
        typeof json.error_description === 'string'
          ? json.error_description
          : typeof json.error === 'string'
            ? json.error
            : `HTTP ${response.status}`;
      throw new Error(`${provider.label} refused the sign-in: ${reason}`);
    }
    if (typeof json.refresh_token !== 'string' || json.refresh_token.length === 0) {
      throw new Error(
        `${provider.label} signed in but gave no refresh token, so Runova could not keep the sign-in. Check that the OAuth client is a desktop app, then try again.`,
      );
    }
    return { refreshToken: json.refresh_token, ...tokensFrom(json) };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections?.();
    server.close();
  }
}
