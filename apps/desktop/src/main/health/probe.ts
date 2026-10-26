import {
  HEALTH_MEDIA_TYPE,
  type HealthReport,
  parseHealthResponse,
  probeFailureReport,
  redactHealthText,
} from '@runova/core';
import type { HealthTargetInput } from '../../shared/healthTypes';

/**
 * One probe of a healthcheck endpoint (E22). The key is sent only to the address the user saved:
 * redirects are never followed, plain http goes nowhere but this computer unless the target
 * allows it, and the body is read up to a cap so a runaway endpoint cannot fill memory.
 *
 * The transport is injected. The app uses Electron's net.fetch, which honours the system proxy
 * and certificate store (see main/deploy/wordpress/transport.ts for how it behaves); the tests
 * use Node's fetch against a local server. Nothing here logs, and every string that leaves goes
 * through the core parser or `probeFailureReport`, both of which redact.
 */

export type HealthTransport = (url: string, init: RequestInit) => Promise<Response>;

export type HealthProbeTarget = Pick<
  HealthTargetInput,
  'url' | 'timeoutSec' | 'authMode' | 'basicUser' | 'allowInsecure'
>;

export interface HealthProbeDeps {
  transport: HealthTransport;
  now?: () => number;
}

export const HEALTH_MAX_BODY_BYTES = 512 * 1024;

const TOO_LARGE = 'The response is larger than 512 KB, so Runova stopped reading it.';
const REDIRECTED =
  'The endpoint answered with a redirect. Runova does not follow redirects, so its credentials are never sent to another address. Use the final URL.';

const NODE_TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

class TooLargeError extends Error {}

/** localhost, 127.0.0.0/8 and ::1: plain http there never crosses a network. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function authorization(target: HealthProbeTarget, secret: string): string {
  if (target.authMode === 'basic') {
    return `Basic ${Buffer.from(`${target.basicUser ?? ''}:${secret}`, 'utf-8').toString('base64')}`;
  }
  return `Bearer ${secret}`;
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > HEALTH_MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TooLargeError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > HEALTH_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf-8');
}

/** Every `code` and message along an error's `cause` chain, since fetch nests the useful one. */
function describeError(error: unknown): { codes: string[]; text: string; name: string } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object') {
      const { code, message } = current as { code?: unknown; message?: unknown };
      if (typeof code === 'string') codes.push(code);
      if (typeof message === 'string') messages.push(message);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      current = null;
    }
  }
  // An abort's DOMException is not an Error in every runtime, so the name is read off any object.
  const name = (error as { name?: unknown } | null)?.name;
  return { codes, text: messages.join(' '), name: typeof name === 'string' ? name : '' };
}

function networkProblem(error: unknown, target: HealthProbeTarget, host: string): string {
  const { codes, text, name } = describeError(error);
  const has = (...wanted: string[]) =>
    wanted.some((code) => codes.includes(code) || text.includes(code));

  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Timed out after ${target.timeoutSec} s.`;
  }
  if (/redirect/i.test(text)) return REDIRECTED;
  if (/ERR_CERT_|ERR_SSL_/.test(text) || codes.some((code) => NODE_TLS_CODES.has(code))) {
    const code = text.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? codes.find((c) => NODE_TLS_CODES.has(c));
    return `This computer does not trust the TLS certificate of ${host}${code ? ` (${code})` : ''}. It may be self-signed, expired or for another name.`;
  }
  if (has('ECONNREFUSED', 'ERR_CONNECTION_REFUSED')) {
    return `The connection to ${host} was refused. Nothing is listening there, or a firewall blocks it.`;
  }
  if (has('ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED')) {
    return `The host name of ${host} could not be resolved. Check the address and this computer's DNS.`;
  }
  if (has('ECONNRESET', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'UND_ERR_SOCKET')) {
    return `The connection to ${host} was reset before it answered.`;
  }
  if (has('ETIMEDOUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'UND_ERR_CONNECT_TIMEOUT')) {
    return `The connection to ${host} timed out.`;
  }
  const detail = text.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? codes[0] ?? text;
  return `Could not reach ${host}${detail ? ` (${detail})` : ''}.`;
}

export async function probeHealthTarget(
  target: HealthProbeTarget,
  secret: string,
  deps: HealthProbeDeps,
): Promise<HealthReport> {
  const checkedAt = (deps.now ?? Date.now)();
  const fail = (problem: string, state: 'unreachable' | 'invalid' = 'unreachable') =>
    probeFailureReport(redactHealthText(problem, [secret]), checkedAt, state);

  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return fail('The address is not a valid URL.', 'invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail('The address must start with https://.', 'invalid');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !target.allowInsecure) {
    return fail(
      'Plain http:// would send the key unencrypted, so Runova only uses it for this computer. Use https://, or allow insecure HTTP for this target.',
      'invalid',
    );
  }

  const started = performance.now();
  try {
    const response = await deps.transport(url.href, {
      method: 'GET',
      headers: {
        Authorization: authorization(target, secret),
        Accept: HEALTH_MEDIA_TYPE,
        'User-Agent': 'Runova-Health/1',
        'Cache-Control': 'no-cache',
      },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(target.timeoutSec * 1000),
    });
    if (response.type === 'opaqueredirect' || response.status === 0) {
      await response.body?.cancel().catch(() => undefined);
      return fail(REDIRECTED, 'invalid');
    }
    const body = await readCapped(response);
    return parseHealthResponse({
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      body,
      latencyMs: Math.round(performance.now() - started),
      checkedAt,
      knownSecrets: [secret],
    });
  } catch (error) {
    if (error instanceof TooLargeError) return fail(TOO_LARGE, 'invalid');
    const problem = networkProblem(error, target, url.host);
    return fail(problem, problem === REDIRECTED ? 'invalid' : 'unreachable');
  }
}
