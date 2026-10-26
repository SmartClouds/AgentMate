import { normalizeTags, type SaveVaultEntryInput, VAULT_LIMITS } from './entries.js';
import { hostOf } from './url.js';

export type VaultImportFormat = 'runova' | 'chrome' | 'firefox' | 'bitwarden' | 'onePassword';

export const VAULT_IMPORT_FORMAT_LABELS: Record<VaultImportFormat, string> = {
  runova: 'Runova',
  chrome: 'Chrome or Edge',
  firefox: 'Firefox',
  bitwarden: 'Bitwarden',
  onePassword: '1Password',
};

export const GENERIC_COLUMN_TARGETS = [
  'title',
  'username',
  'password',
  'url',
  'notes',
  'tags',
  'totp',
  'favorite',
  'extra',
  'ignore',
] as const;

export type GenericColumnTarget = (typeof GENERIC_COLUMN_TARGETS)[number];

/** One target per column, in header order. `extra` columns are appended to the notes. */
export interface GenericMapping {
  columns: GenericColumnTarget[];
}

export interface ImportSkip {
  /** 1-based record number in the file, counting the header as row 1. */
  row: number;
  reason: string;
}

export interface ImportMapResult {
  entries: SaveVaultEntryInput[];
  skipped: ImportSkip[];
}

export const RUNOVA_CSV_COLUMNS = [
  'type',
  'title',
  'username',
  'password',
  'urls',
  'totp',
  'service',
  'key_id',
  'secret',
  'expires_at',
  'notes',
  'tags',
  'favorite',
  'fields',
] as const;

export const BITWARDEN_CSV_COLUMNS = [
  'folder',
  'favorite',
  'type',
  'name',
  'notes',
  'fields',
  'reprompt',
  'login_uri',
  'login_username',
  'login_password',
  'login_totp',
] as const;

const normalizeHeader = (header: string) => header.trim().toLowerCase();

const SIGNATURES: [VaultImportFormat, string[]][] = [
  ['runova', ['type', 'title', 'password', 'key_id', 'secret', 'fields']],
  ['bitwarden', ['folder', 'type', 'name', 'login_uri', 'login_username', 'login_password']],
  ['onePassword', ['title', 'url', 'username', 'password', 'otpauth']],
  ['firefox', ['url', 'username', 'password', 'httprealm']],
  ['chrome', ['name', 'url', 'username', 'password']],
];

export function detectImportFormat(headers: string[]): VaultImportFormat | null {
  const present = new Set(headers.map(normalizeHeader));
  for (const [format, required] of SIGNATURES) {
    if (required.every((column) => present.has(column))) return format;
  }
  return null;
}

const HEADER_HINTS: [GenericColumnTarget, RegExp][] = [
  ['title', /^(title|name|site|website|account|entry|item)$/],
  ['totp', /(totp|otp|2fa|mfa|authenticator)/],
  ['username', /(user(name)?|login|e-?mail)/],
  ['password', /(pass(word)?|secret|pwd)/],
  ['url', /(url|uri|link|domain|host|address)/],
  ['notes', /(note|comment|description|memo)/],
  ['tags', /(tag|folder|group|category|label)/],
  ['favorite', /(fav|favou?rite|starred)/],
];

export function suggestGenericMapping(headers: string[]): GenericMapping {
  const used = new Set<GenericColumnTarget>();
  return {
    columns: headers.map((header) => {
      const name = normalizeHeader(header);
      for (const [target, pattern] of HEADER_HINTS) {
        if (!used.has(target) && pattern.test(name)) {
          used.add(target);
          return target;
        }
      }
      return 'extra';
    }),
  };
}

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const isTruthy = (value: string) => /^(1|true|yes|y|x)$/i.test(value.trim());

function splitList(value: string, separators: RegExp): string[] {
  return value
    .split(separators)
    .map((part) => part.trim())
    .filter(Boolean);
}

function joinNotes(...parts: string[]): string {
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

interface LoginDraft {
  title: string;
  username: string;
  password: string;
  urls: string[];
  totp: string;
  notes: string;
  tags: string[];
  favorite: boolean;
}

function titleFor(draft: Pick<LoginDraft, 'title' | 'urls' | 'username'>): string {
  return draft.title.trim() || hostOf(draft.urls[0] ?? '') || draft.username.trim() || 'Untitled';
}

function toLogin(draft: LoginDraft): SaveVaultEntryInput {
  return {
    type: 'login',
    title: clip(titleFor(draft), VAULT_LIMITS.title),
    tags: normalizeTags(draft.tags.map((t) => clip(t, VAULT_LIMITS.tagLength))).slice(
      0,
      VAULT_LIMITS.tags,
    ),
    favorite: draft.favorite,
    notes: clip(draft.notes, VAULT_LIMITS.notes),
    username: clip(draft.username, VAULT_LIMITS.shortText),
    password: clip(draft.password, VAULT_LIMITS.secret),
    urls: draft.urls
      .map((u) => u.trim())
      .filter((u) => u && u.length <= VAULT_LIMITS.url)
      .slice(0, VAULT_LIMITS.urls),
    totpSecret: clip(draft.totp, VAULT_LIMITS.secret),
  };
}

function toNote(
  title: string,
  notes: string,
  tags: string[],
  favorite: boolean,
): SaveVaultEntryInput {
  return {
    type: 'note',
    title: clip(title.trim() || 'Untitled', VAULT_LIMITS.title),
    tags: normalizeTags(tags.map((t) => clip(t, VAULT_LIMITS.tagLength))).slice(
      0,
      VAULT_LIMITS.tags,
    ),
    favorite,
    notes: clip(notes, VAULT_LIMITS.notes),
  };
}

type Row = (column: string) => string;

function mapKnownRow(format: VaultImportFormat, get: Row): SaveVaultEntryInput | string {
  switch (format) {
    case 'chrome':
      return toLogin({
        title: get('name'),
        username: get('username'),
        password: get('password'),
        urls: [get('url')],
        totp: '',
        notes: get('note'),
        tags: [],
        favorite: false,
      });
    case 'firefox': {
      const realm = get('httprealm');
      return toLogin({
        title: '',
        username: get('username'),
        password: get('password'),
        urls: [get('url')],
        totp: '',
        notes: realm ? `HTTP realm: ${realm}` : '',
        tags: [],
        favorite: false,
      });
    }
    case 'bitwarden': {
      const type = get('type').trim().toLowerCase() || 'login';
      const notes = joinNotes(get('notes'), get('fields'));
      const tags = get('folder') ? [get('folder')] : [];
      const favorite = isTruthy(get('favorite'));
      if (type === 'note') return toNote(get('name'), notes, tags, favorite);
      if (type !== 'login') return `Unsupported item type "${type}"`;
      return toLogin({
        title: get('name'),
        username: get('login_username'),
        password: get('login_password'),
        urls: splitList(get('login_uri'), /,/),
        totp: get('login_totp'),
        notes,
        tags,
        favorite,
      });
    }
    case 'onePassword':
      return toLogin({
        title: get('title'),
        username: get('username'),
        password: get('password'),
        urls: [get('url')],
        totp: get('otpauth'),
        notes: get('notes'),
        tags: [
          ...splitList(get('tags'), /[;,]/),
          ...(isTruthy(get('archived')) ? ['Archived'] : []),
        ],
        favorite: isTruthy(get('favorite')),
      });
    case 'runova':
      return mapRunovaRow(get);
  }
}

function mapRunovaRow(get: Row): SaveVaultEntryInput | string {
  const shared = {
    title: clip(get('title').trim() || 'Untitled', VAULT_LIMITS.title),
    tags: normalizeTags(splitList(get('tags'), /\n/)).slice(0, VAULT_LIMITS.tags),
    favorite: isTruthy(get('favorite')),
    notes: clip(get('notes'), VAULT_LIMITS.notes),
  };
  const urls = splitList(get('urls'), /\n/).slice(0, VAULT_LIMITS.urls);
  switch (get('type').trim()) {
    case 'login':
      return {
        ...shared,
        type: 'login',
        username: clip(get('username'), VAULT_LIMITS.shortText),
        password: clip(get('password'), VAULT_LIMITS.secret),
        urls,
        totpSecret: clip(get('totp'), VAULT_LIMITS.secret),
      };
    case 'apiKey': {
      const expires = Date.parse(get('expires_at'));
      return {
        ...shared,
        type: 'apiKey',
        service: clip(get('service'), VAULT_LIMITS.shortText),
        keyId: clip(get('key_id'), VAULT_LIMITS.shortText),
        secret: clip(get('secret'), VAULT_LIMITS.secret),
        urls,
        expiresAt: Number.isNaN(expires) ? null : expires,
      };
    }
    case 'note':
      return { ...shared, type: 'note' };
    case 'custom': {
      let fields: unknown;
      try {
        fields = JSON.parse(get('fields') || '[]');
      } catch {
        return 'The fields column is not valid JSON';
      }
      if (!Array.isArray(fields)) return 'The fields column is not a list';
      return {
        ...shared,
        type: 'custom',
        fields: fields.slice(0, VAULT_LIMITS.customFields).map((field) => ({
          label: clip(String(field?.label ?? '').trim() || 'Field', VAULT_LIMITS.fieldLabel),
          value: clip(String(field?.value ?? ''), VAULT_LIMITS.secret),
          concealed: field?.concealed !== false,
        })),
      };
    }
    default:
      return `Unsupported item type "${get('type')}"`;
  }
}

function mapGenericRow(
  cells: string[],
  headers: string[],
  mapping: GenericMapping,
): SaveVaultEntryInput {
  const values: Record<Exclude<GenericColumnTarget, 'extra' | 'ignore'>, string> = {
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    tags: '',
    totp: '',
    favorite: '',
  };
  const extras: string[] = [];
  mapping.columns.forEach((target, index) => {
    const value = cells[index] ?? '';
    if (target === 'ignore') return;
    if (target === 'extra') {
      if (value.trim()) extras.push(`${headers[index]?.trim() || `Column ${index + 1}`}: ${value}`);
      return;
    }
    if (!values[target]) values[target] = value;
  });
  const notes = joinNotes(values.notes, extras.join('\n'));
  const tags = splitList(values.tags, /[;,]/);
  const favorite = isTruthy(values.favorite);
  if (!values.username && !values.password && !values.url && !values.totp) {
    return toNote(values.title, notes, tags, favorite);
  }
  return toLogin({
    title: values.title,
    username: values.username,
    password: values.password,
    urls: [values.url],
    totp: values.totp,
    notes,
    tags,
    favorite,
  });
}

/**
 * Turns parsed CSV rows (header first) into save inputs. Rows that can't be imported are
 * reported with a reason instead of failing the whole file.
 */
export function mapImportRows(
  rows: string[][],
  format: VaultImportFormat | GenericMapping,
): ImportMapResult {
  const result: ImportMapResult = { entries: [], skipped: [] };
  if (rows.length === 0) return result;
  const [headers, ...records] = rows;
  const index = new Map(headers.map((h, i) => [normalizeHeader(h), i] as const));

  records.forEach((cells, i) => {
    const row = i + 2;
    if (cells.every((cell) => cell.trim() === '')) {
      result.skipped.push({ row, reason: 'Empty row' });
      return;
    }
    const mapped =
      typeof format === 'string'
        ? mapKnownRow(format, (column) => {
            const at = index.get(column);
            return at === undefined ? '' : (cells[at] ?? '');
          })
        : mapGenericRow(cells, headers, format);
    if (typeof mapped === 'string') result.skipped.push({ row, reason: mapped });
    else result.entries.push(mapped);
  });
  return result;
}
