import type { VaultEntrySummary, VaultEntryType, VaultFieldRef } from '@runova/core';
import { FileText, Globe, type IconProps, Key, Sliders } from '@/components/icons';

export interface EntryTypeMeta {
  label: string;
  plural: string;
  icon: React.ForwardRefExoticComponent<IconProps>;
}

export const ENTRY_TYPE_META: Record<VaultEntryType, EntryTypeMeta> = {
  login: { label: 'Login', plural: 'Logins', icon: Globe },
  apiKey: { label: 'API key', plural: 'API keys', icon: Key },
  note: { label: 'Secure note', plural: 'Notes', icon: FileText },
  custom: { label: 'Custom', plural: 'Custom', icon: Sliders },
};

export const ENTRY_TYPE_ORDER: VaultEntryType[] = ['login', 'apiKey', 'note', 'custom'];

/** The line under the title in the list. Never a secret. */
export function entrySubtitle(entry: VaultEntrySummary): string {
  switch (entry.type) {
    case 'login':
      return entry.username || entry.host || 'No username';
    case 'apiKey':
      return [entry.service, entry.keyId].filter(Boolean).join(' · ') || 'API key';
    case 'note':
      return 'Secure note';
    case 'custom':
      return entry.fields.length === 1 ? '1 field' : `${entry.fields.length} fields`;
  }
}

/** The one secret worth a quick copy button: a login's password or an API key's secret. */
export function primarySecret(
  entry: VaultEntrySummary,
): { ref: VaultFieldRef; label: string } | null {
  if (entry.type === 'login' && entry.hasPassword) return { ref: 'password', label: 'Password' };
  if (entry.type === 'apiKey' && entry.hasSecret) return { ref: 'secret', label: 'Secret' };
  return null;
}
