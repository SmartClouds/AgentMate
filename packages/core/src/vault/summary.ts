import type { VaultEntry, VaultEntryType } from './entries.js';
import { hostOf } from './url.js';

export interface VaultFieldSummary {
  id: string;
  label: string;
  concealed: boolean;
  hasValue: boolean;
  /** Only present for fields that are not concealed. */
  value?: string;
}

/**
 * The shape the renderer lists and searches. Built field by field from an allowlist, so a secret
 * added to an entry type later can't slip through by default.
 */
export interface VaultEntrySummary {
  id: string;
  type: VaultEntryType;
  title: string;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  username: string;
  service: string;
  keyId: string;
  urls: string[];
  host: string;
  /** Favicon data URL, when one was saved with the entry. */
  icon?: string;
  categoryId: string | null;
  /** Logins only: whether one-click login presses the sign-in button after filling. */
  autoSubmit: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  hasSecret: boolean;
  hasNotes: boolean;
  passwordUpdatedAt: number | null;
  expiresAt: number | null;
  fields: VaultFieldSummary[];
}

export function toEntrySummary(entry: VaultEntry): VaultEntrySummary {
  const urls = entry.type === 'login' || entry.type === 'apiKey' ? [...entry.urls] : [];
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    tags: [...entry.tags],
    favorite: entry.favorite,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt,
    username: entry.type === 'login' ? entry.username : '',
    service: entry.type === 'apiKey' ? entry.service : '',
    keyId: entry.type === 'apiKey' ? entry.keyId : '',
    urls,
    host: hostOf(urls[0] ?? ''),
    ...(entry.icon ? { icon: entry.icon } : {}),
    categoryId: entry.categoryId ?? null,
    autoSubmit: entry.type === 'login' && entry.autoSubmit === true,
    hasPassword: entry.type === 'login' && entry.password !== '',
    hasTotp: entry.type === 'login' && entry.totpSecret !== '',
    hasSecret: entry.type === 'apiKey' && entry.secret !== '',
    hasNotes: entry.notes !== '',
    passwordUpdatedAt: entry.type === 'login' ? entry.passwordUpdatedAt : null,
    expiresAt: entry.type === 'apiKey' ? entry.expiresAt : null,
    fields:
      entry.type === 'custom'
        ? entry.fields.map((field) => ({
            id: field.id,
            label: field.label,
            concealed: field.concealed,
            hasValue: field.value !== '',
            ...(field.concealed ? {} : { value: field.value }),
          }))
        : [],
  };
}
