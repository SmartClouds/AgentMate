import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * The tops of this computer's file system, where a local browser starts: every drive letter
 * that exists on Windows, Home and `/` everywhere else. Shared by the remote-control file
 * manager (main/remote/fileManagerOps.ts) and the SFTP file manager's Places (main/sftp/localFs.ts).
 */

export interface LocalRoot {
  /** `C:\` for a drive, `Home` or `/` elsewhere. */
  name: string;
  path: string;
  kind: 'drive' | 'home' | 'root';
}

export interface LocalRootsOptions {
  /** Read at call time by default, so a test that flips `process.platform` is honoured. */
  platform?: NodeJS.Platform;
  /** Whether a drive letter's root is there. Default `existsSync`. */
  exists?: (path: string) => boolean;
  /** The home folder for the non-Windows Home entry. Default `os.homedir()`, called each time. */
  home?: () => string;
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function listLocalRoots({
  platform = process.platform,
  exists = existsSync,
  home = homedir,
}: LocalRootsOptions = {}): LocalRoot[] {
  if (platform === 'win32') {
    const roots: LocalRoot[] = [];
    for (const letter of DRIVE_LETTERS) {
      const path = `${letter}:\\`;
      if (exists(path)) roots.push({ name: path, path, kind: 'drive' });
    }
    return roots;
  }
  return [
    { name: 'Home', path: home(), kind: 'home' },
    { name: '/', path: '/', kind: 'root' },
  ];
}
