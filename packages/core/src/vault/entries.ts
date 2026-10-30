import { z } from 'zod';
import { VAULT_CATEGORY_LIMITS, VaultCategorySchema } from './categories.js';
import { normalizeUrl } from './url.js';

export const VAULT_ENTRY_TYPES = ['login', 'apiKey', 'note', 'custom'] as const;
export type VaultEntryType = (typeof VAULT_ENTRY_TYPES)[number];

export const VAULT_LIMITS = {
  entries: 20_000,
  id: 64,
  title: 200,
  shortText: 1024,
  url: 2048,
  urls: 20,
  tags: 20,
  tagLength: 40,
  customFields: 50,
  fieldLabel: 100,
  secret: 64 * 1024,
  notes: 64 * 1024,
  /** A 64px site icon as a data URL. Small on purpose: it lives inside the encrypted payload. */
  icon: 48 * 1024,
} as const;

const id = z.string().min(1).max(VAULT_LIMITS.id);
const timestamp = z.number().int().nonnegative();
const shortText = z.string().max(VAULT_LIMITS.shortText);
const secret = z.string().max(VAULT_LIMITS.secret);
const urls = z.array(z.string().min(1).max(VAULT_LIMITS.url)).max(VAULT_LIMITS.urls);
const icon = z
  .string()
  .max(VAULT_LIMITS.icon)
  .regex(/^data:image\/[a-z0-9.+-]+[;,]/i);

const baseShape = {
  id,
  title: z.string().min(1).max(VAULT_LIMITS.title),
  tags: z.array(z.string().min(1).max(VAULT_LIMITS.tagLength)).max(VAULT_LIMITS.tags),
  favorite: z.boolean(),
  notes: z.string().max(VAULT_LIMITS.notes),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  /** The site's favicon, fetched once from the editor and kept here so listing never goes online. */
  icon: icon.optional(),
  /** The category the entry is filed under. Missing means no category. */
  categoryId: id.optional(),
};

export const VaultCustomFieldSchema = z.object({
  id,
  label: z.string().min(1).max(VAULT_LIMITS.fieldLabel),
  value: secret,
  concealed: z.boolean(),
});

export const VaultEntrySchema = z.discriminatedUnion('type', [
  z.object({
    ...baseShape,
    type: z.literal('login'),
    username: shortText,
    password: secret,
    urls,
    totpSecret: secret,
    passwordUpdatedAt: timestamp.nullable(),
    /** Press the site's sign-in button after a one-click login fills the form. Missing means off. */
    autoSubmit: z.boolean().optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal('apiKey'),
    service: shortText,
    keyId: shortText,
    secret,
    urls,
    expiresAt: timestamp.nullable(),
  }),
  z.object({ ...baseShape, type: z.literal('note') }),
  z.object({
    ...baseShape,
    type: z.literal('custom'),
    fields: z.array(VaultCustomFieldSchema).max(VAULT_LIMITS.customFields),
  }),
]);

export type VaultEntry = z.infer<typeof VaultEntrySchema>;
export type VaultCustomField = z.infer<typeof VaultCustomFieldSchema>;
export type VaultEntryOf<T extends VaultEntryType> = Extract<VaultEntry, { type: T }>;

export const VaultPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: timestamp,
  entries: z.array(VaultEntrySchema).max(VAULT_LIMITS.entries),
  /** Missing in vaults written before categories existed. */
  categories: z.array(VaultCategorySchema).max(VAULT_CATEGORY_LIMITS.categories).default([]),
});

/** As stored. A vault written before categories existed has none, so they are optional here. */
export type VaultPayload = z.input<typeof VaultPayloadSchema>;

/**
 * What the editor sends back. A secret left `undefined` keeps the stored value, so the renderer
 * never has to hold a password it didn't change. An empty string clears it.
 */
const saveBaseShape = {
  id: id.optional(),
  title: z.string().max(VAULT_LIMITS.title),
  tags: z.array(z.string().max(VAULT_LIMITS.tagLength)).max(VAULT_LIMITS.tags * 2),
  favorite: z.boolean(),
  notes: z.string().max(VAULT_LIMITS.notes).optional(),
  /** Undefined keeps the stored icon, null removes it. */
  icon: icon.nullable().optional(),
  /** Undefined keeps the stored category, null takes the entry out of it. */
  categoryId: id.nullable().optional(),
};

export const SaveVaultEntryInputSchema = z.discriminatedUnion('type', [
  z.object({
    ...saveBaseShape,
    type: z.literal('login'),
    username: shortText.optional(),
    password: secret.optional(),
    urls: z
      .array(z.string().max(VAULT_LIMITS.url))
      .max(VAULT_LIMITS.urls * 2)
      .optional(),
    totpSecret: secret.optional(),
    autoSubmit: z.boolean().optional(),
  }),
  z.object({
    ...saveBaseShape,
    type: z.literal('apiKey'),
    service: shortText.optional(),
    keyId: shortText.optional(),
    secret: secret.optional(),
    urls: z
      .array(z.string().max(VAULT_LIMITS.url))
      .max(VAULT_LIMITS.urls * 2)
      .optional(),
    expiresAt: timestamp.nullable().optional(),
  }),
  z.object({ ...saveBaseShape, type: z.literal('note') }),
  z.object({
    ...saveBaseShape,
    type: z.literal('custom'),
    fields: z
      .array(
        z.object({
          id: id.optional(),
          label: z.string().max(VAULT_LIMITS.fieldLabel),
          value: secret.optional(),
          concealed: z.boolean(),
        }),
      )
      .max(VAULT_LIMITS.customFields),
  }),
]);

export type SaveVaultEntryInput = z.infer<typeof SaveVaultEntryInputSchema>;

/** Which single value a reveal or copy asks for. */
export type VaultFieldRef =
  | 'username'
  | 'password'
  | 'totpSecret'
  | 'secret'
  | 'keyId'
  | 'notes'
  | 'url'
  | { customFieldId: string };

export const VaultFieldRefSchema = z.union([
  z.enum(['username', 'password', 'totpSecret', 'secret', 'keyId', 'notes', 'url']),
  z.object({ customFieldId: id }),
]);

export interface EntryClock {
  now: number;
  newId: () => string;
}

/** Trims, drops blanks and removes duplicates that differ only in case. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function normalizeUrls(values: string[]): string[] {
  return values.map(normalizeUrl).filter(Boolean);
}

/** Builds the stored entry from what the editor sent, keeping secrets it left undefined. */
export function applySaveInput(
  existing: VaultEntry | undefined,
  input: SaveVaultEntryInput,
  clock: EntryClock,
): VaultEntry {
  if (existing && existing.type !== input.type) {
    throw new Error("An entry can't change its type. Create a new entry instead.");
  }
  if (existing && input.id && input.id !== existing.id) {
    throw new Error('The entry id does not match.');
  }
  const icon = input.icon === undefined ? existing?.icon : (input.icon ?? undefined);
  const categoryId =
    input.categoryId === undefined ? existing?.categoryId : (input.categoryId ?? undefined);
  const base = {
    id: existing?.id ?? clock.newId(),
    title: input.title.trim(),
    tags: normalizeTags(input.tags),
    favorite: input.favorite,
    notes: input.notes ?? existing?.notes ?? '',
    createdAt: existing?.createdAt ?? clock.now,
    updatedAt: clock.now,
    lastUsedAt: existing?.lastUsedAt ?? null,
    ...(icon ? { icon } : {}),
    ...(categoryId ? { categoryId } : {}),
  };

  let entry: VaultEntry;
  switch (input.type) {
    case 'login': {
      const prev = existing as VaultEntryOf<'login'> | undefined;
      const password = input.password ?? prev?.password ?? '';
      const changed = password !== (prev?.password ?? '');
      entry = {
        ...base,
        type: 'login',
        username: input.username ?? prev?.username ?? '',
        password,
        urls: input.urls ? normalizeUrls(input.urls) : (prev?.urls ?? []),
        totpSecret: input.totpSecret ?? prev?.totpSecret ?? '',
        passwordUpdatedAt: changed
          ? password
            ? clock.now
            : null
          : (prev?.passwordUpdatedAt ?? null),
        autoSubmit: input.autoSubmit ?? prev?.autoSubmit ?? false,
      };
      break;
    }
    case 'apiKey': {
      const prev = existing as VaultEntryOf<'apiKey'> | undefined;
      entry = {
        ...base,
        type: 'apiKey',
        service: input.service ?? prev?.service ?? '',
        keyId: input.keyId ?? prev?.keyId ?? '',
        secret: input.secret ?? prev?.secret ?? '',
        urls: input.urls ? normalizeUrls(input.urls) : (prev?.urls ?? []),
        expiresAt: input.expiresAt === undefined ? (prev?.expiresAt ?? null) : input.expiresAt,
      };
      break;
    }
    case 'note':
      entry = { ...base, type: 'note' };
      break;
    case 'custom': {
      const prev = existing as VaultEntryOf<'custom'> | undefined;
      entry = {
        ...base,
        type: 'custom',
        fields: input.fields.map((field) => {
          const stored = field.id ? prev?.fields.find((f) => f.id === field.id) : undefined;
          return {
            id: field.id ?? clock.newId(),
            label: field.label.trim(),
            value: field.value ?? stored?.value ?? '',
            concealed: field.concealed,
          };
        }),
      };
      break;
    }
  }
  return VaultEntrySchema.parse(entry);
}

export function readEntryField(entry: VaultEntry, ref: VaultFieldRef): string | undefined {
  if (typeof ref === 'object') {
    return entry.type === 'custom'
      ? entry.fields.find((f) => f.id === ref.customFieldId)?.value
      : undefined;
  }
  switch (ref) {
    case 'notes':
      return entry.notes;
    case 'username':
      return entry.type === 'login' ? entry.username : undefined;
    case 'password':
      return entry.type === 'login' ? entry.password : undefined;
    case 'totpSecret':
      return entry.type === 'login' ? entry.totpSecret : undefined;
    case 'secret':
      return entry.type === 'apiKey' ? entry.secret : undefined;
    case 'keyId':
      return entry.type === 'apiKey' ? entry.keyId : undefined;
    case 'url':
      return entry.type === 'login' || entry.type === 'apiKey' ? entry.urls[0] : undefined;
  }
}

export function duplicateEntry(entry: VaultEntry, clock: EntryClock): VaultEntry {
  const suffix = ' (copy)';
  return VaultEntrySchema.parse({
    ...structuredClone(entry),
    id: clock.newId(),
    title: `${entry.title.slice(0, VAULT_LIMITS.title - suffix.length)}${suffix}`,
    favorite: false,
    createdAt: clock.now,
    updatedAt: clock.now,
    lastUsedAt: null,
  });
}
