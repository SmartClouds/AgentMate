import { validateDomain, validateIpOrCidr, validatePort } from '@runova/core';
import type { SiteSettings } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { SiteDraft } from './draft';

/**
 * Turns an editor's draft into the core's `SiteSettings`, with the mistakes that can be seen
 * here (a domain that is not one, a port out of range, an address that is not an IP or a
 * network) keyed by the same field names the core uses, so its own problems land in the same
 * place. The core checks everything again.
 */

export type DraftErrors = Record<string, string>;

const ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Splits a list typed one per line or separated by commas, dropping empty entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function whole(
  value: string,
  path: string,
  errors: DraftErrors,
  options: { min?: number; label: string },
): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const min = options.min ?? 0;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < min || !Number.isSafeInteger(Number(trimmed))) {
    errors[path] = `${options.label} is a whole number${min > 0 ? ` from ${min}` : ''}.`;
    return undefined;
  }
  return Number(trimmed);
}

function required(
  value: string,
  path: string,
  errors: DraftErrors,
  options: { min?: number; label: string },
): number {
  if (value.trim() === '') errors[path] = `Enter the ${options.label.toLowerCase()}.`;
  return whole(value, path, errors, options) ?? 0;
}

function networks(value: string, path: string, errors: DraftErrors): string[] {
  const list = splitList(value);
  list.forEach((item, index) => {
    const checked = validateIpOrCidr(item);
    if (!checked.ok) errors[`${path}[${index}]`] = `${item}: ${checked.reason}`;
  });
  return list;
}

export function settingsFromDraft(draft: SiteDraft): {
  settings: SiteSettings;
  errors: DraftErrors;
} {
  const errors: DraftErrors = {};
  if (!ID.test(draft.id)) {
    errors.id =
      'Use 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.';
  }
  const domains = draft.domains.map((domain) => domain.trim()).filter((domain) => domain !== '');
  if (domains.length === 0) errors.domains = 'Add at least one domain.';
  const ascii = domains.map((domain, index) => {
    const checked = validateDomain(domain, { allowWildcard: true });
    if (!checked.ok) {
      errors[`domains[${index}]`] = checked.reason;
      return domain;
    }
    return checked.value;
  });

  let upstream: SiteSettings['upstream'];
  if (draft.upstreamKind === 'servicePort') {
    const port = validatePort(draft.port.trim());
    if (!port.ok) errors.upstream = port.reason;
    upstream = {
      kind: 'servicePort',
      ...(draft.service.trim() ? { service: draft.service.trim() } : {}),
      port: port.ok ? port.value : 0,
      verifyCertificate: draft.verifyCertificate,
      sendUpstreamHost: draft.sendUpstreamHost,
    };
  } else {
    const url = draft.url.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url))
      errors.upstream = 'Enter an http:// or https:// address.';
    upstream = {
      kind: 'url',
      address: url,
      verifyCertificate: draft.verifyCertificate,
      sendUpstreamHost: draft.sendUpstreamHost,
    };
  }

  const settings: SiteSettings = {
    id: draft.id,
    domains: ascii,
    upstream,
    websocket: draft.websocket,
    gzip: draft.gzip,
    http2: draft.http2,
    redirectToHttps: draft.redirectToHttps,
  };

  if (draft.hsts) {
    settings.hsts = {
      maxAgeSeconds: required(draft.hstsMaxAge, 'hsts', errors, { label: 'Max-age' }),
      includeSubdomains: draft.hstsSubdomains,
      preload: draft.hstsPreload,
    };
  }
  if (draft.cache) {
    const bypassCookies = splitList(draft.cacheBypass);
    settings.proxyCache = {
      ttlSeconds: required(draft.cacheTtl, 'proxyCache', errors, { min: 1, label: 'Lifetime' }),
      maxSizeMegabytes: required(draft.cacheSize, 'proxyCache', errors, { min: 1, label: 'Size' }),
      ...(bypassCookies.length > 0 ? { bypassCookies } : {}),
    };
  }
  const body = whole(draft.bodySize, 'clientMaxBodySizeMegabytes', errors, { label: 'The size' });
  if (body !== undefined) settings.clientMaxBodySizeMegabytes = body;
  const timeouts = {
    connectSeconds: whole(draft.connectTimeout, 'timeouts.connectSeconds', errors, {
      min: 1,
      label: 'A timeout',
    }),
    readSeconds: whole(draft.readTimeout, 'timeouts.readSeconds', errors, {
      min: 1,
      label: 'A timeout',
    }),
    sendSeconds: whole(draft.sendTimeout, 'timeouts.sendSeconds', errors, {
      min: 1,
      label: 'A timeout',
    }),
  };
  const setTimeouts = Object.fromEntries(
    Object.entries(timeouts).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(setTimeouts).length > 0) settings.timeouts = setTimeouts;

  if (draft.securityHeaders) {
    settings.securityHeaders = {
      noSniff: draft.noSniff,
      frameOptions: draft.frameOptions,
      referrerPolicy: draft.referrerPolicy,
    };
  }
  const headers = draft.headers.filter(
    (header) => header.name.trim() !== '' || header.value !== '',
  );
  headers.forEach((header, index) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header.name.trim())) {
      errors[`responseHeaders[${index}].name`] = 'A header name is letters, digits and hyphens.';
    }
  });
  if (headers.length > 0) {
    settings.responseHeaders = headers.map((header) => ({
      name: header.name.trim(),
      value: header.value,
    }));
  }
  const allow = networks(draft.allow, 'ipRules.allow', errors);
  const deny = networks(draft.deny, 'ipRules.deny', errors);
  if (allow.length > 0 || deny.length > 0) settings.ipRules = { allow, deny };

  if (draft.basicAuth) {
    if (draft.users.length === 0)
      errors.basicAuth = 'Add at least one user, or turn basic auth off.';
    draft.users.forEach((user, index) => {
      if (user.name.trim() === '') errors[`basicAuth.users[${index}].name`] = 'Enter a user name.';
      if (!user.saved && user.password === '') {
        errors[`basicAuth.users[${index}].password`] = 'A new user needs a password.';
      }
    });
    settings.basicAuth = {
      realm: draft.realm,
      users: draft.users.map((user) => ({
        name: user.name.trim(),
        ...(user.password ? { password: user.password } : {}),
      })),
    };
  }
  if (draft.rateLimit) {
    settings.rateLimit = {
      requests: required(draft.rateRequests, 'rateLimit', errors, { min: 1, label: 'Requests' }),
      per: draft.ratePer,
      burst: required(draft.rateBurst, 'rateLimit', errors, { label: 'Burst' }),
      noDelay: draft.rateNoDelay,
    };
  }
  return { settings, errors };
}
