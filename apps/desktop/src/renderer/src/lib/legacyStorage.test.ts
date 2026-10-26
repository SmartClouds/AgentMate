import { describe, expect, it } from 'vitest';
import { moveLegacyStorageKeys } from './legacyStorage';

function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

describe('moveLegacyStorageKeys', () => {
  it('moves every key saved under the old name to the new one', () => {
    const storage = memoryStorage({
      'agentmate-ui': '{"a":1}', // legacy-name
      'agentmate.projects.view': 'grid', // legacy-name
      'agentmate:last-good:x': '1', // legacy-name
      unrelated: 'kept',
    });

    expect(moveLegacyStorageKeys(storage)).toBe(3);

    expect(storage.getItem('runova-ui')).toBe('{"a":1}');
    expect(storage.getItem('runova.projects.view')).toBe('grid');
    expect(storage.getItem('runova:last-good:x')).toBe('1');
    expect(storage.getItem('unrelated')).toBe('kept');
    expect(storage.length).toBe(4);
  });

  it('keeps a value already saved under the new name', () => {
    const storage = memoryStorage({ 'agentmate-ui': 'old', 'runova-ui': 'new' }); // legacy-name

    expect(moveLegacyStorageKeys(storage)).toBe(0);

    expect(storage.getItem('runova-ui')).toBe('new');
    expect(storage.length).toBe(1);
  });
});
