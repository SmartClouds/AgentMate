import { BROWSER_CACHE_TTLS } from '../../../../shared/cloudflare/zone';
import type {
  CloudflareAnyPermissionId,
  CloudflarePermissionId,
} from '../../../../shared/cloudflareTypes';
import * as recorded from './recorded';

/**
 * A stand-in for Cloudflare's API v4, handed to the official SDK as its `fetch`. It answers with
 * the recorded payloads in recorded.ts, keeps what tests create, change and delete, and refuses a
 * route the way Cloudflare does when the token lacks the permission for it (403, code 10000). So
 * the SDK's own request building, paging and error classes all run for real; only the network is
 * replaced. Every request is kept for assertions, the Authorization header included.
 */

type Access = 'read' | 'edit';
type Json = Record<string, unknown>;

export interface FakeToken {
  id?: string;
  status?: 'active' | 'disabled' | 'expired';
  grants: Partial<Record<CloudflareAnyPermissionId, Access>>;
  /** Has User > API Tokens > Read, so it may read its own policies. */
  canReadSelf?: boolean;
  /** Limited to these zones, as a zone-scoped token is; every zone when left out. */
  zoneIds?: string[];
}

/** Everything Runova's token template asks for. */
export const ALL_GRANTS: Record<CloudflarePermissionId, Access> = {
  zone: 'read',
  dns: 'edit',
  zoneSettings: 'edit',
  cachePurge: 'edit',
  waf: 'edit',
  accessRules: 'edit',
};

export interface FakeZoneSeed {
  id: string;
  name: string;
  records?: Json[];
  /** The custom rules entry point; null when the zone has no custom rules yet. */
  ruleset?: Json | null;
  accessRules?: Json[];
}

export interface FakeZoneState {
  zone: Json;
  records: Json[];
  settings: Record<string, Json>;
  ruleset: Json | null;
  accessRules: Json[];
  purges: Json[];
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export interface FakeCloudflare {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Every token Cloudflare knows, those the app made included (keyed by value). */
  tokens: Record<string, FakeToken>;
  requests: FakeRequest[];
  zones: Map<string, FakeZoneState>;
  /** The requests that could change something: everything but GET. */
  writes: () => FakeRequest[];
  /** Answers the next request whose path matches with this status and body, once. */
  failNext: (path: RegExp, status: number, body?: unknown) => void;
}

const API_PREFIX = '/client/v4';
const PERMISSION_NAMES: Record<CloudflareAnyPermissionId, Record<Access, string>> = {
  zone: { read: 'Zone Read', edit: 'Zone Write' },
  dns: { read: 'DNS Read', edit: 'DNS Write' },
  zoneSettings: { read: 'Zone Settings Read', edit: 'Zone Settings Write' },
  cachePurge: { read: 'Cache Purge', edit: 'Cache Purge' },
  waf: { read: 'Zone WAF Read', edit: 'Zone WAF Write' },
  accessRules: { read: 'Firewall Services Read', edit: 'Firewall Services Write' },
  sslCertificates: { read: 'SSL and Certificates Read', edit: 'SSL and Certificates Write' },
  apiTokens: { read: 'API Tokens Read', edit: 'API Tokens Write' },
};
const SETTING_VALUES: Record<string, readonly string[]> = {
  development_mode: ['on', 'off'],
  security_level: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
  ssl: ['off', 'flexible', 'full', 'strict'],
  always_use_https: ['on', 'off'],
  tls_client_auth: ['on', 'off'],
  automatic_https_rewrites: ['on', 'off'],
  min_tls_version: ['1.0', '1.1', '1.2', '1.3'],
  tls_1_3: ['on', 'off', 'zrt'],
  cache_level: ['bypass', 'basic', 'simplified', 'aggressive', 'cache_everything'],
  browser_cache_ttl: BROWSER_CACHE_TTLS.map(String),
};
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

function copy<T>(value: T): T {
  return structuredClone(value);
}

function ok(result: unknown, resultInfo?: Json): { status: number; body: Json } {
  return {
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo ? { result_info: resultInfo } : {}),
    },
  };
}

function fail(status: number, code: number, message: string): { status: number; body: Json } {
  return {
    status,
    body: { success: false, errors: [{ code, message }], messages: [], result: null },
  };
}

function page(items: Json[], query: URLSearchParams, defaultPerPage: number) {
  const perPage = Number(query.get('per_page') ?? defaultPerPage);
  const pageNumber = Number(query.get('page') ?? 1);
  const slice = items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
  return ok(slice, {
    page: pageNumber,
    per_page: perPage,
    count: slice.length,
    total_count: items.length,
    total_pages: Math.max(1, Math.ceil(items.length / perPage)),
  });
}

export function createFakeCloudflare(options: {
  tokens: Record<string, FakeToken>;
  zones?: FakeZoneSeed[];
}): FakeCloudflare {
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return counter.toString(16).padStart(32, 'a');
  };

  const zones = new Map<string, FakeZoneState>();
  for (const seed of options.zones ?? [{ id: recorded.ZONE_ID, name: 'example.com' }]) {
    zones.set(seed.id, {
      zone: { ...copy(recorded.zone), id: seed.id, name: seed.name },
      records: copy(seed.records ?? []),
      settings: copy(recorded.settings) as Record<string, Json>,
      ruleset: seed.ruleset === undefined ? null : copy(seed.ruleset),
      accessRules: copy(seed.accessRules ?? []),
      purges: [],
    });
  }

  const requests: FakeRequest[] = [];
  const failures: Array<{ path: RegExp; status: number; body: unknown }> = [];

  function allowed(
    token: FakeToken,
    permission: CloudflareAnyPermissionId,
    access: Access,
  ): boolean {
    const grant = token.grants[permission];
    return grant === 'edit' || (grant === 'read' && access === 'read');
  }

  function fullName(name: string, zoneName: string): string {
    if (name === '@' || name === zoneName) return zoneName;
    return name.endsWith(`.${zoneName}`) ? name : `${name}.${zoneName}`;
  }

  function buildRecord(body: Json, zoneName: string, id: string): Json {
    const type = String(body.type);
    const proxied = ADDRESS_TYPES.has(type) ? Boolean(body.proxied) : false;
    const data = body.data as Json | undefined;
    let content = String(body.content ?? '');
    if (type === 'CAA' && data) content = `${data.flags} ${data.tag} "${data.value}"`;
    if (type === 'SRV' && data) content = `${data.weight} ${data.port} ${data.target}`;
    return {
      ...copy(recorded.dnsRecord),
      id,
      type,
      name: fullName(String(body.name), zoneName),
      content,
      proxied,
      proxiable: ADDRESS_TYPES.has(type),
      ttl: proxied ? 1 : Number(body.ttl ?? 1),
      comment: body.comment ?? null,
      ...(body.priority === undefined ? {} : { priority: body.priority }),
      ...(data ? { data } : {}),
    };
  }

  /** Cloudflare refuses an address record beside a CNAME of the same name, and the reverse. */
  function conflicts(records: Json[], candidate: Json): boolean {
    if (!ADDRESS_TYPES.has(String(candidate.type))) return false;
    return records.some(
      (record) =>
        record.id !== candidate.id &&
        record.name === candidate.name &&
        ADDRESS_TYPES.has(String(record.type)) &&
        (record.type === 'CNAME' || candidate.type === 'CNAME'),
    );
  }

  const conflictError = () =>
    fail(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');

  function dnsRoutes(state: FakeZoneState, method: string, rest: string, body: Json) {
    const zoneName = String(state.zone.name);
    if (rest === '/dns_records' && method === 'POST') {
      const record = buildRecord(body, zoneName, nextId());
      if (conflicts(state.records, record)) return conflictError();
      state.records.push(record);
      return ok(record);
    }
    if (rest === '/dns_records/batch' && method === 'POST') {
      const before = copy(state.records);
      for (const { id } of (body.deletes as Json[] | undefined) ?? []) {
        state.records = state.records.filter((record) => record.id !== id);
      }
      for (const patch of (body.patches as Json[] | undefined) ?? []) {
        const index = state.records.findIndex((record) => record.id === patch.id);
        if (index < 0) {
          state.records = before;
          return fail(404, 81044, 'Record does not exist.');
        }
        const merged = { ...state.records[index], ...patch };
        const record = buildRecord(merged, zoneName, String(patch.id));
        if (conflicts(state.records, record)) {
          state.records = before;
          return conflictError();
        }
        state.records[index] = record;
      }
      const posts: Json[] = [];
      for (const post of (body.posts as Json[] | undefined) ?? []) {
        const record = buildRecord(post, zoneName, nextId());
        if (conflicts(state.records, record)) {
          state.records = before;
          return conflictError();
        }
        state.records.push(record);
        posts.push(record);
      }
      return ok({ deletes: body.deletes ?? [], patches: body.patches ?? [], posts, puts: [] });
    }
    const one = rest.match(/^\/dns_records\/([0-9a-f]{32})$/);
    if (one) {
      const index = state.records.findIndex((record) => record.id === one[1]);
      if (index < 0) return fail(404, 81044, 'Record does not exist.');
      if (method === 'DELETE') {
        state.records.splice(index, 1);
        return ok({ id: one[1] });
      }
      const record = buildRecord({ ...state.records[index], ...body }, zoneName, one[1]);
      if (conflicts(state.records, record)) return conflictError();
      state.records[index] = record;
      return ok(record);
    }
    return null;
  }

  function rulesetRoutes(state: FakeZoneState, method: string, rest: string, body: Json) {
    const withRuleIds = (rules: Json[]) =>
      rules.map((rule) => ({
        version: '1',
        last_updated: '2024-06-02T12:00:00Z',
        enabled: true,
        ...rule,
        id: rule.id ?? nextId(),
      }));
    if (rest === '/rulesets/phases/http_request_firewall_custom/entrypoint') {
      return state.ruleset ? ok(state.ruleset) : { status: 404, body: copy(recorded.noEntrypoint) };
    }
    if (rest === '/rulesets' && method === 'POST') {
      if (state.ruleset)
        return fail(400, 20217, 'An entry point ruleset already exists for this phase.');
      state.ruleset = {
        ...copy(recorded.customRuleset),
        id: nextId(),
        name: body.name,
        rules: withRuleIds((body.rules as Json[]) ?? []),
      };
      return ok(state.ruleset);
    }
    const rules = rest.match(/^\/rulesets\/([0-9a-f]{32})\/rules(?:\/([0-9a-f]{32}))?$/);
    if (!rules) return null;
    if (!state.ruleset || state.ruleset.id !== rules[1]) {
      return fail(404, 10003, 'could not find ruleset');
    }
    const list = state.ruleset.rules as Json[];
    if (!rules[2] && method === 'POST') {
      const { position, ...rule } = body;
      const [created] = withRuleIds([rule]);
      const index = (position as { index?: number } | undefined)?.index;
      if (index) list.splice(index - 1, 0, created);
      else list.push(created);
      return ok(state.ruleset);
    }
    const index = list.findIndex((rule) => rule.id === rules[2]);
    if (index < 0) return fail(404, 10003, 'could not find rule');
    if (method === 'DELETE') list.splice(index, 1);
    else list[index] = { ...list[index], ...body, id: rules[2] };
    return ok(state.ruleset);
  }

  function accessRoutes(
    state: FakeZoneState,
    method: string,
    rest: string,
    body: Json,
    query: URLSearchParams,
  ) {
    if (rest === '/firewall/access_rules/rules') {
      if (method === 'GET') return page(state.accessRules, query, 20);
      const rule = { ...copy(recorded.accessRule), id: nextId(), ...body };
      state.accessRules.push(rule);
      return ok(rule);
    }
    const one = rest.match(/^\/firewall\/access_rules\/rules\/([0-9a-f]{32})$/);
    if (!one) return null;
    const index = state.accessRules.findIndex((rule) => rule.id === one[1]);
    if (index < 0) return fail(404, 10001, 'Access rule not found');
    state.accessRules.splice(index, 1);
    return ok({ id: one[1] });
  }

  /** POST /certificates: Origin CA signs for names in the account's zones only. */
  function originRoutes(token: FakeToken, body: Json) {
    if (!allowed(token, 'sslCertificates', 'edit')) {
      return { status: 403, body: copy(recorded.permissionDenied) };
    }
    const hostnames = (body.hostnames as string[] | undefined) ?? [];
    const names = [...zones.values()].map((state) => String(state.zone.name));
    const foreign = hostnames.find(
      (name) =>
        !names.some((zone) => name.replace(/^\*\./, '') === zone || name.endsWith(`.${zone}`)),
    );
    if (typeof body.csr !== 'string' || !body.csr.includes('CERTIFICATE REQUEST')) {
      return fail(400, 1010, 'Failed to parse CSR');
    }
    if (foreign) return fail(400, 1012, `${foreign} is not a hostname of a zone on this account`);
    return ok({ ...copy(recorded.originCertificate), csr: body.csr, hostnames });
  }

  /** Permission groups, and tokens made or deleted with User > API Tokens > Edit. */
  function tokenRoutes(token: FakeToken, method: string, path: string, body: Json) {
    if (path === '/user/tokens/permission_groups') {
      if (!allowed(token, 'apiTokens', 'read')) {
        return { status: 403, body: copy(recorded.permissionDenied) };
      }
      return ok(copy(recorded.permissionGroups));
    }
    if (path === '/user/tokens' && method === 'POST') {
      if (!allowed(token, 'apiTokens', 'edit')) {
        return { status: 403, body: copy(recorded.permissionDenied) };
      }
      const policies = (body.policies as Json[] | undefined) ?? [];
      const zoneIds = policies.flatMap((policy) =>
        Object.keys((policy.resources as Json | undefined) ?? {})
          .map((key) => key.match(/^com\.cloudflare\.api\.account\.zone\.([0-9a-f]{32})$/)?.[1])
          .filter((id): id is string => Boolean(id)),
      );
      const groups = policies.flatMap((policy) => (policy.permission_groups as Json[]) ?? []);
      const id = nextId();
      const value = `minted${id}`.slice(0, 40);
      options.tokens[value] = {
        id,
        grants: groups.some((group) => group.id === recorded.DNS_WRITE_GROUP_ID)
          ? { dns: 'edit' }
          : {},
        zoneIds,
      };
      return ok({ ...copy(recorded.createdToken), id, name: body.name, policies, value });
    }
    const one = path.match(/^\/user\/tokens\/([0-9a-f]{32})$/);
    if (one && method === 'DELETE') {
      if (!allowed(token, 'apiTokens', 'edit')) {
        return { status: 403, body: copy(recorded.permissionDenied) };
      }
      const entry = Object.entries(options.tokens).find(([, candidate]) => candidate.id === one[1]);
      if (!entry) return fail(404, 1003, 'Token not found');
      delete options.tokens[entry[0]];
      return ok({ id: one[1] });
    }
    return null;
  }

  /** Which permission a zone route needs, as Cloudflare's gateway sees it. */
  function routePermission(method: string, rest: string): [CloudflarePermissionId, Access] {
    const access: Access = method === 'GET' ? 'read' : 'edit';
    if (rest.startsWith('/dns_records')) return ['dns', access];
    if (rest.startsWith('/settings')) return ['zoneSettings', access];
    if (rest.startsWith('/purge_cache')) return ['cachePurge', 'edit'];
    if (rest.startsWith('/rulesets')) return ['waf', access];
    if (rest.startsWith('/firewall/access_rules')) return ['accessRules', access];
    return ['zone', access];
  }

  function route(request: FakeRequest, token: FakeToken | undefined) {
    const { method, path, query } = request;
    const body = (request.body ?? {}) as Json;
    if (!token) return { status: 401, body: copy(recorded.invalidToken) };

    if (path === '/user/tokens/verify') {
      return ok({
        ...copy(recorded.verifiedToken),
        id: token.id ?? recorded.TOKEN_ID,
        status: token.status ?? 'active',
      });
    }
    if (path === '/certificates' && method === 'POST') return originRoutes(token, body);
    const tokens = tokenRoutes(token, method, path, body);
    if (tokens) return tokens;
    const self = path.match(/^\/user\/tokens\/([0-9a-f]{32})$/);
    if (self) {
      if (!token.canReadSelf) return { status: 403, body: copy(recorded.unauthorizedToRead) };
      const details = copy(recorded.tokenDetails);
      details.id = token.id ?? recorded.TOKEN_ID;
      details.policies[0].permission_groups = Object.entries(token.grants).map(([id, level]) => ({
        id: nextId(),
        name: PERMISSION_NAMES[id as CloudflarePermissionId][level as Access],
      }));
      return ok(details);
    }
    if (path === '/zones') {
      const visible = token.grants.zone
        ? [...zones.values()]
            .filter((state) => !token.zoneIds || token.zoneIds.includes(String(state.zone.id)))
            .map((state) => state.zone)
        : [];
      return page(visible, query, 20);
    }
    const zoneMatch = path.match(/^\/zones\/([0-9a-f]{32})(\/.*)?$/);
    if (!zoneMatch) return fail(404, 7000, 'No route for that URI');
    const state = zones.get(zoneMatch[1]);
    const rest = zoneMatch[2] ?? '';
    const [permission, access] = routePermission(method, rest);
    if (token.zoneIds && !token.zoneIds.includes(zoneMatch[1])) {
      return { status: 403, body: copy(recorded.permissionDenied) };
    }
    if (!allowed(token, permission, access))
      return { status: 403, body: copy(recorded.permissionDenied) };
    if (!state) {
      return fail(
        404,
        7003,
        `Could not route to /zones/${zoneMatch[1]}, perhaps your object identifier is invalid?`,
      );
    }
    if (rest === '') return ok(state.zone);

    const setting = rest.match(/^\/settings\/([a-z0-9_]+)$/);
    if (setting) {
      const current = state.settings[setting[1]];
      if (!current) return fail(404, 1006, 'Unrecognized zone setting name');
      if (method === 'GET') return ok(current);
      // Cloudflare takes the TTL as a number and the rest as text, and answers the same way.
      const value = body.value;
      if (!SETTING_VALUES[setting[1]].includes(String(value))) {
        return fail(400, 1007, `Invalid value for zone setting ${setting[1]}`);
      }
      state.settings[setting[1]] = {
        ...current,
        value,
        ...(setting[1] === 'development_mode'
          ? { time_remaining: value === 'on' ? 10800 : 0 }
          : {}),
      };
      return ok(state.settings[setting[1]]);
    }
    if (rest === '/purge_cache') {
      state.purges.push(body);
      return ok({ id: state.zone.id });
    }
    if (rest === '/dns_records' && method === 'GET') {
      const name = query.get('name.exact');
      const type = query.get('type');
      const matching = state.records.filter(
        (record) => (!name || record.name === name) && (!type || record.type === type),
      );
      return page(matching, query, 100);
    }
    return (
      dnsRoutes(state, method, rest, body) ??
      rulesetRoutes(state, method, rest, body) ??
      accessRoutes(state, method, rest, body, query) ??
      fail(404, 7000, 'No route for that URI')
    );
  }

  async function fakeFetch(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    const text = typeof init.body === 'string' ? init.body : '';
    const request: FakeRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length)
        : url.pathname,
      query: url.searchParams,
      body: text ? (JSON.parse(text) as unknown) : undefined,
      headers,
    };
    requests.push(request);

    let answer: { status: number; body: unknown };
    const failure = failures.findIndex((candidate) => candidate.path.test(request.path));
    if (url.origin !== 'https://api.cloudflare.com') {
      answer = fail(421, 0, 'Not Cloudflare');
    } else if (failure >= 0) {
      const [planned] = failures.splice(failure, 1);
      answer = {
        status: planned.status,
        body: planned.body ?? fail(planned.status, 0, 'Failed').body,
      };
    } else {
      const bearer = headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      answer = route(request, bearer === undefined ? undefined : options.tokens[bearer]);
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  return {
    fetch: fakeFetch,
    tokens: options.tokens,
    requests,
    zones,
    writes: () => requests.filter((request) => request.method !== 'GET'),
    failNext: (path, status, body) => {
      failures.push({ path, status, body });
    },
  };
}
