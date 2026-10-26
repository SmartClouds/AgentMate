import { LEGACY_STORAGE_KEY_PREFIXES } from '@shared/legacyNames';

const NEW_PREFIX = 'runova';

/**
 * The saved UI state (layouts, open tabs, panel widths, terminal sessions) is kept in
 * localStorage under keys named after the app. The ones saved before the rename are copied to the
 * new names once, before any store reads them. A key that already exists under the new name wins.
 */
export function moveLegacyStorageKeys(storage: Storage): number {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && LEGACY_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  let moved = 0;
  for (const key of keys) {
    // Every legacy prefix is the old name plus one separator character.
    const next = NEW_PREFIX + key.slice(LEGACY_STORAGE_KEY_PREFIXES[0].length - 1);
    const value = storage.getItem(key);
    if (value != null && storage.getItem(next) == null) {
      storage.setItem(next, value);
      moved += 1;
    }
    storage.removeItem(key);
  }
  return moved;
}

try {
  moveLegacyStorageKeys(window.localStorage);
} catch {
  // Storage is off or full; the stores start from their defaults as they would anyway.
}
