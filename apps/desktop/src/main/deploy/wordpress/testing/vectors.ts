import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { wpCanonicalPair, wpCanonicalRequest, wpCanonicalResponse } from '@runova/core';

/**
 * The shared protocol vectors and the agent-files fixture from core, read from source so the
 * desktop tests and the plugin's PHPUnit suite look at the same bytes.
 */

const VECTORS_DIR = fileURLToPath(
  new URL('../../../../../../../packages/core/src/deploy/wordpress/vectors/', import.meta.url),
);

export interface WpVectors {
  keys: Record<'site' | 'desktop', { seedHex: string; publicKey: string }>;
  ed25519: { seedHex: string; publicKey: string; message: string; signature: string }[];
  canonicalRequest: {
    input: Parameters<typeof wpCanonicalRequest>[0];
    text: string;
    signer: 'site' | 'desktop';
    signature: string;
  }[];
  canonicalResponse: {
    input: Parameters<typeof wpCanonicalResponse>[0];
    text: string;
    signer: 'site' | 'desktop';
    signature: string;
  }[];
  pairProof: {
    input: Parameters<typeof wpCanonicalPair>[0];
    secret: string;
    text: string;
    proof: string;
  }[];
  gzip: { plainHex: string; gzipHex: string; gzipSha256: string };
  response: { envelopeHex: string; meta: { ts: number; status: number; sig: string } };
}

export interface WpAgentFilesFixture {
  item: { kind: 'theme'; slug: string };
  files: { path: string; expect: 'synced' | 'hardDenied' | 'ignoredUntracked' }[];
}

export const WP_VECTORS = JSON.parse(
  readFileSync(`${VECTORS_DIR}protocol-v1.json`, 'utf-8'),
) as WpVectors;

export const WP_AGENT_FILES = JSON.parse(
  readFileSync(`${VECTORS_DIR}agent-files.json`, 'utf-8'),
) as WpAgentFilesFixture;

export function seedBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
