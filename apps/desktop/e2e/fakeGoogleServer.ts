import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Google for the reCAPTCHA e2e run, on loopback: the OAuth consent page (which says yes at once
 * and sends the browser back to the app's loopback listener), the token endpoint, and the parts
 * of Resource Manager, Service Usage and reCAPTCHA the page uses. The app reaches it only through
 * RUNOVA_E2E_GOOGLE_API, which an unpackaged e2e build alone honours.
 */

/** The refresh token the fake hands out, so the test can prove it never lands on disk in clear. */
export const E2E_GOOGLE_REFRESH_TOKEN = 'e2e-refresh-1//0gNotARealToken';
export const E2E_GOOGLE_EMAIL = 'e2e@example.com';
export const E2E_LEGACY_SECRET = '6LcE2eSecretValue0000000000000000000000';

interface FakeKey {
  name: string;
  displayName: string;
  createTime: string;
  webSettings: Record<string, unknown>;
}

export interface FakeGoogleServer {
  /** Goes in RUNOVA_E2E_GOOGLE_API. */
  base: string;
  keys: Map<string, FakeKey[]>;
  close: () => Promise<void>;
}

function idToken(email: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ email })}.e2e`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

export async function startFakeGoogle(): Promise<FakeGoogleServer> {
  const projects = [{ projectId: 'e2e-shop-project', displayName: 'E2E Shop' }];
  const enabled = new Set<string>();
  const keys = new Map<string, FakeKey[]>();
  let next = 1;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const body = await read(request);
    const path = url.pathname;

    if (method === 'GET' && path === '/oauth/auth') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', 'e2e-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    if (method === 'POST' && path === '/oauth/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        json(response, 200, {
          access_token: 'e2e-access',
          refresh_token: E2E_GOOGLE_REFRESH_TOKEN,
          expires_in: 3600,
          id_token: idToken(E2E_GOOGLE_EMAIL),
        });
      } else {
        json(response, 200, { access_token: 'e2e-access', expires_in: 3600 });
      }
      return;
    }
    if (method === 'POST' && path === '/oauth/revoke') {
      json(response, 200, {});
      return;
    }
    if (request.headers.authorization !== 'Bearer e2e-access') {
      json(response, 401, { error: { status: 'UNAUTHENTICATED', message: 'No token' } });
      return;
    }

    if (method === 'GET' && path === '/rm/v3/projects:search') {
      json(response, 200, { projects });
      return;
    }
    if (method === 'POST' && path === '/rm/v3/projects') {
      const asked = JSON.parse(body) as { projectId: string; displayName: string };
      projects.push(asked);
      json(response, 200, { name: 'operations/cp.e2e', done: true, response: asked });
      return;
    }
    const service = path.match(
      /^\/su\/v1\/projects\/([^/]+)\/services\/recaptchaenterprise\.googleapis\.com(:enable)?$/,
    );
    if (service) {
      const project = decodeURIComponent(service[1] ?? '');
      if (service[2]) {
        enabled.add(project);
        json(response, 200, { name: 'operations/acf.e2e', done: true });
      } else {
        json(response, 200, { state: enabled.has(project) ? 'ENABLED' : 'DISABLED' });
      }
      return;
    }

    const keyPath = path.match(
      /^\/rc\/v1\/projects\/([^/]+)\/keys(?:\/([^/:]+))?(:retrieveLegacySecretKey|\/metrics)?$/,
    );
    if (keyPath) {
      const project = decodeURIComponent(keyPath[1] ?? '');
      const keyId = keyPath[2] ? decodeURIComponent(keyPath[2]) : null;
      const extra = keyPath[3];
      const list = keys.get(project) ?? [];
      keys.set(project, list);
      const found = keyId ? list.find((key) => key.name.endsWith(`/${keyId}`)) : undefined;
      if (!enabled.has(project)) {
        json(response, 403, {
          error: {
            status: 'PERMISSION_DENIED',
            message: 'reCAPTCHA Enterprise API has not been used in this project.',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'SERVICE_DISABLED',
                metadata: { service: 'recaptchaenterprise.googleapis.com' },
              },
            ],
          },
        });
        return;
      }
      if (!keyId && method === 'GET') {
        json(response, 200, { keys: list });
      } else if (!keyId && method === 'POST') {
        const asked = JSON.parse(body) as Omit<FakeKey, 'name' | 'createTime'>;
        const key: FakeKey = {
          ...asked,
          name: `projects/${project}/keys/6LcE2eKey${String(next++).padStart(4, '0')}`,
          createTime: '2026-10-30T10:00:00Z',
        };
        list.push(key);
        json(response, 200, key);
      } else if (!found) {
        json(response, 404, { error: { status: 'NOT_FOUND', message: 'No such key.' } });
      } else if (extra === ':retrieveLegacySecretKey') {
        json(response, 200, { legacySecretKey: E2E_LEGACY_SECRET });
      } else if (extra === '/metrics') {
        json(response, 200, {
          startTime: '2026-10-01T07:00:00Z',
          scoreMetrics: [{ overallMetrics: { scoreBuckets: { '90': '42' } } }],
        });
      } else if (method === 'PATCH') {
        const asked = JSON.parse(body) as Partial<FakeKey>;
        Object.assign(found, {
          displayName: asked.displayName ?? found.displayName,
          webSettings: { ...found.webSettings, ...asked.webSettings },
        });
        json(response, 200, found);
      } else if (method === 'DELETE') {
        list.splice(list.indexOf(found), 1);
        json(response, 200, {});
      } else {
        json(response, 405, { error: { message: 'Not here.' } });
      }
      return;
    }
    json(response, 404, {
      error: { status: 'NOT_FOUND', message: `No fake for ${method} ${path}` },
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    keys,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
