import { LEGACY_CORE_NAMES } from '../../shared/deploy/coreLegacyNames';
import type { DeployCoreLayout, DeployCoreRecord } from '../../shared/deployTypes';

/**
 * The two layouts a server core can be installed in, and the names that come with each. Servers
 * set up before the rename run the legacy one until their core (1.64 or later) migrates them;
 * new installs go straight to the Runova one. A core in either layout takes both sets of wire
 * names, but a core from before the rename only knows the old set, so the app uses the old
 * names until it knows better.
 */

export interface CoreNames {
  layout: DeployCoreLayout;
  root: string;
  releases: string;
  current: string;
  binary: string;
  /** The program through the current link, as the unit starts it. */
  binaryPath: string;
  socketPath: string;
  dataDirectory: string;
  configDirectory: string;
  unit: string;
  unitFile: string;
  unitPath: string;
  group: string;
  tarballPrefix: string;
  host: string;
  authPrefix: string;
  execPrefix: string;
  versionHeader: string;
  fileHeader: string;
  sha256Header: string;
}

function names(
  layout: DeployCoreLayout,
  base: Omit<
    CoreNames,
    'layout' | 'releases' | 'current' | 'binaryPath' | 'socketPath' | 'unitFile' | 'unitPath'
  > & { runtime: string },
): CoreNames {
  const { runtime, ...rest } = base;
  return {
    ...rest,
    layout,
    releases: `${base.root}/releases`,
    current: `${base.root}/current`,
    binaryPath: `${base.root}/current/${base.binary}`,
    socketPath: `${runtime}/core.sock`,
    unitFile: `${base.unit}.service`,
    unitPath: `/etc/systemd/system/${base.unit}.service`,
  };
}

export const RUNOVA_CORE: CoreNames = names('runova', {
  root: '/opt/runova-core',
  binary: 'runova-core',
  runtime: '/run/runova-core',
  dataDirectory: '/var/lib/runova-core',
  configDirectory: '/etc/runova-core',
  unit: 'runova-core',
  group: 'runova',
  tarballPrefix: 'runova-core-',
  host: 'runova-core',
  authPrefix: 'runova-core/auth/v1',
  execPrefix: 'runova-core/exec/v1',
  versionHeader: 'x-runova-core-version',
  fileHeader: 'x-runova-core-file',
  sha256Header: 'x-runova-core-sha256',
});

export const LEGACY_CORE: CoreNames = names('legacy', {
  root: LEGACY_CORE_NAMES.root,
  binary: LEGACY_CORE_NAMES.binary,
  runtime: LEGACY_CORE_NAMES.socketPath.slice(0, -'/core.sock'.length),
  dataDirectory: LEGACY_CORE_NAMES.dataDirectory,
  configDirectory: LEGACY_CORE_NAMES.configDirectory,
  unit: LEGACY_CORE_NAMES.unit,
  group: LEGACY_CORE_NAMES.group,
  tarballPrefix: LEGACY_CORE_NAMES.tarballPrefix,
  host: LEGACY_CORE_NAMES.host,
  authPrefix: LEGACY_CORE_NAMES.authPrefix,
  execPrefix: LEGACY_CORE_NAMES.execPrefix,
  versionHeader: LEGACY_CORE_NAMES.versionHeader,
  fileHeader: LEGACY_CORE_NAMES.fileHeader,
  sha256Header: LEGACY_CORE_NAMES.sha256Header,
});

export function coreNames(layout: DeployCoreLayout): CoreNames {
  return layout === 'runova' ? RUNOVA_CORE : LEGACY_CORE;
}

/** The layout a saved core runs in. Records from before the rename have none: they are legacy. */
export function layoutOf(
  record: Pick<DeployCoreRecord, 'layout'> | null | undefined,
): DeployCoreLayout {
  return record?.layout ?? 'legacy';
}

/** The first core that runs in the Runova layout and can move a server there. */
export const FIRST_RUNOVA_CORE = '1.64.0';

/**
 * Whether `version` comes before `floor`, comparing the numbers before any "-" suffix, as the
 * core does. A version that does not read as numbers counts as older.
 */
export function isOlderCore(version: string, floor: string = FIRST_RUNOVA_CORE): boolean {
  const parts = (text: string): number[] | null => {
    const plain = text.split('-', 1)[0]?.split('.') ?? [];
    const numbers = [0, 1, 2].map((index) => (index < plain.length ? Number(plain[index]) : 0));
    return numbers.every(
      (value, index) => Number.isInteger(value) && /^\d*$/.test(plain[index] ?? ''),
    )
      ? numbers
      : null;
  };
  const have = parts(version);
  const need = parts(floor);
  if (!need) throw new Error(`"${floor}" is not a version.`);
  if (!have) return true;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return (have[index] ?? 0) < (need[index] ?? 0);
  }
  return false;
}
