import { validatePort } from '@runova/core';
import type {
  SiteSettings,
  SiteSnippets,
  StreamProxySettings,
  UpstreamTarget,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { object } from './deploy';

/**
 * The shapes the Websites section may hand the core, checked before it hears of them: known
 * fields only, the right types, and sizes the core would never accept anyway. What a value means
 * (a domain that resolves, a port the core keeps for itself, a snippet directive) is the core's
 * to judge, and it answers with problems tied to the field.
 */

const ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BIG = 1_000_000_000;
const MAX_DOMAINS = 50;
const MAX_LIST = 200;
const MAX_SNIPPET = 64 * 1024;

export function siteId(value: unknown, what = 'site'): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

export function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say yes or no for ${what}.`);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`That is not a known ${what}.`);
  }
  return value as T;
}

export function bounded(value: unknown, max: number, what: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0)) {
    throw new Error(`The ${what} must be text of at most ${max} characters.`);
  }
  return value;
}

function count(value: unknown, what: string, min = 0, max = BIG): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`The ${what} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

function maybe<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : read(value);
}

function texts(value: unknown, max: number, length: number, what: string): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`Give at most ${max} ${what}.`);
  }
  return value.map((item) => bounded(item, length, what.replace(/s$/, '')));
}

/** The defined fields only, so the core never sees an explicit undefined. */
function defined<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

function port(value: unknown): number {
  if (typeof value !== 'number') throw new Error('A port is a whole number from 1 to 65535.');
  const checked = validatePort(value);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

function upstream(value: unknown): UpstreamTarget {
  const input = object(value, 'an upstream');
  return defined({
    kind: oneOf(input.kind, ['servicePort', 'url', 'endpoint'] as const, 'upstream kind'),
    port: maybe(input.port, port),
    address: maybe(input.address, (item) => bounded(item, 2048, 'address')),
    service: maybe(input.service, (item) => bounded(item, 63, 'service name')),
    verifyCertificate: flag(input.verifyCertificate, 'checking the upstream certificate'),
    sendUpstreamHost: flag(input.sendUpstreamHost, "sending the upstream's host name"),
  });
}

function seconds(value: unknown, what: string): number {
  return count(value, what, 0, BIG);
}

export function siteSettings(value: unknown): SiteSettings {
  const input = object(value, 'site settings');
  if (!Array.isArray(input.domains) || input.domains.length > MAX_DOMAINS) {
    throw new Error(`A site has at most ${MAX_DOMAINS} domains.`);
  }
  return defined({
    id: siteId(input.id),
    domains: texts(input.domains, MAX_DOMAINS, 253, 'domains'),
    upstream: upstream(input.upstream),
    websocket: flag(input.websocket, 'websockets'),
    gzip: flag(input.gzip, 'compression'),
    http2: flag(input.http2, 'HTTP/2'),
    redirectToHttps: flag(input.redirectToHttps, 'forcing HTTPS'),
    proxyCache: maybe(input.proxyCache, (item) => {
      const cache = object(item, 'cache settings');
      return defined({
        ttlSeconds: seconds(cache.ttlSeconds, 'cache lifetime'),
        maxSizeMegabytes: count(cache.maxSizeMegabytes, 'cache size'),
        bypassCookies: maybe(cache.bypassCookies, (list) => texts(list, 20, 64, 'cookies')),
      });
    }),
    hsts: maybe(input.hsts, (item) => {
      const hsts = object(item, 'HSTS settings');
      return {
        maxAgeSeconds: seconds(hsts.maxAgeSeconds, 'HSTS max-age'),
        includeSubdomains: flag(hsts.includeSubdomains, 'subdomains'),
        preload: flag(hsts.preload, 'preload'),
      };
    }),
    securityHeaders: maybe(input.securityHeaders, (item) => {
      const headers = object(item, 'security headers');
      return {
        noSniff: flag(headers.noSniff, 'nosniff'),
        frameOptions: oneOf(
          headers.frameOptions,
          ['off', 'deny', 'sameOrigin'] as const,
          'frame option',
        ),
        referrerPolicy: oneOf(
          headers.referrerPolicy,
          [
            'off',
            'noReferrer',
            'noReferrerWhenDowngrade',
            'origin',
            'originWhenCrossOrigin',
            'sameOrigin',
            'strictOrigin',
            'strictOriginWhenCrossOrigin',
          ] as const,
          'referrer policy',
        ),
      };
    }),
    responseHeaders: maybe(input.responseHeaders, (list) => {
      if (!Array.isArray(list) || list.length > 50) throw new Error('Give at most 50 headers.');
      return list.map((item) => {
        const header = object(item, 'a header');
        return {
          name: bounded(header.name, 64, 'header name'),
          value: bounded(header.value, 1024, 'header value', true),
        };
      });
    }),
    ipRules: maybe(input.ipRules, (item) => {
      const rules = object(item, 'IP rules');
      return {
        allow: texts(rules.allow, MAX_LIST, 64, 'addresses'),
        deny: texts(rules.deny, MAX_LIST, 64, 'addresses'),
      };
    }),
    basicAuth: maybe(input.basicAuth, (item) => {
      const auth = object(item, 'basic auth');
      if (!Array.isArray(auth.users) || auth.users.length > 50)
        throw new Error('Give at most 50 users.');
      return {
        realm: bounded(auth.realm, 128, 'realm', true),
        users: auth.users.map((entry) => {
          const user = object(entry, 'a user');
          return defined({
            name: bounded(user.name, 64, 'user name'),
            password: maybe(user.password, (secret) => bounded(secret, 1024, 'password')),
          });
        }),
      };
    }),
    rateLimit: maybe(input.rateLimit, (item) => {
      const rate = object(item, 'a rate limit');
      return {
        requests: count(rate.requests, 'request count'),
        per: oneOf(rate.per, ['second', 'minute'] as const, 'rate period'),
        burst: count(rate.burst, 'burst'),
        noDelay: flag(rate.noDelay, 'no delay'),
      };
    }),
    clientMaxBodySizeMegabytes: maybe(input.clientMaxBodySizeMegabytes, (item) =>
      count(item, 'body size'),
    ),
    timeouts: maybe(input.timeouts, (item) => {
      const timeouts = object(item, 'timeouts');
      return defined({
        connectSeconds: maybe(timeouts.connectSeconds, (n) => seconds(n, 'connect timeout')),
        readSeconds: maybe(timeouts.readSeconds, (n) => seconds(n, 'read timeout')),
        sendSeconds: maybe(timeouts.sendSeconds, (n) => seconds(n, 'send timeout')),
      });
    }),
  });
}

export function streamSettings(value: unknown): StreamProxySettings {
  const input = object(value, 'stream proxy settings');
  return defined({
    id: siteId(input.id, 'stream proxy'),
    protocol: oneOf(input.protocol, ['tcp', 'udp'] as const, 'protocol'),
    listenPort: port(input.listenPort),
    upstream: upstream(input.upstream),
    allowFrom: maybe(input.allowFrom, (list) => texts(list, MAX_LIST, 64, 'addresses')),
    connectTimeoutSeconds: maybe(input.connectTimeoutSeconds, (n) => seconds(n, 'connect timeout')),
    idleTimeoutSeconds: maybe(input.idleTimeoutSeconds, (n) => seconds(n, 'idle timeout')),
  });
}

export function snippets(value: unknown): SiteSnippets {
  const input = object(value, 'snippets');
  return defined({
    siteId: siteId(input.siteId),
    serverSnippet: maybe(input.serverSnippet, (text) =>
      bounded(text, MAX_SNIPPET, 'server snippet', true),
    ),
    locationSnippet: maybe(input.locationSnippet, (text) =>
      bounded(text, MAX_SNIPPET, 'location snippet', true),
    ),
  });
}

export function tailLines(value: unknown): number | undefined {
  return maybe(value, (n) => count(n, 'line count', 1, 2_000));
}
