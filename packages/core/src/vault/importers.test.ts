import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from './csv.js';
import {
  detectImportFormat,
  type GenericMapping,
  mapImportRows,
  suggestGenericMapping,
} from './importers.js';

function fixture(name: string): string[][] {
  const text = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');
  return parseCsv(text, { delimiter: detectDelimiter(text) });
}

describe('detectImportFormat', () => {
  it.each([
    ['chrome.csv', 'chrome'],
    ['firefox.csv', 'firefox'],
    ['bitwarden.csv', 'bitwarden'],
    ['1password.csv', 'onePassword'],
  ] as const)('recognizes %s', (file, format) => {
    expect(detectImportFormat(fixture(file)[0])).toBe(format);
  });

  it('recognizes Chrome exports without the note column and ignores header case and spacing', () => {
    expect(detectImportFormat(['name', 'url', 'username', 'password'])).toBe('chrome');
    expect(detectImportFormat([' Name ', 'URL', 'Username', 'Password', 'Note'])).toBe('chrome');
  });

  it('recognizes its own export', () => {
    expect(
      detectImportFormat([
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
      ]),
    ).toBe('runova');
  });

  it('returns null for anything else', () => {
    expect(detectImportFormat(fixture('generic.csv')[0])).toBeNull();
    expect(detectImportFormat([])).toBeNull();
  });
});

describe('mapImportRows: chrome', () => {
  it('maps logins, falls back to the host for a missing name, keeps multi-line notes and skips empty rows', () => {
    const result = mapImportRows(fixture('chrome.csv'), 'chrome');
    expect(result.entries).toEqual([
      {
        type: 'login',
        title: 'github.com',
        tags: [],
        favorite: false,
        notes: '',
        username: 'octocat',
        password: 'gh-pass-1!',
        urls: ['https://github.com/login'],
        totpSecret: '',
      },
      {
        type: 'login',
        title: 'accounts.google.com',
        tags: [],
        favorite: false,
        notes: 'backup codes:\r\n1111 2222',
        username: 'me@gmail.com',
        password: 'g-pass-2',
        urls: ['https://accounts.google.com/'],
        totpSecret: '',
      },
      {
        type: 'login',
        title: 'Bank',
        tags: [],
        favorite: false,
        notes: '',
        username: '',
        password: 'bank-pass-3',
        urls: ['https://bank.example/'],
        totpSecret: '',
      },
    ]);
    expect(result.skipped).toEqual([{ row: 5, reason: 'Empty row' }]);
  });
});

describe('mapImportRows: firefox', () => {
  it('uses the host as the title and keeps the realm as a note', () => {
    const { entries, skipped } = mapImportRows(fixture('firefox.csv'), 'firefox');
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.title)).toEqual(['mozilla.org', 'intranet.example']);
    expect(entries[1]).toMatchObject({
      type: 'login',
      username: 'admin',
      password: 'ff-pass-2',
      notes: 'HTTP realm: Intranet Realm',
    });
  });
});

describe('mapImportRows: bitwarden', () => {
  const result = mapImportRows(fixture('bitwarden.csv'), 'bitwarden');

  it('maps folder to tag, favorite, several URIs, TOTP and extra fields into notes', () => {
    expect(result.entries[0]).toEqual({
      type: 'login',
      title: 'GitHub',
      tags: ['Work'],
      favorite: true,
      notes: '2FA on phone\n\nRecovery email: ops@example.com\nPIN: 4455',
      username: 'octocat',
      password: 'bw-pass-1',
      urls: ['https://github.com', 'https://gist.github.com'],
      totpSecret: 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    });
  });

  it('imports secure notes', () => {
    expect(result.entries[1]).toEqual({
      type: 'note',
      title: 'Wi-Fi codes',
      tags: [],
      favorite: false,
      notes: 'Guest: hello-guest',
    });
  });

  it('skips cards and identities with a reason, and names untitled logins after the host', () => {
    expect(result.skipped).toEqual([{ row: 4, reason: 'Unsupported item type "card"' }]);
    expect(result.entries[2]).toMatchObject({ title: 'no-name.example', password: 'bw-pass-2' });
    expect(result.entries).toHaveLength(3);
  });
});

describe('mapImportRows: 1Password', () => {
  it('maps tags, favorite, OTP and archived items', () => {
    const { entries, skipped } = mapImportRows(fixture('1password.csv'), 'onePassword');
    expect(skipped).toEqual([]);
    expect(entries[0]).toEqual({
      type: 'login',
      title: 'AWS Console',
      tags: ['Cloud', 'Work'],
      favorite: true,
      notes: 'Root account',
      username: 'root@example.com',
      password: 'op-pass-1',
      urls: ['https://console.aws.amazon.com'],
      totpSecret: 'otpauth://totp/AWS?secret=KRSXG5A',
    });
    expect(entries[1]).toMatchObject({ title: 'Old Forum', tags: ['Archived'], favorite: false });
  });
});

describe('generic mapping', () => {
  const rows = fixture('generic.csv');

  it('suggests targets from header names, each used once', () => {
    expect(suggestGenericMapping(rows[0])).toEqual({
      columns: ['title', 'username', 'password', 'notes', 'extra', 'extra'],
    });
  });

  it('turns mapped columns into logins and appends the extra columns to the notes', () => {
    const mapping: GenericMapping = suggestGenericMapping(rows[0]);
    const { entries } = mapImportRows(rows, mapping);
    expect(entries[0]).toMatchObject({
      type: 'login',
      title: 'Router',
      username: 'admin',
      password: 'rt-pass-1',
      notes: 'Living room\n\nPIN: 9911\nOwner: Dad',
    });
  });

  it('makes a note when a row has no login data', () => {
    const { entries } = mapImportRows(rows, suggestGenericMapping(rows[0]));
    expect(entries[1]).toEqual({
      type: 'note',
      title: 'Plain note',
      tags: [],
      favorite: false,
      notes: 'Just words',
    });
  });

  it('can ignore columns and read tags and favorite', () => {
    const { entries } = mapImportRows(
      [
        ['a', 'b', 'c', 'd', 'e'],
        ['Title', 'pw', 'x;y', 'yes', 'drop me'],
      ],
      { columns: ['title', 'password', 'tags', 'favorite', 'ignore'] },
    );
    expect(entries[0]).toMatchObject({
      type: 'login',
      title: 'Title',
      password: 'pw',
      tags: ['x', 'y'],
      favorite: true,
      notes: '',
    });
  });

  it('skips rows without a title or anything to save', () => {
    const { entries, skipped } = mapImportRows(
      [
        ['title', 'password'],
        ['', ''],
        ['', 'orphan'],
      ],
      { columns: ['title', 'password'] },
    );
    expect(entries).toEqual([expect.objectContaining({ title: 'Untitled', password: 'orphan' })]);
    expect(skipped).toEqual([{ row: 2, reason: 'Empty row' }]);
  });
});

describe('mapImportRows: shared behavior', () => {
  it('pads ragged rows and reports a missing header', () => {
    expect(mapImportRows([], 'chrome')).toEqual({ entries: [], skipped: [] });
    const { entries } = mapImportRows(
      [['name', 'url', 'username', 'password'], ['Only name']],
      'chrome',
    );
    expect(entries[0]).toMatchObject({ title: 'Only name', password: '' });
  });

  it('cuts overlong values to the vault limits instead of failing the whole import', () => {
    const { entries } = mapImportRows(
      [
        ['name', 'url', 'username', 'password'],
        ['x'.repeat(500), '', 'u', 'p'],
      ],
      'chrome',
    );
    expect(entries[0].title).toHaveLength(200);
  });
});

describe('mapImportRows: runova edge cases', () => {
  const header = [
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
  ];
  const row = (type: string, fields: string, title = 'T') => [
    type,
    title,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'not a date',
    '',
    '',
    '',
    fields,
  ];

  it('reports bad field JSON, a non-list and unknown types, and names blank titles', () => {
    const { entries, skipped } = mapImportRows(
      [
        header,
        row('custom', '{broken'),
        row('custom', '{"a":1}'),
        row('wallet', ''),
        row('apiKey', '', ''),
        row('custom', '[{"value":7}]'),
      ],
      'runova',
    );
    expect(skipped).toEqual([
      { row: 2, reason: 'The fields column is not valid JSON' },
      { row: 3, reason: 'The fields column is not a list' },
      { row: 4, reason: 'Unsupported item type "wallet"' },
    ]);
    expect(entries[0]).toMatchObject({ type: 'apiKey', title: 'Untitled', expiresAt: null });
    expect(entries[1]).toMatchObject({
      type: 'custom',
      fields: [{ label: 'Field', value: '7', concealed: true }],
    });
  });

  it('keeps a Bitwarden row without a type as a login', () => {
    const { entries } = mapImportRows(
      [
        ['folder', 'favorite', 'type', 'name', 'login_uri', 'login_username', 'login_password'],
        ['', '', '', 'NoType', 'x.com', 'u', 'p'],
      ],
      'bitwarden',
    );
    expect(entries[0]).toMatchObject({ type: 'login', title: 'NoType' });
  });
});
