import { vi } from 'vitest';
import type { SecretEnvelope } from '../../../../shared/apiTypes';
import { CloudflareService } from '../service';
import { CloudflareState, type CloudflareStatePort } from '../state';
import {
  ALL_GRANTS,
  createFakeCloudflare,
  type FakeToken,
  type FakeZoneSeed,
} from './fakeCloudflare';

/** A Cloudflare service against the fake API, with an in-memory state file and a fake vault. */

export const TOKEN = 'Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M';
export const NOW = 1_780_000_000_000;

export function memoryPort(): CloudflareStatePort & { value: unknown } {
  const port = {
    value: null as unknown,
    read: async () => port.value,
    write: async (value: unknown) => {
      port.value = JSON.parse(JSON.stringify(value));
    },
  };
  return port;
}

/** Reversible, and recognisable in assertions: the plaintext never appears in what it returns. */
export async function fakeSeal(plaintext: string): Promise<SecretEnvelope> {
  return { mode: 'safeStorage', ciphertext: Buffer.from(`sealed:${plaintext}`).toString('base64') };
}

export async function fakeUnseal(envelope: SecretEnvelope): Promise<string> {
  return Buffer.from(envelope.ciphertext, 'base64').toString('utf-8').slice('sealed:'.length);
}

export function makeService(
  options: {
    token?: FakeToken;
    tokens?: Record<string, FakeToken>;
    zones?: FakeZoneSeed[];
    widgets?: Parameters<typeof createFakeCloudflare>[0]['widgets'];
    locked?: boolean;
    unseal?: (envelope: SecretEnvelope) => Promise<string>;
  } = {},
) {
  const fake = createFakeCloudflare({
    tokens: options.tokens ?? { [TOKEN]: options.token ?? { grants: ALL_GRANTS } },
    zones: options.zones,
    widgets: options.widgets,
  });
  const port = memoryPort();
  const state = new CloudflareState(port);
  let counter = 0;
  const addresses = vi.fn(async (_serverId: string) => ({
    ipv4: ['203.0.113.10'],
    ipv6: ['2001:db8::10'],
  }));
  const seal = vi.fn(fakeSeal);
  const lock = { value: options.locked ?? false };
  const service = new CloudflareService({
    state,
    seal,
    unseal: options.unseal ?? fakeUnseal,
    isLocked: () => lock.value,
    addresses,
    fetch: fake.fetch,
    maxRetries: 0,
    now: () => NOW,
    newId: () => `acct-${(counter += 1)}`,
  });
  return { service, fake, state, port, addresses, seal, lock };
}

/** The id of the first account a harness connects. */
export const ACCOUNT = 'acct-1';

/** A service with the token already saved as one account, as after the setup step. */
export async function connectedService(options: Parameters<typeof makeService>[0] = {}) {
  const harness = makeService(options);
  await harness.service.saveToken({ token: TOKEN });
  await harness.service.listZones(ACCOUNT);
  harness.fake.requests.length = 0;
  return harness;
}
