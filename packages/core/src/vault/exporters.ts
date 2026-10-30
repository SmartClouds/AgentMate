import type { VaultCategory } from './categories.js';
import { serializeCsv } from './csv.js';
import type { VaultEntry } from './entries.js';
import { BITWARDEN_CSV_COLUMNS, RUNOVA_CSV_COLUMNS } from './importers.js';

export type VaultExportFormat = 'runova' | 'bitwarden';

function runovaRow(entry: VaultEntry): string[] {
  const row: Record<(typeof RUNOVA_CSV_COLUMNS)[number], string> = {
    type: entry.type,
    title: entry.title,
    username: entry.type === 'login' ? entry.username : '',
    password: entry.type === 'login' ? entry.password : '',
    urls: entry.type === 'login' || entry.type === 'apiKey' ? entry.urls.join('\n') : '',
    totp: entry.type === 'login' ? entry.totpSecret : '',
    service: entry.type === 'apiKey' ? entry.service : '',
    key_id: entry.type === 'apiKey' ? entry.keyId : '',
    secret: entry.type === 'apiKey' ? entry.secret : '',
    expires_at:
      entry.type === 'apiKey' && entry.expiresAt !== null
        ? new Date(entry.expiresAt).toISOString()
        : '',
    notes: entry.notes,
    tags: entry.tags.join('\n'),
    favorite: entry.favorite ? 'true' : 'false',
    fields:
      entry.type === 'custom'
        ? JSON.stringify(
            entry.fields.map(({ label, value, concealed }) => ({ label, value, concealed })),
          )
        : '',
  };
  return RUNOVA_CSV_COLUMNS.map((column) => row[column]);
}

function bitwardenRow(entry: VaultEntry, folders: Map<string, string>): string[] {
  const extra: string[] = [];
  let type = 'note';
  let uri = '';
  let username = '';
  let password = '';
  let totp = '';
  if (entry.type === 'login') {
    type = 'login';
    uri = entry.urls.join(',');
    username = entry.username;
    password = entry.password;
    totp = entry.totpSecret;
  } else if (entry.type === 'apiKey') {
    // Bitwarden has no API key item, so it rides on a login with the service as a field.
    type = 'login';
    uri = entry.urls.join(',');
    username = entry.keyId;
    password = entry.secret;
    if (entry.service) extra.push(`Service: ${entry.service}`);
    if (entry.expiresAt !== null) {
      extra.push(`Expires: ${new Date(entry.expiresAt).toISOString().slice(0, 10)}`);
    }
  } else if (entry.type === 'custom') {
    for (const field of entry.fields) extra.push(`${field.label}: ${field.value}`);
  }
  const row: Record<(typeof BITWARDEN_CSV_COLUMNS)[number], string> = {
    folder: (entry.categoryId && folders.get(entry.categoryId)) || (entry.tags[0] ?? ''),
    favorite: entry.favorite ? '1' : '',
    type,
    name: entry.title,
    notes: entry.notes,
    fields: extra.join('\n'),
    reprompt: '0',
    login_uri: uri,
    login_username: username,
    login_password: password,
    login_totp: totp,
  };
  return BITWARDEN_CSV_COLUMNS.map((column) => row[column]);
}

/**
 * Plain text CSV. Anyone who can read the file can read every password in it. Bitwarden gets the
 * entry's category as its folder, or the first tag when it has none.
 */
export function exportEntriesCsv(
  entries: VaultEntry[],
  format: VaultExportFormat,
  categories: VaultCategory[] = [],
): string {
  const header = format === 'runova' ? [...RUNOVA_CSV_COLUMNS] : [...BITWARDEN_CSV_COLUMNS];
  const folders = new Map(categories.map((c) => [c.id, c.name]));
  const rows = entries.map((entry) =>
    format === 'runova' ? runovaRow(entry) : bitwardenRow(entry, folders),
  );
  return serializeCsv([header, ...rows]);
}
