import { execFileSync } from 'node:child_process';

/**
 * The Intel build of AgentMate opens fine on an Apple Silicon Mac, but macOS runs it through
 * Rosetta, and every process it starts runs as Intel too. The Command Line Tools that ship for
 * Apple Silicon have no Intel copy of libxcrun, so /usr/bin/git (and every other xcrun shim)
 * dies with "missing compatible architecture" in the app and in its terminals. Only the Apple
 * Silicon build fixes that.
 */

export const RELEASES_URL = 'https://github.com/SmartClouds/AgentMate/releases/latest';

let translated: boolean | null = null;

/** True when this is the Intel build running under Rosetta on an Apple Silicon Mac. */
export function isRunningUnderRosetta(): boolean {
  if (translated != null) return translated;
  translated = false;
  if (process.platform === 'darwin' && process.arch === 'x64') {
    try {
      // Real Intel Macs don't have this key, so sysctl fails there and the answer stays false.
      const value = execFileSync('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      translated = value.trim() === '1';
    } catch {
      translated = false;
    }
  }
  return translated;
}

/** The error macOS prints when an Intel process runs an xcrun shim on Apple Silicon. */
export function isXcrunArchMismatch(stderr: string): boolean {
  return /libxcrun/.test(stderr) && /missing compatible architecture/.test(stderr);
}

export const ROSETTA_GIT_MESSAGE =
  'This Mac has an Apple Silicon chip, but the Intel version of AgentMate is installed, so git ' +
  "can't run. Download the Apple Silicon (arm64) version from " +
  `${RELEASES_URL} and install it over this one. Your projects and settings are kept.`;
