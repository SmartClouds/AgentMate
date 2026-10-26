import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_APP_NAME, LEGACY_DEV_APP_NAME } from '../../shared/legacyNames';

export const APP_NAME = 'Runova';
export const DEV_APP_NAME = 'Runova Dev';

/** Written into a profile that comes from before the rename; see afterStart.ts. */
export const REBRAND_MARKER = 'rebrand.json';

export interface DataFolderMove {
  /** The folder this run uses. */
  folder: string;
  /** Where the profile lived before the rename, if one is there or was moved from there. */
  legacyFolder: string | null;
  /** The old folder was renamed to the new one during this start. */
  moved: boolean;
  /** The old folder could not be renamed (a terminal host from before is still in it), so
   *  this run uses it where it is and the next start tries again. */
  stayed: boolean;
}

let lastMove: DataFolderMove | null = null;

/** What the start-up move did this run (see startup.ts); null for a helper or an override. */
export function currentDataFolderMove(): DataFolderMove | null {
  return lastMove;
}

export function recordDataFolderMove(move: DataFolderMove | null): void {
  lastMove = move;
}

/** A profile with app data in it, as opposed to a folder Chromium made on the way up. */
const hasProfile = (folder: string): boolean => existsSync(join(folder, 'data'));

/**
 * Moves the profile from the folder named after AgentMate to the one named after Runova. Runs
 * once per start before anything reads userData. A rename keeps everything in it, including
 * Chromium's own files (Local State holds the Windows key for saved secrets). When the rename
 * fails, the old folder is used where it is, so nothing is ever left behind half moved.
 */
export function moveDataFolder(appData: string, packaged: boolean): DataFolderMove {
  const folder = join(appData, packaged ? APP_NAME : DEV_APP_NAME);
  const legacy = join(appData, packaged ? LEGACY_APP_NAME : LEGACY_DEV_APP_NAME);
  if (!hasProfile(legacy)) {
    return { folder, legacyFolder: null, moved: false, stayed: false };
  }
  if (hasProfile(folder)) {
    // Both have data: the new one is in use already and the old one is left for the user.
    return { folder, legacyFolder: legacy, moved: false, stayed: false };
  }
  try {
    // Chromium may have made an empty new folder before this ran. Park it rather than delete
    // anything, then take the name.
    if (existsSync(folder)) renameSync(folder, `${folder}.empty-${Date.now()}`);
    renameSync(legacy, folder);
    return { folder, legacyFolder: legacy, moved: true, stayed: false };
  } catch {
    return { folder: legacy, legacyFolder: legacy, moved: false, stayed: true };
  }
}
