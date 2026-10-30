import { describe, expect, it } from 'vitest';
import {
  applySaveInput,
  duplicateEntry,
  normalizeTags,
  readEntryField,
  type SaveVaultEntryInput,
  VAULT_LIMITS,
  type VaultEntry,
  VaultEntrySchema,
  VaultPayloadSchema,
} from './entries.js';

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

function login(overrides: Partial<Extract<SaveVaultEntryInput, { type: 'login' }>> = {}) {
  return {
    type: 'login',
    title: 'GitHub',
    tags: ['work'],
    favorite: false,
    notes: 'recovery codes',
    username: 'octo',
    password: 'hunter2-long',
    urls: ['github.com/login'],
    totpSecret: '',
    ...overrides,
  } satisfies SaveVaultEntryInput;
}

describe('VaultEntrySchema', () => {
  it('accepts every entry type', () => {
    const base = {
      id: 'a',
      title: 'x',
      tags: [],
      favorite: false,
      notes: '',
      createdAt: NOW,
      updatedAt: NOW,
      lastUsedAt: null,
    };
    const samples: VaultEntry[] = [
      {
        ...base,
        type: 'login',
        username: 'u',
        password: 'p',
        urls: [],
        totpSecret: '',
        passwordUpdatedAt: null,
      },
      { ...base, type: 'apiKey', service: 's', keyId: '', secret: 'k', urls: [], expiresAt: null },
      { ...base, type: 'note' },
      { ...base, type: 'custom', fields: [{ id: 'f', label: 'PIN', value: '1', concealed: true }] },
    ];
    for (const sample of samples) expect(VaultEntrySchema.safeParse(sample).success).toBe(true);
  });

  it('rejects unknown types, blank titles and oversized values', () => {
    const entry = applySaveInput(undefined, login(), { now: NOW, newId: () => 'id1' });
    expect(VaultEntrySchema.safeParse({ ...entry, type: 'wallet' }).success).toBe(false);
    expect(VaultEntrySchema.safeParse({ ...entry, title: '' }).success).toBe(false);
    expect(
      VaultEntrySchema.safeParse({ ...entry, password: 'x'.repeat(VAULT_LIMITS.secret + 1) })
        .success,
    ).toBe(false);
    expect(
      VaultEntrySchema.safeParse({
        ...entry,
        tags: Array.from({ length: VAULT_LIMITS.tags + 1 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });

  it('validates the payload envelope', () => {
    expect(
      VaultPayloadSchema.safeParse({ schemaVersion: 1, createdAt: NOW, entries: [] }).success,
    ).toBe(true);
    expect(
      VaultPayloadSchema.safeParse({ schemaVersion: 2, createdAt: NOW, entries: [] }).success,
    ).toBe(false);
  });
});

describe('normalizeTags', () => {
  it('trims, drops blanks and removes case-insensitive duplicates, keeping the first spelling', () => {
    expect(normalizeTags([' Work ', 'work', '', 'Personal', '  ', 'personal'])).toEqual([
      'Work',
      'Personal',
    ]);
  });
});

describe('applySaveInput', () => {
  const ids = () => {
    let n = 0;
    return () => `id${++n}`;
  };

  it('creates a login with ids, timestamps and normalized urls', () => {
    const entry = applySaveInput(undefined, login({ urls: [' github.com ', ''] }), {
      now: NOW,
      newId: ids(),
    });
    expect(entry).toMatchObject({
      id: 'id1',
      type: 'login',
      title: 'GitHub',
      urls: ['https://github.com'],
      createdAt: NOW,
      updatedAt: NOW,
      lastUsedAt: null,
      passwordUpdatedAt: NOW,
    });
  });

  it('trims the title and rejects a blank one', () => {
    expect(
      applySaveInput(undefined, login({ title: '  Mail  ' }), { now: NOW, newId: ids() }).title,
    ).toBe('Mail');
    expect(() =>
      applySaveInput(undefined, login({ title: '   ' }), { now: NOW, newId: ids() }),
    ).toThrow();
  });

  it('stores a site icon, keeps it when the input leaves it out and removes it on null', () => {
    const iconUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const created = applySaveInput(undefined, login({ icon: iconUrl }), { now: NOW, newId: ids() });
    expect(created.icon).toBe(iconUrl);

    const kept = applySaveInput(created, login({ id: created.id }), { now: LATER, newId: ids() });
    expect(kept.icon).toBe(iconUrl);

    const removed = applySaveInput(kept, login({ id: kept.id, icon: null }), {
      now: LATER,
      newId: ids(),
    });
    expect(removed).not.toHaveProperty('icon');
  });

  it('refuses an icon that is not an image data URL or is too large', () => {
    const save = (icon: string) =>
      applySaveInput(undefined, login({ icon }), { now: NOW, newId: ids() });
    expect(() => save('https://github.com/favicon.ico')).toThrow();
    expect(() => save('data:text/html,<script>')).toThrow();
    expect(() => save(`data:image/png;base64,${'A'.repeat(VAULT_LIMITS.icon)}`)).toThrow();
  });

  it('keeps stored secrets when the input leaves them undefined', () => {
    const existing = applySaveInput(undefined, login(), { now: NOW, newId: ids() });
    const updated = applySaveInput(
      existing,
      login({ id: existing.id, title: 'GitHub (work)', password: undefined, notes: undefined }),
      { now: LATER, newId: ids() },
    );
    expect(updated).toMatchObject({
      id: existing.id,
      title: 'GitHub (work)',
      password: 'hunter2-long',
      notes: 'recovery codes',
      createdAt: NOW,
      updatedAt: LATER,
      passwordUpdatedAt: NOW,
    });
  });

  it('bumps passwordUpdatedAt only when the password really changes, and clears on empty string', () => {
    const existing = applySaveInput(undefined, login(), { now: NOW, newId: ids() });
    const same = applySaveInput(existing, login({ id: existing.id }), { now: LATER, newId: ids() });
    expect(same.type === 'login' && same.passwordUpdatedAt).toBe(NOW);
    const changed = applySaveInput(existing, login({ id: existing.id, password: 'new-one-1234' }), {
      now: LATER,
      newId: ids(),
    });
    expect(changed.type === 'login' && changed.passwordUpdatedAt).toBe(LATER);
    const cleared = applySaveInput(existing, login({ id: existing.id, password: '' }), {
      now: LATER,
      newId: ids(),
    });
    expect(cleared.type === 'login' && cleared.password).toBe('');
  });

  it('refuses to change the type of an existing entry', () => {
    const existing = applySaveInput(undefined, login(), { now: NOW, newId: ids() });
    expect(() =>
      applySaveInput(
        existing,
        { id: existing.id, type: 'note', title: 'x', tags: [], favorite: false, notes: '' },
        { now: LATER, newId: ids() },
      ),
    ).toThrow(/type/i);
  });

  it('keeps concealed custom field values by field id and assigns ids to new fields', () => {
    const newId = ids();
    const existing = applySaveInput(
      undefined,
      {
        type: 'custom',
        title: 'Router',
        tags: [],
        favorite: false,
        notes: '',
        fields: [
          { label: 'Admin PIN', value: '4242', concealed: true },
          { label: 'Model', value: 'AX3000', concealed: false },
        ],
      },
      { now: NOW, newId },
    );
    if (existing.type !== 'custom') throw new Error('expected custom');
    const [pin, model] = existing.fields;
    expect(pin.id).not.toBe(model.id);

    const updated = applySaveInput(
      existing,
      {
        id: existing.id,
        type: 'custom',
        title: 'Router',
        tags: [],
        favorite: false,
        fields: [
          { id: model.id, label: 'Model', value: 'AX5400', concealed: false },
          { id: pin.id, label: 'Admin PIN', concealed: true },
          { label: 'Wi-Fi', value: 'secret-wifi', concealed: true },
        ],
      },
      { now: LATER, newId },
    );
    if (updated.type !== 'custom') throw new Error('expected custom');
    expect(updated.fields.map((f) => [f.label, f.value])).toEqual([
      ['Model', 'AX5400'],
      ['Admin PIN', '4242'],
      ['Wi-Fi', 'secret-wifi'],
    ]);
    expect(updated.notes).toBe('');
  });

  it('rejects a custom field without a label', () => {
    expect(() =>
      applySaveInput(
        undefined,
        {
          type: 'custom',
          title: 'x',
          tags: [],
          favorite: false,
          notes: '',
          fields: [{ label: ' ', value: 'v', concealed: false }],
        },
        { now: NOW, newId: ids() },
      ),
    ).toThrow();
  });
});

describe('readEntryField', () => {
  const newId = () => 'f1';

  it('reads the fields each type has and returns undefined for the rest', () => {
    const entry = applySaveInput(undefined, login({ totpSecret: 'JBSWY3DPEHPK3PXP' }), {
      now: NOW,
      newId,
    });
    expect(readEntryField(entry, 'username')).toBe('octo');
    expect(readEntryField(entry, 'password')).toBe('hunter2-long');
    expect(readEntryField(entry, 'totpSecret')).toBe('JBSWY3DPEHPK3PXP');
    expect(readEntryField(entry, 'notes')).toBe('recovery codes');
    expect(readEntryField(entry, 'url')).toBe('https://github.com/login');
    expect(readEntryField(entry, 'secret')).toBeUndefined();
    expect(readEntryField(entry, { customFieldId: 'f1' })).toBeUndefined();
  });

  it('reads api key and custom fields', () => {
    const key = applySaveInput(
      undefined,
      {
        type: 'apiKey',
        title: 'Stripe',
        tags: [],
        favorite: false,
        notes: '',
        service: 'Stripe',
        keyId: 'pk_live_1',
        secret: 'sk_live_2',
        urls: [],
        expiresAt: null,
      },
      { now: NOW, newId },
    );
    expect(readEntryField(key, 'secret')).toBe('sk_live_2');
    expect(readEntryField(key, 'keyId')).toBe('pk_live_1');
    const custom = applySaveInput(
      undefined,
      {
        type: 'custom',
        title: 'Door',
        tags: [],
        favorite: false,
        notes: '',
        fields: [{ label: 'Code', value: '1234', concealed: true }],
      },
      { now: NOW, newId },
    );
    expect(readEntryField(custom, { customFieldId: 'f1' })).toBe('1234');
  });
});

describe('duplicateEntry', () => {
  it('copies everything under a new id and title, with fresh timestamps', () => {
    const entry = applySaveInput(undefined, login({ favorite: true }), {
      now: NOW,
      newId: () => 'orig',
    });
    const copy = duplicateEntry(entry, { now: LATER, newId: () => 'copy' });
    expect(copy).toMatchObject({
      id: 'copy',
      title: 'GitHub (copy)',
      favorite: false,
      createdAt: LATER,
      updatedAt: LATER,
      lastUsedAt: null,
      password: 'hunter2-long',
    });
    expect(entry.title).toBe('GitHub');
  });
});

describe('applySaveInput: less common paths', () => {
  const clock = { now: NOW, newId: () => 'k1' };

  it('refuses an id that does not belong to the entry being edited', () => {
    const existing = applySaveInput(undefined, login(), clock);
    expect(() => applySaveInput(existing, login({ id: 'someone-else' }), clock)).toThrow(/id/);
  });

  it('keeps api key fields left out of an edit, and clears the expiry on null', () => {
    const existing = applySaveInput(
      undefined,
      {
        type: 'apiKey',
        title: 'Stripe',
        tags: [],
        favorite: false,
        service: 'Stripe',
        keyId: 'pk_1',
        secret: 'sk_1',
        urls: ['dashboard.stripe.com'],
        expiresAt: 1_900_000_000_000,
      },
      clock,
    );
    const kept = applySaveInput(
      existing,
      { id: existing.id, type: 'apiKey', title: 'Stripe live', tags: [], favorite: true },
      { now: LATER, newId: () => 'k2' },
    );
    expect(kept).toMatchObject({
      service: 'Stripe',
      keyId: 'pk_1',
      secret: 'sk_1',
      urls: ['https://dashboard.stripe.com'],
      expiresAt: 1_900_000_000_000,
    });
    const cleared = applySaveInput(
      existing,
      {
        id: existing.id,
        type: 'apiKey',
        title: 'Stripe',
        tags: [],
        favorite: false,
        expiresAt: null,
      },
      clock,
    );
    expect(cleared.type === 'apiKey' && cleared.expiresAt).toBeNull();
  });

  it('keeps login fields left out of an edit', () => {
    const existing = applySaveInput(undefined, login({ totpSecret: 'JBSW' }), clock);
    const kept = applySaveInput(
      existing,
      { id: existing.id, type: 'login', title: 'GitHub', tags: [], favorite: false },
      { now: LATER, newId: () => 'k2' },
    );
    expect(kept).toMatchObject({
      username: 'octo',
      password: 'hunter2-long',
      totpSecret: 'JBSW',
      urls: ['https://github.com/login'],
    });
  });

  it('starts a login with no password as never changed', () => {
    const entry = applySaveInput(
      undefined,
      { type: 'login', title: 'Bare', tags: [], favorite: false },
      clock,
    );
    expect(entry).toMatchObject({ username: '', password: '', urls: [], passwordUpdatedAt: null });
  });

  it('reads fields that a type does not have as undefined', () => {
    const note = applySaveInput(
      undefined,
      { type: 'note', title: 'N', tags: [], favorite: false, notes: 'x' },
      clock,
    );
    for (const ref of ['username', 'password', 'totpSecret', 'secret', 'keyId', 'url'] as const) {
      expect(readEntryField(note, ref)).toBeUndefined();
    }
    expect(readEntryField(note, 'notes')).toBe('x');
  });
});

describe('categories and auto-submit on entries', () => {
  const clock = { now: NOW, newId: () => 'e1' };

  it('files a new entry under the category it was saved with', () => {
    const entry = applySaveInput(
      undefined,
      { type: 'note', title: 'N', tags: [], favorite: false, categoryId: 'work' },
      clock,
    );
    expect(entry.categoryId).toBe('work');
  });

  it('keeps the category when an edit leaves it out, and clears it on null', () => {
    const first = applySaveInput(
      undefined,
      { type: 'note', title: 'N', tags: [], favorite: false, categoryId: 'work' },
      clock,
    );
    const kept = applySaveInput(
      first,
      { type: 'note', title: 'N2', tags: [], favorite: false },
      { now: LATER, newId: () => 'x' },
    );
    expect(kept.categoryId).toBe('work');
    const cleared = applySaveInput(
      first,
      { type: 'note', title: 'N', tags: [], favorite: false, categoryId: null },
      { now: LATER, newId: () => 'x' },
    );
    expect(cleared).not.toHaveProperty('categoryId');
  });

  it('stores auto-submit on a login, off unless asked for, and keeps it on edits', () => {
    const plain = applySaveInput(undefined, login(), clock);
    expect(plain).toMatchObject({ type: 'login', autoSubmit: false });
    const on = applySaveInput(undefined, login({ autoSubmit: true }), clock);
    expect(on).toMatchObject({ autoSubmit: true });
    const edited = applySaveInput(on, login({ id: 'e1', title: 'Renamed' }), {
      now: LATER,
      newId: () => 'x',
    });
    expect(edited).toMatchObject({ autoSubmit: true });
  });

  it('still reads a login stored before auto-submit existed', () => {
    const stored = VaultEntrySchema.safeParse({
      id: 'a',
      type: 'login',
      title: 'Old',
      tags: [],
      favorite: false,
      notes: '',
      createdAt: NOW,
      updatedAt: NOW,
      lastUsedAt: null,
      username: '',
      password: '',
      urls: [],
      totpSecret: '',
      passwordUpdatedAt: null,
    });
    expect(stored.success).toBe(true);
  });

  it('keeps the category on a duplicate', () => {
    const entry = applySaveInput(
      undefined,
      { type: 'note', title: 'N', tags: [], favorite: false, categoryId: 'work' },
      clock,
    );
    expect(duplicateEntry(entry, { now: LATER, newId: () => 'copy' }).categoryId).toBe('work');
  });

  it('opens a payload written before categories existed with an empty list', () => {
    const parsed = VaultPayloadSchema.parse({ schemaVersion: 1, createdAt: NOW, entries: [] });
    expect(parsed.categories).toEqual([]);
  });

  it('keeps categories in the payload', () => {
    const categories = [
      { id: 'work', name: 'Work', color: 'blue', icon: 'briefcase', order: 0, createdAt: NOW },
    ];
    const parsed = VaultPayloadSchema.parse({
      schemaVersion: 1,
      createdAt: NOW,
      entries: [],
      categories,
    });
    expect(parsed.categories).toEqual(categories);
  });
});
