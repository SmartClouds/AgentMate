import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { portFilePath } from '../notifications/hookServer';
import { migrateLegacySafeStorage } from '../ssh/vault';
import { store } from '../store';
import { studioService } from '../studio';
import { REBRAND_MARKER } from './dataFolder';
import { decryptWithLegacyKey } from './legacySafeStorage';
import { moveLegacyProjectFiles } from './projectFiles';

interface RebrandState {
  /** Saved secrets still have to be sealed again under the renamed app's key. */
  secrets: 'pending' | 'done';
  /** Projects' Claude Code hooks still name the port file in the old profile folder. */
  hooks?: 'pending' | 'done';
  /** Helper runs that failed (the keyring said no, or it timed out). */
  attempts?: number;
}

/** Gives up on the old key after this many failed starts, so a "Deny" isn't asked every time. */
const MAX_ATTEMPTS = 3;

async function readState(file: string): Promise<RebrandState | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RebrandState;
  } catch {
    return null;
  }
}

/**
 * Follow-ups to the rename that need the app ready and every sealed secret store registered. Runs
 * in the background after start-up; anything that fails is tried again on the next start.
 */
export async function finishRebrand(): Promise<void> {
  const file = join(app.getPath('userData'), REBRAND_MARKER);
  const state = await readState(file);
  // Every start, since a project can come back online or be added with an old folder in it.
  for (const project of await store.getProjects()) {
    await moveLegacyProjectFiles(project, portFilePath(), state?.hooks === 'pending');
  }
  if (state?.hooks === 'pending') {
    await writeFile(file, JSON.stringify({ ...state, hooks: 'done' } satisfies RebrandState));
  }
  if (!state || state.secrets !== 'pending') return;
  // On Windows the key travels inside the profile folder, so moving it was all it took.
  const decrypt =
    process.platform === 'win32'
      ? async (ciphertexts: string[]) => ciphertexts.map(() => null)
      : decryptWithLegacyKey;
  // Studio registers its sealed keys when it is first used. Make it now if it has any, so they
  // move with the rest.
  if (existsSync(join(app.getPath('userData'), 'data', 'studio', 'secrets.json'))) studioService();
  try {
    const { unreadable } = await migrateLegacySafeStorage(decrypt);
    if (unreadable > 0) {
      // biome-ignore lint/suspicious/noConsole: the only record of secrets that were lost
      console.warn(`[rebrand] ${unreadable} saved secret(s) could not be opened with either key`);
    }
    await writeFile(
      file,
      JSON.stringify({ secrets: 'done', hooks: 'done' } satisfies RebrandState),
    );
  } catch (error) {
    const attempts = (state.attempts ?? 0) + 1;
    // biome-ignore lint/suspicious/noConsole: the only record of why the move is tried again
    console.warn('[rebrand] could not move saved secrets to the new key:', error);
    const next: RebrandState = {
      secrets: attempts >= MAX_ATTEMPTS ? 'done' : 'pending',
      hooks: 'done',
      attempts,
    };
    await writeFile(file, JSON.stringify(next)).catch(() => undefined);
  }
}
