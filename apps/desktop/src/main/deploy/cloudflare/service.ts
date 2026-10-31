import { randomUUID } from 'node:crypto';
import type {
  RecordBatchParams,
  RecordCreateParams,
  RecordEditParams,
} from 'cloudflare/resources/dns/records';
import type { AccessRuleCreateParams } from 'cloudflare/resources/firewall/access-rules';
import type { RuleCreateParams, RuleEditParams } from 'cloudflare/resources/rulesets/rules';
import type { RulesetCreateParams } from 'cloudflare/resources/rulesets/rulesets';
import type { Widget, WidgetListResponse } from 'cloudflare/resources/turnstile/widgets';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { PROXIABLE_TYPES } from '../../../shared/cloudflare/dns';
import { CLOUDFLARE_PERMISSIONS, tokenProblem } from '../../../shared/cloudflare/permissions';
import { accessRuleTarget, type BuiltRule, buildRule } from '../../../shared/cloudflare/rules';
import { isTurnstileSitekey, validateTurnstileInput } from '../../../shared/cloudflare/turnstile';
import { encodeCloudflareError } from '../../../shared/cloudflareErrors';
import type {
  CloudflareAccessMode,
  CloudflareAccessRule,
  CloudflareAccessRuleInput,
  CloudflareAccessTarget,
  CloudflareAnyPermissionId,
  CloudflareCacheLevel,
  CloudflareCustomRule,
  CloudflareCustomRuleInput,
  CloudflareDnsRecord,
  CloudflareMinTlsVersion,
  CloudflarePermissionId,
  CloudflarePointDomainInput,
  CloudflarePointDomainPlan,
  CloudflarePointDomainResult,
  CloudflarePurgeRequest,
  CloudflareRecordInput,
  CloudflareSaveTokenInput,
  CloudflareSecurityLevel,
  CloudflareSettingChange,
  CloudflareSslMode,
  CloudflareStatus,
  CloudflareZone,
  CloudflareZoneSettings,
  TurnstileWidget,
  TurnstileWidgetInput,
  TurnstileWithSecret,
} from '../../../shared/cloudflareTypes';
import { type CloudflareApi, type CloudflareFetch, createCloudflareApi } from './client';
import { cloudflareFailure, isNotFound, isPermissionDenied, isUnauthorized } from './errors';
import { planChanges, pointedNames, type ServerAddresses } from './pointDomain';
import type { CloudflareState } from './state';
import { checkToken } from './tokenCheck';

/**
 * The Cloudflare dialog's main-process side. Any number of accounts can be connected. Each API token
 * arrives once from the renderer, is checked against Cloudflare, sealed with the Servers vault and
 * saved; after that the renderer only ever sees whether one is set and what it may do. Every call
 * unseals the token of the account it is for (a zone call finds the account that holds the zone)
 * for the length of that call and goes through the official SDK. When Cloudflare refuses a call
 * for want of a permission, the error names it (and the account's saved report marks it missing),
 * so the page can show exactly what to add to the token.
 *
 * Origin CA certificates (T5), the Cloudflare-only origin lock (T6) and DNS-01 tokens for a
 * server (T7) involve the server core too; they live in serverOps.ts and use this service's
 * `useApi`, so the token is handled in one place.
 */

export interface CloudflareServiceDeps {
  state: CloudflareState;
  /** Seals the token with the Servers vault, and opens it again. */
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  /** Whether opening this envelope needs the Servers passkey, which is locked right now. */
  isLocked: (envelope: SecretEnvelope) => boolean;
  /** A saved server's public addresses, for "point domain to this server". */
  addresses: (serverId: string) => Promise<ServerAddresses>;
  /** The SDK's fetch; tests pass the fake Cloudflare API. */
  fetch?: CloudflareFetch;
  /** The API's base URL; only the e2e run sets it, to reach the recorded fake on loopback. */
  baseURL?: string;
  maxRetries?: number;
  now?: () => number;
  /** Ids for new accounts; tests pass a counter. */
  newId?: () => string;
}

const CUSTOM_PHASE = 'http_request_firewall_custom';

/** The permissions the saved report tracks (the extra ones are only named when refused). */
function isMainPermission(id: CloudflareAnyPermissionId): id is CloudflarePermissionId {
  return CLOUDFLARE_PERMISSIONS.some((permission) => permission.id === id);
}
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const EDITABLE: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'SRV']);
const SETTING_IDS = {
  developmentMode: 'development_mode',
  securityLevel: 'security_level',
  ssl: 'ssl',
  alwaysUseHttps: 'always_use_https',
  automaticHttpsRewrites: 'automatic_https_rewrites',
  minTlsVersion: 'min_tls_version',
  tls13: 'tls_1_3',
  cacheLevel: 'cache_level',
  browserCacheTtl: 'browser_cache_ttl',
} as const;
type SettingKey = keyof typeof SETTING_IDS;
const NO_TOKEN = 'Connect Cloudflare first: paste an API token in Cloudflare: domains and DNS.';
const NO_ZONE = 'That domain is not in any of the connected Cloudflare accounts.';
const UNKNOWN_ACCOUNT = 'That Cloudflare account is not connected any more.';
const MAX_LABEL = 60;
const LOCKED =
  'Your saved servers are locked with a passkey, and the Cloudflare token with them. Unlock them first.';
const RULE_GONE = 'That rule is not in this zone any more. Refresh the list.';
const WIDGET_GONE = 'That widget is not in this Cloudflare account any more. Refresh the list.';
const NO_CLOUDFLARE_ACCOUNT =
  'Cloudflare did not say which account this domain is in, so its Turnstile widgets cannot be found.';
const BAD_SITEKEY = 'That is not a Turnstile site key.';

/** The fields of a DNS record the page reads, whatever its type. */
interface ApiRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied?: boolean;
  proxiable?: boolean;
  priority?: number;
  comment?: string | null;
  data?: {
    flags?: number;
    tag?: string;
    value?: string;
    priority?: number;
    weight?: number;
    port?: number;
    target?: string;
  };
}

interface ApiRule {
  id?: string;
  action?: string;
  expression?: string;
  description?: string;
  enabled?: boolean;
  last_updated?: string;
  action_parameters?: unknown;
}

interface ApiRuleset {
  id: string;
  rules?: ApiRule[];
}

interface ApiSetting {
  value?: unknown;
  editable?: boolean;
  time_remaining?: number;
}

function toRecord(record: ApiRecord): CloudflareDnsRecord {
  const result: CloudflareDnsRecord = {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content ?? '',
    ttl: record.ttl,
    proxied: record.proxied ?? false,
    proxiable: record.proxiable ?? false,
    ...(record.comment ? { comment: record.comment } : {}),
    editable: EDITABLE.has(record.type),
  };
  const data = record.data ?? {};
  if (record.type === 'MX') result.priority = record.priority ?? 0;
  if (record.type === 'CAA') {
    result.caa = {
      flags: data.flags ?? 0,
      tag: (data.tag ?? 'issue') as 'issue' | 'issuewild' | 'iodef',
      value: data.value ?? '',
    };
  }
  if (record.type === 'SRV') {
    result.srv = {
      priority: data.priority ?? record.priority ?? 0,
      weight: data.weight ?? 0,
      port: data.port ?? 0,
      target: data.target ?? '',
    };
  }
  return result;
}

/** The SDK body for a record: proxied records always use the automatic TTL. */
function recordBody(input: CloudflareRecordInput): Record<string, unknown> {
  const proxied = 'proxied' in input && PROXIABLE_TYPES.has(input.type) ? input.proxied : false;
  const common = {
    type: input.type,
    name: input.name,
    ttl: proxied ? 1 : input.ttl,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
  switch (input.type) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
      return { ...common, content: input.content, proxied };
    case 'TXT':
      return { ...common, content: input.content };
    case 'MX':
      return { ...common, content: input.content, priority: input.priority };
    case 'CAA':
      return { ...common, data: { ...input.caa } };
    default:
      return { ...common, data: { ...input.srv } };
  }
}

function toRule(rule: ApiRule): CloudflareCustomRule {
  return {
    id: rule.id ?? '',
    description: rule.description ?? '',
    expression: rule.expression ?? '',
    action: rule.action ?? '',
    enabled: rule.enabled ?? true,
    lastUpdated: rule.last_updated ?? null,
  };
}

function rulesOf(ruleset: ApiRuleset | null): CloudflareCustomRule[] {
  return (ruleset?.rules ?? []).map(toRule);
}

function ruleBody(rule: BuiltRule, description: string): Record<string, unknown> {
  return {
    description,
    expression: rule.expression,
    action: rule.action,
    enabled: true,
    ...(rule.actionParameters ? { action_parameters: rule.actionParameters } : {}),
  };
}

function toAccessRule(rule: {
  id: string;
  mode: string;
  configuration?: { target?: string; value?: string };
  notes?: string;
  created_on?: string;
}): CloudflareAccessRule {
  return {
    id: rule.id,
    mode: rule.mode as CloudflareAccessMode,
    target: (rule.configuration?.target ?? 'ip') as CloudflareAccessTarget,
    value: rule.configuration?.value ?? '',
    notes: rule.notes ?? '',
    createdOn: rule.created_on ?? null,
  };
}

function settingValue<T extends string>(setting: ApiSetting, fallback: T): T {
  return typeof setting.value === 'string' ? (setting.value as T) : fallback;
}

function settingNumber(setting: ApiSetting, fallback: number): number {
  return typeof setting.value === 'number' ? setting.value : fallback;
}

/**
 * Every page of a v4 list, stopping at the last page Cloudflare reports. The SDK's own iterator
 * always asks for one more page than there is, and its types leave `total_pages` out.
 */
async function allPages<T>(
  fetchPage: (page: number) => PromiseLike<{ result: T[]; result_info?: unknown }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = await fetchPage(page);
    items.push(...answer.result);
    const totalPages = (answer.result_info as { total_pages?: number } | undefined)?.total_pages;
    if (page >= (totalPages ?? 1) || answer.result.length === 0) break;
  }
  return items;
}

function toWidget(widget: Widget | WidgetListResponse): TurnstileWidget {
  return {
    sitekey: widget.sitekey,
    name: widget.name,
    domains: [...widget.domains],
    mode: widget.mode,
    clearance: widget.clearance_level,
    region: widget.region,
    offlabel: widget.offlabel,
    ephemeralId: widget.ephemeral_id,
    createdOn: widget.created_on,
    modifiedOn: widget.modified_on,
  };
}

/** The whole body Cloudflare wants on both create and update, checked first. */
function widgetBody(input: TurnstileWidgetInput) {
  const problem = validateTurnstileInput(input);
  if (problem) throw new Error(problem);
  return {
    name: input.name.trim(),
    domains: input.domains,
    mode: input.mode,
    clearance_level: input.clearance,
    region: input.region,
    offlabel: input.offlabel,
    ephemeral_id: input.ephemeralId,
  };
}

function checkSitekey(sitekey: string): void {
  if (!isTurnstileSitekey(sitekey)) throw new Error(BAD_SITEKEY);
}

/** What the user typed for a new account's name, or "Account 2" and so on when they left it out. */
function cleanLabel(typed: string | undefined, existing: { label: string }[]): string {
  const label = (typed ?? '').trim().slice(0, MAX_LABEL);
  if (label !== '') return label;
  const taken = new Set(existing.map((account) => account.label));
  for (let number = existing.length + 1; ; number += 1) {
    const candidate = `Account ${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class CloudflareService {
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Which account each listed zone came from, so a zone call finds its token. */
  private readonly zoneOwners = new Map<string, string>();
  /** Cloudflare's own account id for each listed zone, for the account-level Turnstile API. */
  private readonly zoneCloudflareAccounts = new Map<string, string>();

  constructor(private readonly deps: CloudflareServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  async status(): Promise<CloudflareStatus> {
    const stored = await this.deps.state.accounts();
    const accounts = stored.map((account) => ({
      id: account.id,
      label: account.label,
      locked: this.deps.isLocked(account.token.envelope),
      report: account.report,
    }));
    return {
      configured: accounts.length > 0,
      locked: accounts.some((account) => account.locked),
      accounts,
    };
  }

  /**
   * Checks a pasted token, then seals and saves it with its report, missing permissions and all.
   * With an `accountId` it replaces that account's token; without, it connects another account.
   * A token that is already connected under another name is refused rather than saved twice.
   */
  async saveToken(input: CloudflareSaveTokenInput): Promise<CloudflareStatus> {
    const { token } = input;
    const problem = tokenProblem(token);
    if (problem) throw new Error(problem);
    const existing = await this.deps.state.accounts();
    const replacing = input.accountId ? existing.find((item) => item.id === input.accountId) : null;
    if (input.accountId && !replacing) throw new Error(UNKNOWN_ACCOUNT);
    const api = this.api(token);
    let report: Awaited<ReturnType<typeof checkToken>>;
    try {
      report = await checkToken(api, this.now());
    } catch (error) {
      if (isUnauthorized(error) || isPermissionDenied(error)) {
        throw new Error(
          'Cloudflare did not accept this token. Check that you copied all of it, and that it is an API token from My Profile > API Tokens.',
        );
      }
      throw cloudflareFailure(error, token);
    }
    if (report.status !== 'active') {
      throw new Error(
        `This token is ${report.status} on Cloudflare. Turn it back on there, or create a new one.`,
      );
    }
    let envelope: SecretEnvelope;
    try {
      envelope = await this.deps.seal(token);
    } catch {
      throw new Error(encodeCloudflareError('locked', LOCKED));
    }
    const twin = existing.find(
      (item) => item.token.tokenId === report.tokenId && item.id !== replacing?.id,
    );
    if (twin) {
      throw new Error(`This token is already connected as ${twin.label}. Use a different token.`);
    }
    await this.deps.state.save({
      id: replacing?.id ?? this.newId(),
      label: replacing?.label ?? cleanLabel(input.label, existing),
      token: { envelope, tokenId: report.tokenId, savedAt: this.now() },
      report,
    });
    return this.status();
  }

  /** Checks an account's saved token again, as after its permissions were edited on Cloudflare. */
  async checkToken(accountId: string): Promise<CloudflareStatus> {
    const report = await this.withAccount(accountId, undefined, (api) =>
      checkToken(api, this.now()),
    );
    await this.deps.state.setReport(accountId, report);
    return this.status();
  }

  async removeToken(accountId: string): Promise<CloudflareStatus> {
    await this.deps.state.remove(accountId);
    for (const [zoneId, owner] of this.zoneOwners) {
      if (owner === accountId) this.zoneOwners.delete(zoneId);
    }
    return this.status();
  }

  /** The zones one account's token can see. */
  listZones(accountId: string): Promise<CloudflareZone[]> {
    return this.withAccount(accountId, 'zone', async (api) => {
      const zones = await allPages((page) => api.zones.list({ page, per_page: 50 }));
      return zones.map((zone) => {
        const cloudflareAccountId = zone.account?.id ?? '';
        this.zoneOwners.set(zone.id, accountId);
        this.zoneCloudflareAccounts.set(zone.id, cloudflareAccountId);
        return {
          id: zone.id,
          accountId,
          cloudflareAccountId,
          name: zone.name,
          status: zone.status ?? 'active',
          paused: zone.paused ?? false,
          plan: zone.plan?.name ?? '',
          nameServers: zone.name_servers ?? [],
        };
      });
    });
  }

  /**
   * The zones of every connected account, for the flows that work from a domain name rather than
   * from one account. An account whose token fails is left out so the others still answer; only
   * when none answers is the first failure thrown.
   */
  async allZones(): Promise<CloudflareZone[]> {
    const accounts = await this.deps.state.accounts();
    if (accounts.length === 0) throw new Error(encodeCloudflareError('no-token', NO_TOKEN));
    const settled = await Promise.allSettled(accounts.map((account) => this.listZones(account.id)));
    const zones = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed && zones.length === 0 && settled.every((result) => result.status === 'rejected')) {
      throw (failed as PromiseRejectedResult).reason;
    }
    return zones;
  }

  listRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    return this.withZone(zoneId, 'dns', async (api) => {
      const records = await allPages((page) =>
        api.dns.records.list({ zone_id: zoneId, page, per_page: PAGE_SIZE }),
      );
      return records.map((record) => toRecord(record as unknown as ApiRecord));
    });
  }

  createRecord(zoneId: string, input: CloudflareRecordInput): Promise<CloudflareDnsRecord> {
    return this.withZone(zoneId, 'dns', async (api) => {
      const params = { zone_id: zoneId, ...recordBody(input) } as RecordCreateParams;
      return toRecord((await api.dns.records.create(params)) as unknown as ApiRecord);
    });
  }

  /** A PATCH rather than a PUT, so tags and anything else set on the dashboard survive. */
  updateRecord(
    zoneId: string,
    recordId: string,
    input: CloudflareRecordInput,
  ): Promise<CloudflareDnsRecord> {
    return this.withZone(zoneId, 'dns', async (api) => {
      const params = { zone_id: zoneId, ...recordBody(input) } as RecordEditParams;
      return toRecord((await api.dns.records.edit(recordId, params)) as unknown as ApiRecord);
    });
  }

  deleteRecord(zoneId: string, recordId: string): Promise<void> {
    return this.withZone(zoneId, 'dns', async (api) => {
      await api.dns.records.delete(recordId, { zone_id: zoneId });
    });
  }

  zoneSettings(zoneId: string): Promise<CloudflareZoneSettings> {
    return this.withZone(zoneId, 'zoneSettings', (api) => this.readSettings(api, zoneId));
  }

  changeSetting(zoneId: string, change: CloudflareSettingChange): Promise<CloudflareZoneSettings> {
    return this.withZone(zoneId, 'zoneSettings', async (api) => {
      await api.zones.settings.edit(SETTING_IDS[change.setting], {
        zone_id: zoneId,
        value: change.value,
      });
      return this.readSettings(api, zoneId);
    });
  }

  purgeCache(zoneId: string, request: CloudflarePurgeRequest): Promise<void> {
    return this.withZone(zoneId, 'cachePurge', async (api) => {
      await api.cache.purge(
        'everything' in request
          ? { zone_id: zoneId, purge_everything: true }
          : { zone_id: zoneId, files: request.urls },
      );
    });
  }

  listCustomRules(zoneId: string): Promise<CloudflareCustomRule[]> {
    return this.withZone(zoneId, 'waf', async (api) =>
      rulesOf(await this.customRuleset(api, zoneId)),
    );
  }

  /**
   * Adds a builder rule to the zone's custom rules. A zone without any gets its entry point made
   * with the rule in it; the entry point is never replaced with a PUT, which would drop the rules
   * already there.
   */
  createCustomRule(
    zoneId: string,
    input: CloudflareCustomRuleInput,
  ): Promise<CloudflareCustomRule[]> {
    const built = buildRule(input.spec);
    if (!built.ok) return Promise.reject(new Error(built.problem));
    const body = ruleBody(built.rule, input.description);
    return this.withZone(zoneId, 'waf', async (api) => {
      const ruleset = await this.customRuleset(api, zoneId);
      if (!ruleset) {
        const created = await api.rulesets.create({
          zone_id: zoneId,
          kind: 'zone',
          name: 'default',
          phase: CUSTOM_PHASE,
          rules: [body],
        } as unknown as RulesetCreateParams);
        return rulesOf(created as unknown as ApiRuleset);
      }
      const params = {
        zone_id: zoneId,
        ...body,
        ...(built.rule.first ? { position: { index: 1 } } : {}),
      } as unknown as RuleCreateParams;
      return rulesOf(
        (await api.rulesets.rules.create(ruleset.id, params)) as unknown as ApiRuleset,
      );
    });
  }

  /** Sends the rule's whole definition with the new state, so nothing else about it changes. */
  setCustomRuleEnabled(
    zoneId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<CloudflareCustomRule[]> {
    return this.withZone(zoneId, 'waf', async (api) => {
      const { ruleset, rule } = await this.findRule(api, zoneId, ruleId);
      const params = {
        zone_id: zoneId,
        ruleset_id: ruleset.id,
        action: rule.action,
        expression: rule.expression,
        description: rule.description ?? '',
        enabled,
        ...(rule.action_parameters ? { action_parameters: rule.action_parameters } : {}),
      } as unknown as RuleEditParams;
      return rulesOf((await api.rulesets.rules.edit(ruleId, params)) as unknown as ApiRuleset);
    });
  }

  deleteCustomRule(zoneId: string, ruleId: string): Promise<CloudflareCustomRule[]> {
    return this.withZone(zoneId, 'waf', async (api) => {
      const { ruleset } = await this.findRule(api, zoneId, ruleId);
      const after = await api.rulesets.rules.delete(ruleId, {
        zone_id: zoneId,
        ruleset_id: ruleset.id,
      });
      return rulesOf(after as unknown as ApiRuleset);
    });
  }

  listAccessRules(zoneId: string): Promise<CloudflareAccessRule[]> {
    return this.withZone(zoneId, 'accessRules', async (api) => {
      const rules = await allPages((page) =>
        api.firewall.accessRules.list({ zone_id: zoneId, page, per_page: PAGE_SIZE }),
      );
      return rules.map(toAccessRule);
    });
  }

  createAccessRule(
    zoneId: string,
    input: CloudflareAccessRuleInput,
  ): Promise<CloudflareAccessRule> {
    const target = accessRuleTarget(input.value);
    if (!target.ok) return Promise.reject(new Error(target.problem));
    return this.withZone(zoneId, 'accessRules', async (api) => {
      const created = await api.firewall.accessRules.create({
        zone_id: zoneId,
        mode: input.mode,
        configuration: { target: target.target, value: target.value },
        notes: input.notes,
      } as AccessRuleCreateParams);
      return toAccessRule(created);
    });
  }

  deleteAccessRule(zoneId: string, ruleId: string): Promise<void> {
    return this.withZone(zoneId, 'accessRules', async (api) => {
      await api.firewall.accessRules.delete(ruleId, { zone_id: zoneId });
    });
  }

  /** What pointing the name at the server would change, without changing anything. */
  /** Every Turnstile widget in the zone's Cloudflare account; the zone's tab picks its own. */
  listTurnstileWidgets(zoneId: string): Promise<TurnstileWidget[]> {
    return this.withTurnstile(zoneId, async (api, account_id) => {
      const widgets = await allPages((page) =>
        api.turnstile.widgets.list({ account_id, page, per_page: 25 }),
      );
      return widgets.map(toWidget);
    });
  }

  async createTurnstileWidget(
    zoneId: string,
    input: TurnstileWidgetInput,
  ): Promise<TurnstileWithSecret> {
    const body = widgetBody(input);
    return this.withTurnstile(zoneId, async (api, account_id) => {
      const widget = await api.turnstile.widgets.create({ account_id, ...body });
      return { widget: toWidget(widget), secret: widget.secret };
    });
  }

  async updateTurnstileWidget(
    zoneId: string,
    sitekey: string,
    input: TurnstileWidgetInput,
  ): Promise<TurnstileWidget> {
    checkSitekey(sitekey);
    const body = widgetBody(input);
    return this.withTurnstile(zoneId, async (api, account_id) =>
      toWidget(await api.turnstile.widgets.update(sitekey, { account_id, ...body })),
    );
  }

  async deleteTurnstileWidget(zoneId: string, sitekey: string): Promise<void> {
    checkSitekey(sitekey);
    return this.withTurnstile(zoneId, async (api, account_id) => {
      await api.turnstile.widgets.delete(sitekey, { account_id });
    });
  }

  /** A widget's secret, read from Cloudflare each time it is asked for and never kept here. */
  async turnstileSecret(zoneId: string, sitekey: string): Promise<string> {
    checkSitekey(sitekey);
    return this.withTurnstile(
      zoneId,
      async (api, account_id) => (await api.turnstile.widgets.get(sitekey, { account_id })).secret,
    );
  }

  /**
   * A new secret for a widget. Cloudflare keeps the old one working for two hours, so servers
   * can be moved over, unless `invalidateNow` asks it to stop at once (after a leak).
   */
  async rotateTurnstileSecret(
    zoneId: string,
    sitekey: string,
    invalidateNow: boolean,
  ): Promise<TurnstileWithSecret> {
    checkSitekey(sitekey);
    return this.withTurnstile(zoneId, async (api, account_id) => {
      const widget = await api.turnstile.widgets.rotateSecret(sitekey, {
        account_id,
        invalidate_immediately: invalidateNow,
      });
      return { widget: toWidget(widget), secret: widget.secret };
    });
  }

  planPointDomain(input: CloudflarePointDomainInput): Promise<CloudflarePointDomainPlan> {
    return this.withZone(input.zoneId, 'dns', (api) => this.plan(api, input));
  }

  /** Applies the plan in one batch, which Cloudflare runs as a single transaction (AC2). */
  pointDomain(input: CloudflarePointDomainInput): Promise<CloudflarePointDomainResult> {
    return this.withZone(input.zoneId, 'dns', async (api) => {
      const plan = await this.plan(api, input);
      if (plan.upToDate) return { plan, applied: 0 };
      const deletes = plan.changes.filter((change) => change.action === 'delete');
      const patches = plan.changes.filter((change) => change.action === 'update');
      const posts = plan.changes.filter((change) => change.action === 'create');
      const ttlOf = new Map(
        (await this.recordsAt(api, input.zoneId, plan.names)).map((record) => [
          record.id,
          record.ttl,
        ]),
      );
      await api.dns.records.batch({
        zone_id: input.zoneId,
        deletes: deletes.map((change) => ({ id: change.recordId })),
        patches: patches.map((change) => ({
          id: change.recordId,
          type: change.type,
          name: change.name,
          content: change.content,
          proxied: change.proxied,
          ttl: change.proxied ? 1 : (ttlOf.get(change.recordId ?? '') ?? 1),
        })),
        posts: posts.map((change) => ({
          type: change.type,
          name: change.name,
          content: change.content,
          proxied: change.proxied,
          ttl: 1,
        })),
      } as RecordBatchParams);
      return { plan, applied: deletes.length + patches.length + posts.length };
    });
  }

  private async plan(
    api: CloudflareApi,
    input: CloudflarePointDomainInput,
  ): Promise<CloudflarePointDomainPlan> {
    const zone = await api.zones.get({ zone_id: input.zoneId });
    const names = pointedNames(input.name, zone.name, input.includeWww);
    if (!names) {
      throw new Error(
        'That name cannot be used for a website. Use @ for the domain itself, or a name like app.',
      );
    }
    const addresses = await this.deps.addresses(input.serverId);
    const existing = await this.recordsAt(api, input.zoneId, names);
    const changes = planChanges({ names, addresses, proxied: input.proxied, existing });
    return {
      zoneName: zone.name,
      names,
      addresses,
      changes,
      upToDate: changes.every((change) => change.action === 'keep'),
    };
  }

  private async recordsAt(
    api: CloudflareApi,
    zoneId: string,
    names: string[],
  ): Promise<CloudflareDnsRecord[]> {
    const lists = await Promise.all(
      names.map((name) =>
        allPages((page) =>
          api.dns.records.list({
            zone_id: zoneId,
            name: { exact: name },
            page,
            per_page: PAGE_SIZE,
          }),
        ),
      ),
    );
    return lists.flat().map((record) => toRecord(record as unknown as ApiRecord));
  }

  private async readSettings(api: CloudflareApi, zoneId: string): Promise<CloudflareZoneSettings> {
    const keys = Object.keys(SETTING_IDS) as SettingKey[];
    const read = (await Promise.all(
      keys.map((key) => api.zones.settings.get(SETTING_IDS[key], { zone_id: zoneId })),
    )) as ApiSetting[];
    const got = Object.fromEntries(keys.map((key, index) => [key, read[index]])) as Record<
      SettingKey,
      ApiSetting
    >;
    const editable = (key: SettingKey): boolean => got[key].editable ?? true;
    return {
      developmentMode: {
        value: settingValue<'on' | 'off'>(got.developmentMode, 'off'),
        secondsRemaining: got.developmentMode.time_remaining ?? 0,
        editable: editable('developmentMode'),
      },
      securityLevel: {
        value: settingValue<CloudflareSecurityLevel>(got.securityLevel, 'medium'),
        editable: editable('securityLevel'),
      },
      ssl: { value: settingValue<CloudflareSslMode>(got.ssl, 'off'), editable: editable('ssl') },
      alwaysUseHttps: {
        value: settingValue<'on' | 'off'>(got.alwaysUseHttps, 'off'),
        editable: editable('alwaysUseHttps'),
      },
      automaticHttpsRewrites: {
        value: settingValue<'on' | 'off'>(got.automaticHttpsRewrites, 'off'),
        editable: editable('automaticHttpsRewrites'),
      },
      minTlsVersion: {
        value: settingValue<CloudflareMinTlsVersion>(got.minTlsVersion, '1.0'),
        editable: editable('minTlsVersion'),
      },
      tls13: {
        value: settingValue<'on' | 'off' | 'zrt'>(got.tls13, 'off'),
        editable: editable('tls13'),
      },
      cacheLevel: {
        value: settingValue<CloudflareCacheLevel>(got.cacheLevel, 'aggressive'),
        editable: editable('cacheLevel'),
      },
      browserCacheTtl: {
        value: settingNumber(got.browserCacheTtl, 0),
        editable: editable('browserCacheTtl'),
      },
    };
  }

  /** The zone's custom rules entry point, or null when the zone has no custom rules yet. */
  private async customRuleset(api: CloudflareApi, zoneId: string): Promise<ApiRuleset | null> {
    try {
      return (await api.rulesets.phases.get(CUSTOM_PHASE, {
        zone_id: zoneId,
      })) as unknown as ApiRuleset;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async findRule(api: CloudflareApi, zoneId: string, ruleId: string) {
    const ruleset = await this.customRuleset(api, zoneId);
    const rule = ruleset?.rules?.find((candidate) => candidate.id === ruleId);
    if (!ruleset || !rule) throw new Error(RULE_GONE);
    return { ruleset, rule };
  }

  private api(token: string): CloudflareApi {
    return createCloudflareApi(token, {
      fetch: this.deps.fetch,
      maxRetries: this.deps.maxRetries,
      ...(this.deps.baseURL ? { baseURL: this.deps.baseURL } : {}),
    });
  }

  /**
   * An account's API for the server-side flows (serverOps.ts), with the same refusal handling as
   * the page's own calls. The token never leaves this process.
   */
  useApi<T>(
    accountId: string,
    permission: CloudflareAnyPermissionId | undefined,
    work: (api: CloudflareApi) => Promise<T>,
  ): Promise<T> {
    return this.withAccount(accountId, permission, work);
  }

  /** A client for a token the user pasted for a server (never saved here); errors scrub it. */
  async withPastedToken<T>(token: string, work: (api: CloudflareApi) => Promise<T>): Promise<T> {
    try {
      return await work(this.api(token));
    } catch (error) {
      throw cloudflareFailure(error, token);
    }
  }

  /** Whether this is the token of a connected account, which must never go to a server. */
  async isSavedToken(token: string): Promise<boolean> {
    for (const account of await this.deps.state.accounts()) {
      if (this.deps.isLocked(account.token.envelope)) continue;
      try {
        if ((await this.deps.unseal(account.token.envelope)) === token) return true;
      } catch {
        // A token that cannot be opened cannot be this one.
      }
    }
    return false;
  }

  /**
   * The account that holds a zone. Zones the page has listed are remembered; any other (the page
   * has not been opened since launch) is looked for in each account in turn.
   */
  async accountOfZone(zoneId: string): Promise<string> {
    const known = this.zoneOwners.get(zoneId);
    if (known) return known;
    for (const account of await this.deps.state.accounts()) {
      if (this.deps.isLocked(account.token.envelope)) continue;
      try {
        if ((await this.listZones(account.id)).some((zone) => zone.id === zoneId)) {
          return account.id;
        }
      } catch {
        // This account cannot say; the next one might.
      }
    }
    throw new Error(NO_ZONE);
  }

  private async withZone<T>(
    zoneId: string,
    permission: CloudflareAnyPermissionId | undefined,
    work: (api: CloudflareApi) => Promise<T>,
  ): Promise<T> {
    return this.withAccount(await this.accountOfZone(zoneId), permission, work);
  }

  /**
   * Runs `work` against the Cloudflare account that holds a zone, with Turnstile as the permission
   * a refusal names. A widget that is gone says so in words.
   */
  private async withTurnstile<T>(
    zoneId: string,
    work: (api: CloudflareApi, cloudflareAccountId: string) => Promise<T>,
  ): Promise<T> {
    const owner = await this.accountOfZone(zoneId);
    const cloudflareAccountId = this.zoneCloudflareAccounts.get(zoneId);
    if (!cloudflareAccountId) throw new Error(NO_CLOUDFLARE_ACCOUNT);
    return this.withAccount(owner, 'turnstile', async (api) => {
      try {
        return await work(api, cloudflareAccountId);
      } catch (error) {
        if (isNotFound(error)) throw new Error(WIDGET_GONE);
        throw error;
      }
    });
  }

  /**
   * Runs `work` with an account's token, for the length of the call. `permission` is the one the
   * call needs: a refusal names it in the error and marks it missing in that account's report.
   */
  private async withAccount<T>(
    accountId: string,
    permission: CloudflareAnyPermissionId | undefined,
    work: (api: CloudflareApi) => Promise<T>,
  ): Promise<T> {
    const stored = await this.deps.state.account(accountId);
    if (!stored) throw new Error(encodeCloudflareError('no-token', NO_TOKEN));
    if (this.deps.isLocked(stored.token.envelope))
      throw new Error(encodeCloudflareError('locked', LOCKED));
    let token: string;
    try {
      token = await this.deps.unseal(stored.token.envelope);
    } catch {
      throw new Error(encodeCloudflareError('locked', LOCKED));
    }
    try {
      return await work(this.api(token));
    } catch (error) {
      if (permission && isPermissionDenied(error) && isMainPermission(permission)) {
        await this.deps.state.markMissing(accountId, permission);
      }
      throw cloudflareFailure(error, token, permission);
    }
  }
}
