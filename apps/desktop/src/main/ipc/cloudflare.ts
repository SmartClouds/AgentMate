import type { IpcMainInvokeEvent } from 'electron';
import {
  CLOUDFLARE_RECORD_TYPES,
  isCloudflareId,
  recordProblem,
} from '../../shared/cloudflare/dns';
import { accessRuleTarget, buildRule } from '../../shared/cloudflare/rules';
import { checkPurgeUrls, PURGE_URL_LIMIT } from '../../shared/cloudflare/zone';
import type {
  CloudflareAccessMode,
  CloudflareAccessRuleInput,
  CloudflareCustomRuleInput,
  CloudflarePointDomainInput,
  CloudflarePurgeRequest,
  CloudflareRecordInput,
  CloudflareRecordType,
  CloudflareRuleSpec,
  CloudflareSaveTokenInput,
  CloudflareSettingChange,
} from '../../shared/cloudflareTypes';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareService } from '../deploy/cloudflare/service';

/**
 * The Cloudflare dialog's invoke channels. Like the rest of Deploy they answer only the app's main
 * window, since browser tabs and webviews share the preload. Every argument is checked here, with
 * the same rules the page uses as the user types, before the service (and the token) sees it.
 */

export interface CloudflareIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface CloudflareHandlerDeps {
  ipc: CloudflareIpcRegistry;
  service: CloudflareService;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOKEN = 1024;
const MAX_LABEL = 200;
const MAX_NAME = 253;
const MAX_TEXT = 4096;
const MAX_NOTES = 500;
const MAX_LIST = 250;
const SETTING_VALUES: Record<CloudflareSettingChange['setting'], readonly string[]> = {
  developmentMode: ['on', 'off'],
  securityLevel: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
  ssl: ['off', 'flexible', 'full', 'strict'],
  alwaysUseHttps: ['on', 'off'],
};
const ACCESS_MODES: ReadonlySet<string> = new Set<CloudflareAccessMode>([
  'block',
  'challenge',
  'js_challenge',
  'managed_challenge',
  'whitelist',
]);

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${what}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`The ${what} must be text.`);
  return value;
}

function number(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The ${what} must be a number.`);
  }
  return value;
}

function flag(value: unknown, question: string): boolean {
  if (typeof value !== 'boolean') throw new Error(question);
  return value;
}

function list(value: unknown, max: number, what: string): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`The ${what} must be a list.`);
  return value.map((item) => text(item, 64, what));
}

function zoneId(value: unknown): string {
  if (!isCloudflareId(value)) throw new Error('That is not a Cloudflare zone.');
  return value;
}

function itemId(value: unknown, what: string): string {
  if (!isCloudflareId(value)) throw new Error(`That is not a Cloudflare ${what}.`);
  return value;
}

function token(value: unknown): string {
  return text(value, MAX_TOKEN, 'token').trim();
}

function accountId(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) {
    throw new Error('That is not a connected Cloudflare account.');
  }
  return value;
}

function saveInput(value: unknown): CloudflareSaveTokenInput {
  const input = object(value, 'a token');
  return {
    token: token(input.token),
    ...(input.accountId === undefined ? {} : { accountId: accountId(input.accountId) }),
    ...(input.label === undefined ? {} : { label: text(input.label, MAX_LABEL, 'name') }),
  };
}

function recordInput(value: unknown): CloudflareRecordInput {
  const input = object(value, 'a DNS record');
  if (typeof input.type !== 'string' || !CLOUDFLARE_RECORD_TYPES.includes(input.type as never)) {
    throw new Error('Runova edits A, AAAA, CNAME, TXT, MX, CAA and SRV records.');
  }
  const type = input.type as CloudflareRecordType;
  const name = text(input.name, MAX_NAME, 'record name');
  const ttl = number(input.ttl, 'TTL');
  let record: CloudflareRecordInput;
  if (type === 'A' || type === 'AAAA' || type === 'CNAME') {
    const proxied = flag(input.proxied, 'Say whether the record goes through the proxy.');
    record = { type, name, content: text(input.content, MAX_NAME, 'content'), ttl, proxied };
  } else if (type === 'TXT') {
    record = { type, name, content: text(input.content, MAX_TEXT, 'content'), ttl };
  } else if (type === 'MX') {
    const priority = number(input.priority, 'priority');
    record = { type, name, content: text(input.content, MAX_NAME, 'mail server'), priority, ttl };
  } else if (type === 'CAA') {
    const caa = object(input.caa, 'the CAA details');
    record = {
      type,
      name,
      ttl,
      caa: {
        flags: number(caa.flags, 'flags value'),
        tag: text(caa.tag, 16, 'tag') as 'issue',
        value: text(caa.value, 255, 'value'),
      },
    };
  } else {
    const srv = object(input.srv, 'the SRV details');
    record = {
      type,
      name,
      ttl,
      srv: {
        priority: number(srv.priority, 'priority'),
        weight: number(srv.weight, 'weight'),
        port: number(srv.port, 'port'),
        target: text(srv.target, MAX_NAME, 'target'),
      },
    };
  }
  if (input.comment !== undefined && input.comment !== null) {
    record.comment = text(input.comment, MAX_NOTES, 'comment');
  }
  const problem = recordProblem(record);
  if (problem) throw new Error(problem);
  return record;
}

function settingChange(value: unknown): CloudflareSettingChange {
  const input = object(value, 'a setting');
  const allowed = SETTING_VALUES[input.setting as CloudflareSettingChange['setting']];
  if (!allowed || typeof input.value !== 'string' || !allowed.includes(input.value)) {
    throw new Error('That is not a setting the page changes, or not one of its values.');
  }
  return { setting: input.setting, value: input.value } as CloudflareSettingChange;
}

function purgeRequest(value: unknown): CloudflarePurgeRequest {
  const input = object(value, 'what to purge');
  if (input.everything === true) return { everything: true };
  if (!Array.isArray(input.urls) || input.urls.some((url) => typeof url !== 'string')) {
    throw new Error('Say what to purge: everything, or a list of URLs.');
  }
  if (input.urls.length > PURGE_URL_LIMIT) {
    throw new Error(`Cloudflare purges up to ${PURGE_URL_LIMIT} URLs at a time.`);
  }
  const checked = checkPurgeUrls(input.urls.join('\n'));
  if (!checked.ok) throw new Error(checked.problem);
  return { urls: checked.urls };
}

function ruleSpec(value: unknown): CloudflareRuleSpec {
  const input = object(value, 'a rule');
  if (input.kind === 'block-countries') {
    return { kind: 'block-countries', countries: list(input.countries, MAX_LIST, 'countries') };
  }
  if (input.kind === 'challenge-path') {
    if (input.match !== 'exact' && input.match !== 'prefix') {
      throw new Error('The path match must be exact or prefix.');
    }
    return { kind: 'challenge-path', path: text(input.path, 600, 'path'), match: input.match };
  }
  if (input.kind === 'allow-ips') {
    return { kind: 'allow-ips', ips: list(input.ips, MAX_LIST, 'addresses') };
  }
  throw new Error('That is not a rule the builder makes.');
}

function customRuleInput(value: unknown): CloudflareCustomRuleInput {
  const input = object(value, 'a custom rule');
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length === 0 || description.length > MAX_NOTES) {
    throw new Error('The rule needs a description of up to 500 characters.');
  }
  const spec = ruleSpec(input.spec);
  const built = buildRule(spec);
  if (!built.ok) throw new Error(built.problem);
  return { description, spec };
}

function accessRuleInput(value: unknown): CloudflareAccessRuleInput {
  const input = object(value, 'an access rule');
  if (typeof input.mode !== 'string' || !ACCESS_MODES.has(input.mode)) {
    throw new Error('That is not an access rule mode.');
  }
  const ruleValue = text(input.value, 64, 'value');
  const target = accessRuleTarget(ruleValue);
  if (!target.ok) throw new Error(target.problem);
  const notes = typeof input.notes === 'string' ? input.notes : '';
  if (notes.length > MAX_NOTES) throw new Error('Keep the notes under 500 characters.');
  return { mode: input.mode as CloudflareAccessMode, value: ruleValue, notes };
}

function pointDomainInput(value: unknown): CloudflarePointDomainInput {
  const input = object(value, 'what to point');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > MAX_NAME) throw new Error('Enter the name to point.');
  if (typeof input.serverId !== 'string' || !SERVER_ID.test(input.serverId)) {
    throw new Error('That is not a saved server.');
  }
  return {
    zoneId: zoneId(input.zoneId),
    name,
    serverId: input.serverId,
    includeWww: flag(input.includeWww, 'Say whether to point www too.'),
    proxied: flag(input.proxied, "Say whether to use Cloudflare's proxy."),
  };
}

export function registerCloudflareHandlers({ ipc, service, guard }: CloudflareHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Cloudflare is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.cloudflare.status, () => service.status());
  handle(IPC.cloudflare.saveToken, (value) => service.saveToken(saveInput(value)));
  handle(IPC.cloudflare.checkToken, (id) => service.checkToken(accountId(id)));
  handle(IPC.cloudflare.removeToken, (id) => service.removeToken(accountId(id)));
  handle(IPC.cloudflare.listZones, (id) => service.listZones(accountId(id)));
  handle(IPC.cloudflare.listRecords, (zone) => service.listRecords(zoneId(zone)));
  handle(IPC.cloudflare.createRecord, (zone, record) =>
    service.createRecord(zoneId(zone), recordInput(record)),
  );
  handle(IPC.cloudflare.updateRecord, (zone, id, record) =>
    service.updateRecord(zoneId(zone), itemId(id, 'record'), recordInput(record)),
  );
  handle(IPC.cloudflare.deleteRecord, (zone, id) =>
    service.deleteRecord(zoneId(zone), itemId(id, 'record')),
  );
  handle(IPC.cloudflare.zoneSettings, (zone) => service.zoneSettings(zoneId(zone)));
  handle(IPC.cloudflare.changeSetting, (zone, change) =>
    service.changeSetting(zoneId(zone), settingChange(change)),
  );
  handle(IPC.cloudflare.purgeCache, (zone, request) =>
    service.purgeCache(zoneId(zone), purgeRequest(request)),
  );
  handle(IPC.cloudflare.listCustomRules, (zone) => service.listCustomRules(zoneId(zone)));
  handle(IPC.cloudflare.createCustomRule, (zone, input) =>
    service.createCustomRule(zoneId(zone), customRuleInput(input)),
  );
  handle(IPC.cloudflare.setCustomRuleEnabled, (zone, id, enabled) =>
    service.setCustomRuleEnabled(
      zoneId(zone),
      itemId(id, 'rule'),
      flag(enabled, 'Say whether the rule is on or off.'),
    ),
  );
  handle(IPC.cloudflare.deleteCustomRule, (zone, id) =>
    service.deleteCustomRule(zoneId(zone), itemId(id, 'rule')),
  );
  handle(IPC.cloudflare.listAccessRules, (zone) => service.listAccessRules(zoneId(zone)));
  handle(IPC.cloudflare.createAccessRule, (zone, input) =>
    service.createAccessRule(zoneId(zone), accessRuleInput(input)),
  );
  handle(IPC.cloudflare.deleteAccessRule, (zone, id) =>
    service.deleteAccessRule(zoneId(zone), itemId(id, 'access rule')),
  );
  handle(IPC.cloudflare.planPointDomain, (input) =>
    service.planPointDomain(pointDomainInput(input)),
  );
  handle(IPC.cloudflare.pointDomain, (input) => service.pointDomain(pointDomainInput(input)));
}
