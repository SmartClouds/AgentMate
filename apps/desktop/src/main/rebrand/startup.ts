import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { BROWSER_PARTITION } from '../../shared/browserGuest';
import { LEGACY_BROWSER_PARTITION_DIR } from '../../shared/legacyNames';
import { isE2E, userDataOverride } from '../testMode';
import {
  type DataFolderMove,
  moveDataFolder,
  REBRAND_MARKER,
  recordDataFolderMove,
} from './dataFolder';
import { legacyDecryptJob, runLegacyDecryptHelper } from './legacySafeStorage';

/**
 * The start-up half of the rename from AgentMate to Runova. Imported by the main entry right
 * after testMode, before anything reads userData.
 */
export const isLegacyDecryptHelper = legacyDecryptJob != null;

function start(): DataFolderMove | null {
  if (legacyDecryptJob) {
    runLegacyDecryptHelper(legacyDecryptJob);
    return null;
  }
  // The end-to-end suite points the move at a folder of its own, so it never touches this
  // machine's real profiles.
  const e2eAppData = isE2E ? process.env.RUNOVA_E2E_APP_DATA?.trim() : undefined;
  // A profile chosen on purpose is used as it is.
  if (!e2eAppData && (userDataOverride || app.commandLine.hasSwitch('user-data-dir'))) return null;
  const move = moveDataFolder(e2eAppData || app.getPath('appData'), app.isPackaged);
  app.setPath('userData', move.folder);
  // Either way the app now runs under the new name, so the secrets it saved under the old one
  // have to move to the new key once the app is up (see afterStart.ts).
  if (move.moved || move.stayed) {
    const marker = join(move.folder, REBRAND_MARKER);
    try {
      if (!existsSync(marker)) {
        writeFileSync(marker, JSON.stringify({ secrets: 'pending', hooks: 'pending' }));
      }
    } catch {
      // Tried again on the next start, which still finds the old name.
    }
  }
  moveBrowserSession(move.folder);
  return move;
}

/** The in-app browser's cookies and storage live in a folder named after its session. */
function moveBrowserSession(folder: string): void {
  const partitions = join(folder, 'Partitions');
  const legacy = join(partitions, LEGACY_BROWSER_PARTITION_DIR);
  const current = join(partitions, BROWSER_PARTITION.replace(/^persist:/, ''));
  try {
    if (existsSync(legacy) && !existsSync(current)) renameSync(legacy, current);
  } catch {
    // The browser starts with a fresh session instead; sites ask the user to sign in again.
  }
}

recordDataFolderMove(start());
