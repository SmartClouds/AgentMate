import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeployCloudDriveKind } from '../../../shared/deployServerBackupsTypes';

/**
 * Signing in to Google Drive or OneDrive for a backup destination (E28), with the user's own OAuth
 * client, so AgentMate registers nothing with either. The browser opens the provider's consent
 * page; it comes back to a listener on 127.0.0.1 at a random port (the loopback redirect both
 * allow for desktop clients), with PKCE (S256) and a random state. The code is traded for a
 * refresh token here, and the token goes straight on to the core, which seals it. The listener
 * only lives for the sign-in and answers nothing but its one callback.
 */

export interface CloudProvider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** What the provider needs on top to hand out a refresh token. */
  extra: Record<string, string>;
  label: string;
}

export const CLOUD_PROVIDERS: Record<DeployCloudDriveKind, CloudProvider> = {
  googleDrive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    extra: { access_type: 'offline', prompt: 'consent' },
    label: 'Google',
  },
  oneDrive: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Files.ReadWrite.AppFolder offline_access',
    extra: {},
    label: 'Microsoft',
  },
};

const TIMEOUT_MS = 5 * 60_000;
const CALLBACK = '/callback';

export interface LoopbackSignInDeps {
  openExternal: (url: string) => Promise<void>;
  fetch: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoopbackSignInRequest {
  kind: DeployCloudDriveKind;
  clientId: string;
  clientSecret?: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function authorizationUrl(
  kind: DeployCloudDriveKind,
  options: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const provider = CLOUD_PROVIDERS[kind];
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

/** Runs the whole sign-in and gives back the refresh token. */
export async function signInWithLoopback(
  deps: LoopbackSignInDeps,
  request: LoopbackSignInRequest,
): Promise<{ refreshToken: string }> {
  const provider = CLOUD_PROVIDERS[request.kind];
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
      answer(response, 400, 'Not this sign-in', 'Start the sign-in again from AgentMate.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? error;
      answer(response, 200, 'Sign-in stopped', 'You can close this tab and go back to AgentMate.');
      settle?.reject(new Error(`${provider.label} did not sign in: ${description}`));
      return;
    }
    const value = url.searchParams.get('code');
    if (!value) {
      answer(response, 400, 'No code', 'Start the sign-in again from AgentMate.');
      return;
    }
    answer(response, 200, 'Signed in', 'You can close this tab and go back to AgentMate.');
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
      authorizationUrl(request.kind, { clientId: request.clientId, redirectUri, state, challenge }),
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
        `${provider.label} signed in but gave no refresh token, so the server could not upload later. Check that the OAuth client is a desktop app, then try again.`,
      );
    }
    return { refreshToken: json.refresh_token };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections?.();
    server.close();
  }
}
