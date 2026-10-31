import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ALL_GRANTS,
  createFakeCloudflare,
  type FakeCloudflare,
} from '../src/main/deploy/cloudflare/testing/fakeCloudflare';

/**
 * The recorded Cloudflare fake the main-process tests use, served on loopback for an e2e run.
 * The app reaches it only through RUNOVA_E2E_CLOUDFLARE_API, which an unpackaged e2e build
 * alone honours. Requests are handed to the fake as if they had gone to api.cloudflare.com.
 */

/** The account token the test pastes: every permission the page and the server flows use. */
export const E2E_CLOUDFLARE_TOKEN = 'Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M';

export interface FakeCloudflareServer {
  /** Goes in RUNOVA_E2E_CLOUDFLARE_API. */
  base: string;
  fake: FakeCloudflare;
  close: () => Promise<void>;
}

export async function startFakeCloudflare(): Promise<FakeCloudflareServer> {
  const fake = createFakeCloudflare({
    tokens: {
      [E2E_CLOUDFLARE_TOKEN]: {
        grants: { ...ALL_GRANTS, sslCertificates: 'edit', apiTokens: 'edit', turnstile: 'edit' },
      },
    },
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const body = Buffer.concat(chunks).toString('utf-8');
      const answer = await fake.fetch(`https://api.cloudflare.com${request.url ?? '/'}`, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(await answer.text());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/client/v4`,
    fake,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
