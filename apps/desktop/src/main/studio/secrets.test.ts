import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStudioSecrets } from './secrets';

/** Studio's sealed keys file, with a toy seal that is easy to tell apart from plain text. */

type Sealed = { mode: 'toy' | 'moved'; text: string; locked?: boolean };

function secrets() {
  const file = join(mkdtempSync(join(tmpdir(), 'studio-secrets-')), 'data', 'secrets.json');
  const store = createStudioSecrets<Sealed>({
    file,
    seal: async (plain) => ({ mode: 'toy', text: [...plain].reverse().join('') }),
    unseal: async (sealed) => [...sealed.text].reverse().join(''),
    isLocked: (sealed) => sealed.locked === true,
  });
  return { file, store };
}

describe('Studio secrets', () => {
  it('seals what it saves, keeps every one of several saves at once, and forgets on null', async () => {
    const { file, store } = secrets();
    await Promise.all([store.set('a', 'alpha'), store.set('b', 'beta'), store.set('c', 'gamma')]);
    expect(readFileSync(file, 'utf8')).not.toContain('alpha');
    expect(await store.get('a')).toBe('alpha');
    expect(await store.get('c')).toBe('gamma');
    await store.set('b', null);
    expect(await store.get('b')).toBeNull();
    expect(await store.isLocked('b')).toBe(false);
  });

  it('reads a damaged file as empty, and says when a secret needs the vault', async () => {
    const { file, store } = secrets();
    await store.set('a', 'alpha');
    writeFileSync(
      file,
      JSON.stringify({ secrets: { a: { mode: 'toy', text: 'x', locked: true } } }),
    );
    expect(await store.isLocked('a')).toBe(true);
    writeFileSync(file, '{ not json');
    expect(await store.get('a')).toBeNull();
  });

  it('moves every secret on a passkey change, and saves only when told to', async () => {
    const { file, store } = secrets();
    await store.set('a', 'alpha');
    const commit = await store.prepare(async (sealed) => ({ ...sealed, mode: 'moved' }));
    expect(readFileSync(file, 'utf8')).not.toContain('moved');
    await commit();
    expect(readFileSync(file, 'utf8')).toContain('moved');
    expect(await store.get('a')).toBe('alpha');
  });
});
