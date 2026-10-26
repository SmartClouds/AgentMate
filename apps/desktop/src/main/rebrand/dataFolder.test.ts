import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveDataFolder } from './dataFolder';

let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'runova-data-folder-'));
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

function profile(name: string, marker = 'settings'): string {
  const folder = join(appData, name);
  mkdirSync(join(folder, 'data'), { recursive: true });
  writeFileSync(join(folder, 'data', 'settings.json'), JSON.stringify({ marker }));
  return folder;
}

describe('moveDataFolder', () => {
  it('renames the profile from before the rename to the new name', () => {
    const legacy = profile('AgentMate'); // legacy-name

    const move = moveDataFolder(appData, true);

    expect(move).toEqual({
      folder: join(appData, 'Runova'),
      legacyFolder: legacy,
      moved: true,
      stayed: false,
    });
    expect(existsSync(join(appData, 'Runova', 'data', 'settings.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('moves the development profile to its own new name', () => {
    profile('AgentMate Dev'); // legacy-name

    const move = moveDataFolder(appData, false);

    expect(move.folder).toBe(join(appData, 'Runova Dev'));
    expect(move.moved).toBe(true);
  });

  it('starts fresh when there is nothing from before', () => {
    const move = moveDataFolder(appData, true);

    expect(move).toEqual({
      folder: join(appData, 'Runova'),
      legacyFolder: null,
      moved: false,
      stayed: false,
    });
  });

  it('parks an empty new folder Chromium made, rather than deleting or merging it', () => {
    profile('AgentMate'); // legacy-name
    mkdirSync(join(appData, 'Runova', 'Crashpad'), { recursive: true });

    const move = moveDataFolder(appData, true);

    expect(move.moved).toBe(true);
    expect(existsSync(join(appData, 'Runova', 'data'))).toBe(true);
    expect(readdirSync(appData).some((name) => name.startsWith('Runova.empty-'))).toBe(true);
  });

  it('leaves both alone when the new profile already has data', () => {
    const legacy = profile('AgentMate', 'old'); // legacy-name
    profile('Runova', 'new');

    const move = moveDataFolder(appData, true);

    expect(move).toEqual({
      folder: join(appData, 'Runova'),
      legacyFolder: legacy,
      moved: false,
      stayed: false,
    });
    expect(existsSync(legacy)).toBe(true);
  });
});
