import { isAbsolute } from 'node:path';
import {
  type AgentType,
  isValidWpSlug,
  type ProjectWordPressItemKind,
  validateWpItemPath,
  WP_IGNORE_MAX_LINE,
  WP_IGNORE_MAX_LINES,
  WP_KEY_PREFIX,
  type WpItemRef,
  wpItemKey,
} from '@agentmat/core';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  DeployWordPressAuditQuery,
  DeployWordPressConnectInput,
  DeployWordPressCreateProjectInput,
  DeployWordPressDeployResult,
  DeployWordPressDisconnectInput,
  DeployWordPressHttpAuth,
  DeployWordPressIgnoreInput,
  DeployWordPressItemsInput,
  DeployWordPressLinkProjectInput,
  DeployWordPressLinkProjectResult,
  DeployWordPressLocalChanges,
  DeployWordPressLocalItem,
  DeployWordPressPlan,
  DeployWordPressPlanInput,
  DeployWordPressPullResult,
  DeployWordPressRemoteFile,
  DeployWordPressRemoteFileInput,
  DeployWordPressRollbackInput,
  DeployWordPressRunInput,
  DeployWordPressSaveZipResult,
  DeployWordPressSettingsInput,
  DeployWordPressSite,
  DeployWordPressSiteInfo,
  DeployWordPressUpdateConnectorResult,
  Project,
  WpAuditEntry,
  WpDeployRecord,
  WpItem,
} from '../../shared/deployWordPressTypes';
import { IPC } from '../../shared/ipcChannels';
import { wordPressError } from '../../shared/wordpressErrors';
import { type DeployIpcRegistry, object } from './deploy';

/**
 * The WordPress side of Deploy (E19 to E21). Like every Deploy group these channels answer only
 * the main window's own frame, and every argument is checked here before the service sees it.
 *
 * A connection key and an HTTP password come in through `connect` and `updateSettings` and go no
 * further than the service: no message thrown from here ever holds one, and an error from the
 * service that somehow does is replaced before it crosses back to the renderer.
 */

/** What the handlers call. The real one is WordPressService (deploy/wordpress/service.ts). */
export interface DeployWordPressApi {
  listSites(): Promise<DeployWordPressSite[]>;
  connect(input: DeployWordPressConnectInput): Promise<DeployWordPressSite>;
  disconnect(input: DeployWordPressDisconnectInput): Promise<void>;
  updateSettings(input: DeployWordPressSettingsInput): Promise<DeployWordPressSite>;
  siteInfo(siteId: string): Promise<DeployWordPressSiteInfo>;
  listItems(siteId: string): Promise<WpItem[]>;
  history(siteId: string): Promise<WpDeployRecord[]>;
  rollback(input: DeployWordPressRollbackInput): Promise<DeployWordPressDeployResult>;
  audit(query: DeployWordPressAuditQuery): Promise<WpAuditEntry[]>;
  planPull(input: DeployWordPressPlanInput): Promise<DeployWordPressPlan>;
  pull(input: DeployWordPressRunInput): Promise<DeployWordPressPullResult>;
  planDeploy(input: DeployWordPressPlanInput): Promise<DeployWordPressPlan>;
  deploy(input: DeployWordPressRunInput): Promise<DeployWordPressDeployResult>;
  cancel(operationId: string): Promise<void>;
  createProject(input: DeployWordPressCreateProjectInput): Promise<Project>;
  setProjectItems(input: DeployWordPressItemsInput): Promise<Project>;
  setProjectIgnore(input: DeployWordPressIgnoreInput): Promise<Project>;
  localItems(projectId: string): Promise<DeployWordPressLocalItem[]>;
  linkProject(input: DeployWordPressLinkProjectInput): Promise<DeployWordPressLinkProjectResult>;
  unlinkProject(projectId: string): Promise<Project>;
  localChanges(projectId: string): Promise<DeployWordPressLocalChanges>;
  remoteFile(input: DeployWordPressRemoteFileInput): Promise<DeployWordPressRemoteFile>;
  saveConnectorZip(): Promise<DeployWordPressSaveZipResult>;
  updateConnector(siteId: string): Promise<DeployWordPressUpdateConnectorResult>;
}

export interface DeployWordPressHandlerDeps {
  ipc: DeployIpcRegistry;
  service: DeployWordPressApi;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

/** Site ids are minted here (randomUUID); projectLink.ts holds links to the same shape. */
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Ids the app's own records use (projects), and plan ids. */
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Picked by the renderer (crypto.randomUUID), so progress can be matched before a call returns. */
const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** The plugin's deploy ids. */
const DEPLOY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;
const KINDS: ReadonlySet<string> = new Set<ProjectWordPressItemKind>([
  'theme',
  'plugin',
  'mu-plugin',
]);
const AGENT_TYPES: ReadonlySet<string> = new Set<AgentType>([
  'claude-code',
  'gemini',
  'opencode',
  'codex',
  'cursor',
  'generic',
]);

const MIN_KEY = 20;
const MAX_KEY = 4096;
/** What a pasted key may hold before its line wrapping is dropped. */
const MAX_KEY_RAW = 16_384;
const MAX_LABEL = 100;
const MAX_USER = 255;
const MAX_PASSWORD = 1024;
const MAX_ITEMS = 200;
/** Every item, plus a project's items. */
const MAX_IGNORE_KEYS = MAX_ITEMS + 1;
/** `mu-plugin:` and a slug of at most 100 characters. */
const MAX_IGNORE_KEY = 120;
const MAX_AUDIT = 500;
const MAX_RESOLUTIONS = 20_000;
const MAX_RESOLUTION_KEY = 700;
const MAX_FOLDER = 1024;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 4000;
const MAX_TAGS = 50;
const MAX_TAG = 64;

function siteId(value: unknown): string {
  if (typeof value !== 'string' || !SITE_ID.test(value)) {
    throw new Error('That is not a connected WordPress site.');
  }
  return value;
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID.test(value))
    throw new Error('That is not a project.');
  return value;
}

function planId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID.test(value)) {
    throw new Error('That is not a plan. Review the changes again.');
  }
  return value;
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) {
    throw new Error('Each run needs an operation id of 8 to 128 letters, digits, - or _.');
  }
  return value;
}

function deployId(value: unknown): string {
  if (typeof value !== 'string' || !DEPLOY_ID.test(value)) {
    throw new Error('That is not a deploy on this site.');
  }
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say whether to ${what}.`);
  return value;
}

function optionalFlag(value: unknown, what: string): boolean | undefined {
  return value === undefined ? undefined : flag(value, what);
}

/** One line of text, trimmed, with no control characters. */
function line(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw new Error(`The ${what} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed)) {
    throw new Error(`The ${what} must be 1 to ${max} characters on one line.`);
  }
  return trimmed;
}

function optionalLine(value: unknown, max: number, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return line(value, max, what);
}

/**
 * The pasted key, with the line breaks wrapping added dropped. Only its length and prefix are
 * checked here (pairing.ts reads the rest), and no message ever repeats it.
 */
function connectionKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_KEY_RAW) {
    throw wordPressError(
      'keyInvalid',
      'Paste the whole connection key from AgentMate Connector in wp-admin.',
    );
  }
  const compact = value.replace(/\s+/g, '');
  if (compact.length < MIN_KEY || compact.length > MAX_KEY || !compact.startsWith(WP_KEY_PREFIX)) {
    throw wordPressError(
      'keyInvalid',
      `That is not a connection key. Copy the whole key from AgentMate Connector in wp-admin; it starts with ${WP_KEY_PREFIX}`,
    );
  }
  return compact;
}

function httpAuth(value: unknown): DeployWordPressHttpAuth {
  const input = object(value, 'an HTTP sign-in');
  const { username, password } = input;
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username.length > MAX_USER ||
    username.includes(':') ||
    CONTROL.test(username)
  ) {
    throw new Error(`The HTTP user name must be 1 to ${MAX_USER} characters, without a colon.`);
  }
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD ||
    /[\r\n\0]/.test(password)
  ) {
    throw new Error('Enter the HTTP password, on one line.');
  }
  return { username, password };
}

function item(value: unknown): WpItemRef {
  const input = object(value, 'a theme or plugin');
  if (typeof input.kind !== 'string' || !KINDS.has(input.kind)) {
    throw new Error('An item is a theme, a plugin or a must-use plugin.');
  }
  if (typeof input.slug !== 'string' || !isValidWpSlug(input.slug)) {
    throw new Error('That theme or plugin folder name is not one AgentMate can sync.');
  }
  return { kind: input.kind as ProjectWordPressItemKind, slug: input.slug };
}

/** At least one item, at most MAX_ITEMS, duplicates folded. */
function items(value: unknown): WpItemRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    throw new Error(`Pick 1 to ${MAX_ITEMS} themes or plugins.`);
  }
  const seen = new Set<string>();
  const out: WpItemRef[] = [];
  for (const entry of value) {
    const ref = item(entry);
    const key = wpItemKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function connectInput(value: unknown): DeployWordPressConnectInput {
  const input = object(value, 'a connection key');
  const key = connectionKey(input.connectionKey);
  const label = optionalLine(input.label, MAX_LABEL, 'name');
  const allowPlainHttp = optionalFlag(input.allowPlainHttp, 'allow plain HTTP');
  return {
    connectionKey: key,
    ...(label === undefined ? {} : { label }),
    ...(allowPlainHttp === undefined ? {} : { allowPlainHttp }),
    ...(input.httpAuth === undefined || input.httpAuth === null
      ? {}
      : { httpAuth: httpAuth(input.httpAuth) }),
  };
}

function disconnectInput(value: unknown): DeployWordPressDisconnectInput {
  const input = object(value, 'a site to disconnect');
  return {
    siteId: siteId(input.siteId),
    revokeOnSite: flag(input.revokeOnSite, 'revoke the connection on the site too'),
  };
}

function settingsInput(value: unknown): DeployWordPressSettingsInput {
  const input = object(value, 'site settings');
  const label = optionalLine(input.label, MAX_LABEL, 'name');
  const allowPlainHttp = optionalFlag(input.allowPlainHttp, 'allow plain HTTP');
  return {
    siteId: siteId(input.siteId),
    ...(label === undefined ? {} : { label }),
    ...(allowPlainHttp === undefined ? {} : { allowPlainHttp }),
    ...(input.httpAuth === undefined
      ? {}
      : { httpAuth: input.httpAuth === null ? null : httpAuth(input.httpAuth) }),
  };
}

function rollbackInput(value: unknown): DeployWordPressRollbackInput {
  const input = object(value, 'a rollback');
  const force = optionalFlag(input.force, 'force the rollback');
  return {
    operationId: operationId(input.operationId),
    siteId: siteId(input.siteId),
    deployId: deployId(input.deployId),
    ...(force === undefined ? {} : { force }),
  };
}

function auditQuery(value: unknown): DeployWordPressAuditQuery {
  const input = object(value, 'an audit query');
  const { limit, before } = input;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_AUDIT) {
    throw new Error(`Ask for 1 to ${MAX_AUDIT} audit entries.`);
  }
  if (before !== undefined && (!Number.isSafeInteger(before) || (before as number) < 1)) {
    throw new Error('That is not an audit entry.');
  }
  return {
    siteId: siteId(input.siteId),
    limit: limit as number,
    ...(before === undefined ? {} : { before: before as number }),
  };
}

function planInput(value: unknown): DeployWordPressPlanInput {
  const input = object(value, 'what to compare');
  return {
    projectId: projectId(input.projectId),
    ...(input.items === undefined ? {} : { items: items(input.items) }),
  };
}

function resolutions(value: unknown): Record<string, 'keepLocal' | 'takeRemote'> {
  const input = object(value, 'conflict choices');
  const entries = Object.entries(input);
  if (entries.length > MAX_RESOLUTIONS) throw new Error('Too many conflict choices.');
  const out: Record<string, 'keepLocal' | 'takeRemote'> = {};
  for (const [key, choice] of entries) {
    if (key.length === 0 || key.length > MAX_RESOLUTION_KEY || CONTROL.test(key)) {
      throw new Error('One of the conflict choices names no file.');
    }
    if (choice !== 'keepLocal' && choice !== 'takeRemote') {
      throw new Error('Each conflict is kept as it is here or taken from the site.');
    }
    out[key] = choice;
  }
  return out;
}

function runInput(value: unknown): DeployWordPressRunInput {
  const input = object(value, 'a run');
  return {
    planId: planId(input.planId),
    operationId: operationId(input.operationId),
    force: flag(input.force, 'go ahead over conflicts'),
    ...(input.resolutions === undefined ? {} : { resolutions: resolutions(input.resolutions) }),
  };
}

function folderPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_FOLDER ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    throw new Error('Pick a folder for the project.');
  }
  return value;
}

function tags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new Error(`A project has at most ${MAX_TAGS} tags.`);
  }
  return value.map((tag) => line(tag, MAX_TAG, 'tag'));
}

function createProjectInput(value: unknown): DeployWordPressCreateProjectInput {
  const input = object(value, 'a new WordPress project');
  if (typeof input.agentType !== 'string' || !AGENT_TYPES.has(input.agentType)) {
    throw new Error('Pick the agent this project works with.');
  }
  let description: string | undefined;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION) {
      throw new Error(`A description is text of at most ${MAX_DESCRIPTION} characters.`);
    }
    description = input.description;
  }
  const projectTags = tags(input.tags);
  return {
    operationId: operationId(input.operationId),
    siteId: siteId(input.siteId),
    items: items(input.items),
    folderPath: folderPath(input.folderPath),
    name: line(input.name, MAX_NAME, 'project name'),
    agentType: input.agentType as AgentType,
    ...(description === undefined ? {} : { description }),
    ...(projectTags === undefined ? {} : { tags: projectTags }),
  };
}

/** The items a caller says the site does not have yet; none given, or an empty list, is none. */
function newItems(value: unknown): { newItems?: WpItemRef[] } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  return { newItems: items(value) };
}

function itemsInput(value: unknown): DeployWordPressItemsInput {
  const input = object(value, 'the project items');
  return {
    operationId: operationId(input.operationId),
    projectId: projectId(input.projectId),
    ...(input.siteId === undefined ? {} : { siteId: siteId(input.siteId) }),
    items: items(input.items),
    ...newItems(input.newItems),
  };
}

/**
 * The saved ignore list: keys are `*` or an item (`theme:slug`), each with lines of text. Only its
 * shape is checked here; the service reads the lines against the project's items and the matcher.
 */
function ignoreInput(value: unknown): DeployWordPressIgnoreInput {
  const input = object(value, 'the ignore list');
  const list = object(input.ignore, 'the ignore list');
  const entries = Object.entries(list);
  if (entries.length > MAX_IGNORE_KEYS)
    throw new Error('That is too many items to ignore files in.');
  const ignore: Record<string, string[]> = {};
  for (const [key, lines] of entries) {
    if (key.length === 0 || key.length > MAX_IGNORE_KEY || CONTROL.test(key)) {
      throw new Error('An ignore list belongs to every item or to one theme or plugin.');
    }
    if (!Array.isArray(lines) || lines.length > WP_IGNORE_MAX_LINES) {
      throw new Error(`An item can ignore at most ${WP_IGNORE_MAX_LINES} lines.`);
    }
    ignore[key] = lines.map((entry) => {
      if (typeof entry !== 'string' || entry.length > WP_IGNORE_MAX_LINE || CONTROL.test(entry)) {
        throw new Error(
          `An ignore line is text on one line, at most ${WP_IGNORE_MAX_LINE} characters.`,
        );
      }
      return entry;
    });
  }
  return { projectId: projectId(input.projectId), ignore };
}

function linkProjectInput(value: unknown): DeployWordPressLinkProjectInput {
  const input = object(value, 'the project link');
  return {
    operationId: operationId(input.operationId),
    projectId: projectId(input.projectId),
    siteId: siteId(input.siteId),
    items: items(input.items),
    ...newItems(input.newItems),
  };
}

function remoteFileInput(value: unknown): DeployWordPressRemoteFileInput {
  const input = object(value, 'a site file');
  const path = input.path;
  if (typeof path !== 'string' || !validateWpItemPath(path).ok) {
    throw new Error('That file path is not one AgentMate syncs.');
  }
  return { projectId: projectId(input.projectId), item: item(input.item), path };
}

/**
 * Replaces an error whose message holds one of the call's secrets. The service never puts one
 * there; this is the last line in case a dependency echoes its input.
 */
function scrub(error: unknown, secrets: readonly string[]): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const leaks = secrets.some((secret) => secret.length >= 4 && message.includes(secret));
  if (!leaks) return error;
  return wordPressError(
    'internal',
    'Something went wrong with that site. The details were left out because they held a secret.',
  );
}

async function guarded<T>(secrets: readonly string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw scrub(error, secrets);
  }
}

function secretsOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const input = value as { connectionKey?: unknown; httpAuth?: unknown };
  const out: string[] = [];
  if (typeof input.connectionKey === 'string') {
    out.push(input.connectionKey, input.connectionKey.replace(/\s+/g, ''));
    // The key body (after the prefix) carries the pairing secret, so any long run of it counts.
    const body = input.connectionKey.replace(/\s+/g, '').slice(WP_KEY_PREFIX.length);
    if (body.length >= 32) out.push(body.slice(0, 32), body.slice(-32));
  }
  if (typeof input.httpAuth === 'object' && input.httpAuth !== null) {
    const password = (input.httpAuth as { password?: unknown }).password;
    if (typeof password === 'string') out.push(password);
  }
  return out;
}

export function registerDeployWordPressHandlers({
  ipc,
  service,
  guard,
}: DeployWordPressHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => Promise<unknown>) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Deploy is only available in the main window.');
      // Checked before any work, and scrubbed after it, for the calls that carry a secret.
      const secrets = args.flatMap(secretsOf);
      return guarded(secrets, () => run(...args));
    });
  };

  handle(IPC.deployWordPress.listSites, () => service.listSites());
  handle(IPC.deployWordPress.connect, async (input) => service.connect(connectInput(input)));
  handle(IPC.deployWordPress.disconnect, async (input) =>
    service.disconnect(disconnectInput(input)),
  );
  handle(IPC.deployWordPress.updateSettings, async (input) =>
    service.updateSettings(settingsInput(input)),
  );
  handle(IPC.deployWordPress.siteInfo, async (id) => service.siteInfo(siteId(id)));
  handle(IPC.deployWordPress.listItems, async (id) => service.listItems(siteId(id)));
  handle(IPC.deployWordPress.history, async (id) => service.history(siteId(id)));
  handle(IPC.deployWordPress.rollback, async (input) => service.rollback(rollbackInput(input)));
  handle(IPC.deployWordPress.audit, async (query) => service.audit(auditQuery(query)));
  handle(IPC.deployWordPress.planPull, async (input) => service.planPull(planInput(input)));
  handle(IPC.deployWordPress.pull, async (input) => service.pull(runInput(input)));
  handle(IPC.deployWordPress.planDeploy, async (input) => service.planDeploy(planInput(input)));
  handle(IPC.deployWordPress.deploy, async (input) => service.deploy(runInput(input)));
  handle(IPC.deployWordPress.cancel, async (id) => service.cancel(operationId(id)));
  handle(IPC.deployWordPress.createProject, async (input) =>
    service.createProject(createProjectInput(input)),
  );
  handle(IPC.deployWordPress.setProjectItems, async (input) =>
    service.setProjectItems(itemsInput(input)),
  );
  handle(IPC.deployWordPress.setProjectIgnore, async (input) =>
    service.setProjectIgnore(ignoreInput(input)),
  );
  handle(IPC.deployWordPress.localItems, async (id) => service.localItems(projectId(id)));
  handle(IPC.deployWordPress.linkProject, async (input) =>
    service.linkProject(linkProjectInput(input)),
  );
  handle(IPC.deployWordPress.unlinkProject, async (id) => service.unlinkProject(projectId(id)));
  handle(IPC.deployWordPress.localChanges, async (id) => service.localChanges(projectId(id)));
  handle(IPC.deployWordPress.remoteFile, async (input) =>
    service.remoteFile(remoteFileInput(input)),
  );
  handle(IPC.deployWordPress.saveConnectorZip, () => service.saveConnectorZip());
  handle(IPC.deployWordPress.updateConnector, async (id) => service.updateConnector(siteId(id)));
}
