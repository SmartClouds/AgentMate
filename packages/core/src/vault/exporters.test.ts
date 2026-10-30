import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';
import { applySaveInput, type SaveVaultEntryInput, type VaultEntry } from './entries.js';
import { exportEntriesCsv } from './exporters.js';
import { detectImportFormat, mapImportRows } from './importers.js';

const NOW = 1_700_000_000_000;

function build(inputs: SaveVaultEntryInput[]): VaultEntry[] {
  let n = 0;
  return inputs.map((input) =>
    applySaveInput(undefined, input, { now: NOW, newId: () => `id${++n}` }),
  );
}

const entries = build([
  {
    type: 'login',
    title: 'GitHub, "work"',
    tags: ['Work', 'Dev;Ops'],
    favorite: true,
    notes: 'line 1\nline 2',
    username: 'octocat',
    password: 'p,a"s\ns',
    urls: ['https://github.com', 'https://gist.github.com'],
    totpSecret: 'JBSWY3DPEHPK3PXP',
  },
  {
    type: 'apiKey',
    title: 'Stripe',
    tags: [],
    favorite: false,
    notes: '',
    service: 'Stripe',
    keyId: 'pk_live_1',
    secret: 'sk_live_2',
    urls: ['https://dashboard.stripe.com'],
    expiresAt: 1_900_000_000_000,
  },
  { type: 'note', title: 'Wi-Fi', tags: ['Home'], favorite: false, notes: 'guest: hello' },
  {
    type: 'custom',
    title: 'Router',
    tags: [],
    favorite: false,
    notes: 'closet',
    fields: [
      { label: 'PIN', value: '4242', concealed: true },
      { label: 'Model', value: 'AX3000', concealed: false },
    ],
  },
]);

describe('exportEntriesCsv: runova', () => {
  it('writes a header that the importer recognizes', () => {
    const [header] = parseCsv(exportEntriesCsv(entries, 'runova'));
    expect(detectImportFormat(header)).toBe('runova');
  });

  it('round-trips every entry type through import without losing data', () => {
    const csv = exportEntriesCsv(entries, 'runova');
    const { entries: imported, skipped } = mapImportRows(parseCsv(csv), 'runova');
    expect(skipped).toEqual([]);
    const rebuilt = build(imported);
    const strip = (e: VaultEntry) => {
      const { id: _id, createdAt: _c, updatedAt: _u, lastUsedAt: _l, ...rest } = e;
      if (rest.type === 'custom') {
        return { ...rest, fields: rest.fields.map(({ id: _f, ...field }) => field) };
      }
      return rest;
    };
    expect(rebuilt.map(strip)).toEqual(entries.map(strip));
  });
});

describe('exportEntriesCsv: bitwarden', () => {
  it('writes the Bitwarden columns and maps every type onto login or note items', () => {
    const rows = parseCsv(exportEntriesCsv(entries, 'bitwarden'));
    expect(rows[0]).toEqual([
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
    ]);
    expect(detectImportFormat(rows[0])).toBe('bitwarden');
    expect(rows[1]).toEqual([
      'Work',
      '1',
      'login',
      'GitHub, "work"',
      'line 1\nline 2',
      '',
      '0',
      'https://github.com,https://gist.github.com',
      'octocat',
      'p,a"s\ns',
      'JBSWY3DPEHPK3PXP',
    ]);
    expect(rows[2]).toEqual([
      '',
      '',
      'login',
      'Stripe',
      '',
      `Service: Stripe\nExpires: ${new Date(1_900_000_000_000).toISOString().slice(0, 10)}`,
      '0',
      'https://dashboard.stripe.com',
      'pk_live_1',
      'sk_live_2',
      '',
    ]);
    expect(rows[3].slice(0, 5)).toEqual(['Home', '', 'note', 'Wi-Fi', 'guest: hello']);
    expect(rows[4].slice(2, 6)).toEqual(['note', 'Router', 'closet', 'PIN: 4242\nModel: AX3000']);
  });

  it('writes only a header for an empty vault', () => {
    expect(parseCsv(exportEntriesCsv([], 'bitwarden'))).toHaveLength(1);
  });
});

describe('exportEntriesCsv: categories', () => {
  const categories = [
    { id: 'c1', name: 'Clients', color: 'blue', icon: 'briefcase', order: 0, createdAt: NOW },
  ] as const;

  it('uses the category as the Bitwarden folder, ahead of the first tag', () => {
    const [filed, loose] = build([
      { type: 'note', title: 'Filed', tags: ['Work'], favorite: false, categoryId: 'c1' },
      { type: 'note', title: 'Loose', tags: ['Home'], favorite: false },
    ]);
    const rows = parseCsv(exportEntriesCsv([filed, loose], 'bitwarden', [...categories]));
    expect(rows[1][0]).toBe('Clients');
    expect(rows[2][0]).toBe('Home');
  });

  it('falls back to the first tag when the category is unknown', () => {
    const [filed] = build([
      { type: 'note', title: 'Filed', tags: ['Work'], favorite: false, categoryId: 'gone' },
    ]);
    expect(parseCsv(exportEntriesCsv([filed], 'bitwarden', [...categories]))[1][0]).toBe('Work');
  });
});
