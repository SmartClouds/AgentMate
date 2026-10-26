import type { DevOs, PackageManagerId } from '@runova/core';
import type { ProbeResult } from './probe';

/**
 * Which package managers this machine has, so a recipe is only offered one-click when the tool it
 * runs through is actually there. Windows 10 without App Installer has no winget, for instance.
 */

/** The managers worth asking about on each OS, in the order Linux prefers them. */
const MANAGERS_BY_OS: Record<DevOs, readonly PackageManagerId[]> = {
  win32: ['winget'],
  darwin: ['brew'],
  linux: ['apt-get', 'dnf', 'pacman'],
};

const CACHE_TTL_MS = 60_000;

export interface PackageManagerDeps {
  os: DevOs;
  probe: (command: string, args: readonly string[]) => Promise<ProbeResult>;
  now: () => number;
}

export interface PackageManagerDetector {
  detect(options?: { force?: boolean }): Promise<PackageManagerId[]>;
}

export function createPackageManagerDetector(deps: PackageManagerDeps): PackageManagerDetector {
  let cached: { at: number; managers: PackageManagerId[] } | null = null;
  let inFlight: Promise<PackageManagerId[]> | null = null;

  async function lookup(): Promise<PackageManagerId[]> {
    const found: PackageManagerId[] = [];
    for (const manager of MANAGERS_BY_OS[deps.os]) {
      try {
        const result = await deps.probe(manager, ['--version']);
        if (result.ok) found.push(manager);
      } catch {
        // A probe that could not run is a manager we cannot use, which is the same as absent.
      }
    }
    return found;
  }

  return {
    async detect(options = {}) {
      if (!options.force && cached && deps.now() - cached.at < CACHE_TTL_MS) return cached.managers;
      // Several rows ask at once when the page opens; they should share one round of probes.
      inFlight ??= lookup()
        .then((managers) => {
          cached = { at: deps.now(), managers };
          return managers;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
