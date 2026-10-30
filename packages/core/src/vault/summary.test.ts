import { describe, expect, it } from 'vitest';
import { applySaveInput, type SaveVaultEntryInput, type VaultEntry } from './entries.js';
import { toEntrySummary } from './summary.js';

const NOW = 1_700_000_000_000;

describe('toEntrySummary', () => {
  it('passes a saved site icon through so the list can show it', () => {
    const iconUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const entry = applySaveInput(
      undefined,
      { type: 'note', title: 'Router', tags: [], favorite: false, icon: iconUrl },
      { now: NOW, newId: () => 'e1' },
    );
    expect(toEntrySummary(entry).icon).toBe(iconUrl);
  });

  it('exposes what the list needs and flags for the secrets', () => {
    const entry = applySaveInput(
      undefined,
      {
        type: 'login',
        title: 'GitHub',
        tags: ['work'],
        favorite: true,
        notes: 'codes',
        username: 'octo',
        password: 'pw-123456',
        urls: ['https://www.github.com/login'],
        totpSecret: 'JBSW',
      },
      { now: NOW, newId: () => 'e1' },
    );
    expect(toEntrySummary(entry)).toEqual({
      id: 'e1',
      type: 'login',
      title: 'GitHub',
      tags: ['work'],
      favorite: true,
      createdAt: NOW,
      updatedAt: NOW,
      lastUsedAt: null,
      username: 'octo',
      service: '',
      keyId: '',
      urls: ['https://www.github.com/login'],
      host: 'github.com',
      categoryId: null,
      autoSubmit: false,
      hasPassword: true,
      hasTotp: true,
      hasSecret: false,
      hasNotes: true,
      passwordUpdatedAt: NOW,
      expiresAt: null,
      fields: [],
    });
  });

  it('exposes the category, and auto-submit for logins', () => {
    const entry = applySaveInput(
      undefined,
      {
        type: 'login',
        title: 'G',
        tags: [],
        favorite: false,
        categoryId: 'work',
        autoSubmit: true,
      },
      { now: NOW, newId: () => 'e1' },
    );
    expect(toEntrySummary(entry)).toMatchObject({ categoryId: 'work', autoSubmit: true });
    const note = applySaveInput(
      undefined,
      { type: 'note', title: 'N', tags: [], favorite: false },
      { now: NOW, newId: () => 'e2' },
    );
    expect(toEntrySummary(note)).toMatchObject({ categoryId: null, autoSubmit: false });
  });

  it('shows labels for every custom field but values only for the ones that are not concealed', () => {
    let n = 0;
    const entry = applySaveInput(
      undefined,
      {
        type: 'custom',
        title: 'Router',
        tags: [],
        favorite: false,
        notes: '',
        fields: [
          { label: 'PIN', value: '4242', concealed: true },
          { label: 'Model', value: 'AX3000', concealed: false },
          { label: 'Empty', value: '', concealed: true },
        ],
      },
      { now: NOW, newId: () => `f${++n}` },
    );
    expect(toEntrySummary(entry).fields).toEqual([
      { id: 'f2', label: 'PIN', concealed: true, hasValue: true },
      { id: 'f3', label: 'Model', concealed: false, hasValue: true, value: 'AX3000' },
      { id: 'f4', label: 'Empty', concealed: true, hasValue: false },
    ]);
  });

  it('never leaks a secret, across many random entries of every type', () => {
    // Seeded so a failure reproduces.
    let state = 20240917;
    const rand = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 2 ** 32;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
    const SENTINEL = 'S3NT1NEL';
    let n = 0;
    const newId = () => `id-${++n}`;

    for (let i = 0; i < 500; i++) {
      const secret = () => `${SENTINEL}-${Math.floor(rand() * 1e9)}`;
      const plain = () => `plain-${Math.floor(rand() * 1e9)}`;
      const shared = {
        title: plain(),
        tags: [plain()],
        favorite: rand() > 0.5,
        notes: rand() > 0.3 ? secret() : '',
      };
      const type = pick(['login', 'apiKey', 'note', 'custom'] as const);
      let input: SaveVaultEntryInput;
      if (type === 'login') {
        input = {
          ...shared,
          type,
          username: plain(),
          password: secret(),
          urls: [`${plain()}.example`],
          totpSecret: rand() > 0.5 ? secret() : '',
        };
      } else if (type === 'apiKey') {
        input = {
          ...shared,
          type,
          service: plain(),
          keyId: plain(),
          secret: secret(),
          urls: [],
          expiresAt: null,
        };
      } else if (type === 'note') {
        input = { ...shared, type };
      } else {
        input = {
          ...shared,
          type,
          fields: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
            const concealed = rand() > 0.5;
            return { label: plain(), value: concealed ? secret() : plain(), concealed };
          }),
        };
      }
      const entry: VaultEntry = applySaveInput(undefined, input, { now: NOW, newId });
      expect(JSON.stringify(toEntrySummary(entry))).not.toContain(SENTINEL);
    }
  });
});
