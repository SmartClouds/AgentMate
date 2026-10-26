import { quoteForShell } from '@runova/core';
import type { DeployCoreLayout } from '../../../shared/deployTypes';
import { type CoreNames, coreNames, LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';

/**
 * The root commands that install, roll back and remove the server core, as data. The installer
 * runs them one by one through a root shell and reports each step; nothing here touches a server.
 *
 * Safety rules the order encodes:
 * - The download is copied into a folder only root can write to and checked against its
 *   published SHA-256 there, before anything unpacks it. Nothing is ever unpacked as root from a
 *   folder the login user could swap files in.
 * - Releases are unpacked beside the running one and switched to with an atomic symlink swap, so
 *   a failed start can go straight back to the previous release.
 *
 * New servers get the Runova layout. A server set up before the rename is upgraded in its own
 * (legacy) layout first, since every tarball carries the old names too, and then moved with the
 * core's `migrate-layout` (see `migrateStep`).
 */

export const CORE_ROOT = RUNOVA_CORE.root;

/** Where the migration leaves the old runtime folder's link to the new one, made at every boot. */
const RUNTIME_LINK_CONFIG = '/etc/tmpfiles.d/runova-core-compat.conf';

export type InstallStepId =
  | 'verify'
  | 'group'
  | 'extract'
  | 'selinux'
  | 'unit'
  | 'switch'
  | 'start'
  | 'cleanup'
  | 'rollback'
  | 'migrate'
  | 'stop'
  | 'remove';

export interface PlanStep {
  id: InstallStepId;
  title: string;
  command: string;
}

export interface InstallPlanInput {
  version: string;
  sha256: string;
  /** The tarball's file name, from the release manifest. */
  file: string;
  /** Where the tarball was uploaded, in a folder the login user owns. */
  stagingFile: string;
  loginUser: string;
  rootLogin: boolean;
  selinux: boolean;
  /** The release `current` pointed at before this install, if any. */
  previousRelease: string | null;
  /** The layout to install in: the server's own when it has a core, otherwise the Runova one. */
  layout?: DeployCoreLayout;
}

/** The verify step's exit code when the download does not match its checksum. */
export const CHECKSUM_MISMATCH_EXIT = 97;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARBALL = /^runova-core-[0-9A-Za-z.+-]+-linux-(x64|arm64)\.tar\.gz$/;
const RELEASE_NAME = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

const q = (value: string): string => quoteForShell(value, 'posix');

/** Whether `path` is a release folder the installer made, in either layout, and so safe to switch back to. */
export function isReleasePath(path: string, names?: CoreNames): boolean {
  return (names ? [names] : [RUNOVA_CORE, LEGACY_CORE]).some(
    (layout) =>
      path.startsWith(`${layout.releases}/`) &&
      RELEASE_NAME.test(path.slice(layout.releases.length + 1)),
  );
}

function assertReleasePath(path: string, names: CoreNames): void {
  if (!isReleasePath(path, names)) throw new Error(`${path} is not a server core release.`);
}

/** The layout a release folder belongs to. */
export function layoutOfRelease(path: string): DeployCoreLayout {
  return isReleasePath(path, LEGACY_CORE) ? 'legacy' : 'runova';
}

export function releaseDirectory(
  version: string,
  sha256: string,
  layout: DeployCoreLayout = 'runova',
): string {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a release version.`);
  if (!SHA256.test(sha256)) throw new Error('The release checksum is not a SHA-256.');
  return `${coreNames(layout).releases}/${version}-${sha256.slice(0, 12)}`;
}

export function installSteps(input: InstallPlanInput): PlanStep[] {
  if (!TARBALL.test(input.file))
    throw new Error(`"${input.file}" is not a server core release file.`);
  const names = coreNames(input.layout ?? 'runova');
  const { root: coreRoot, releases, current, unitPath: unit } = names;
  const incoming = `${coreRoot}/incoming`;
  if (input.previousRelease !== null) assertReleasePath(input.previousRelease, names);
  const release = releaseDirectory(input.version, input.sha256, names.layout);
  const incomingFile = `${incoming}/${input.file}`;
  const unpack = `${release}.new`;

  const steps: PlanStep[] = [
    {
      id: 'verify',
      title: 'Check the download against its published checksum',
      command: [
        `install -d -m 0755 -o root -g root ${coreRoot}`,
        `rm -rf ${incoming}`,
        `install -d -m 0700 ${incoming}`,
        `cp -- ${q(input.stagingFile)} ${incomingFile}`,
        `cd ${incoming}`,
        `{ printf '%s  %s\\n' ${input.sha256} ${input.file} | sha256sum -c --status || exit ${CHECKSUM_MISMATCH_EXIT}; }`,
      ].join(' && '),
    },
    {
      id: 'group',
      title: `Create the ${names.group} group`,
      command: [
        `getent group ${names.group} >/dev/null || groupadd --system ${names.group}`,
        ...(input.rootLogin ? [] : [`usermod -aG ${names.group} ${q(input.loginUser)}`]),
      ].join(' && '),
    },
    {
      id: 'extract',
      title: `Unpack release ${input.version}`,
      command: [
        `install -d -m 0755 ${releases}`,
        `rm -rf ${unpack}`,
        `install -d -m 0755 ${unpack}`,
        `tar -xzf ${incomingFile} -C ${unpack} --no-same-owner --no-same-permissions`,
        `test -f ${unpack}/${names.binary}`,
        `test -f ${unpack}/${names.unitFile}`,
        `chown -R root:root ${unpack}`,
        // The other name is the same file (a hard link), so it takes the mode too.
        `chmod 0755 ${unpack}/${names.binary}`,
        `chmod 0644 ${unpack}/${names.unitFile}`,
        `rm -rf ${release}`,
        `mv -T ${unpack} ${release}`,
      ].join(' && '),
    },
  ];

  if (input.selinux) {
    steps.push({
      id: 'selinux',
      title: 'Label the files for SELinux',
      command: `restorecon -R ${coreRoot}`,
    });
  }

  const keep = [release, input.previousRelease]
    .filter((value): value is string => Boolean(value))
    .map((path) => path.slice(releases.length + 1));

  steps.push(
    {
      id: 'unit',
      title: 'Install the systemd service',
      command: `install -m 0644 -o root -g root ${release}/${names.unitFile} ${unit} && systemctl daemon-reload`,
    },
    {
      id: 'switch',
      title: `Switch to release ${input.version}`,
      command: `ln -sfn ${release} ${coreRoot}/current.new && mv -Tf ${coreRoot}/current.new ${current}`,
    },
    {
      id: 'start',
      title: 'Start the server core',
      // Type=notify: restart only returns once the core is listening, and fails otherwise.
      command: `systemctl enable ${names.unit} >/dev/null 2>&1; systemctl restart ${names.unit}`,
    },
    {
      id: 'cleanup',
      title: 'Remove the download and older releases',
      command: [
        `rm -rf ${incoming}`,
        `cd ${releases}`,
        `for release in *; do case "$release" in ${keep.map(q).join('|')}) ;; *) rm -rf -- "$release" ;; esac; done`,
      ].join(' && '),
    },
  );
  return steps;
}

export function rollbackSteps(previousRelease: string): PlanStep[] {
  const names = coreNames(layoutOfRelease(previousRelease));
  assertReleasePath(previousRelease, names);
  const { root: coreRoot, current, unitPath: unit } = names;
  const previous = q(previousRelease);
  return [
    {
      id: 'rollback',
      title: 'Go back to the previous release',
      command: [
        `ln -sfn ${previous} ${coreRoot}/current.new`,
        `mv -Tf ${coreRoot}/current.new ${current}`,
        `install -m 0644 -o root -g root ${previous}/${names.unitFile} ${unit}`,
        'systemctl daemon-reload',
        `systemctl restart ${names.unit}`,
      ].join(' && '),
    },
  ];
}

/**
 * Moves a server from the legacy layout to the Runova one, after it was upgraded in place. The
 * core does it (`migrate-layout`, in a unit of its own, waited for), and puts everything back when
 * a step fails; the exit code says how it went (0 moved, 1 put back, 2 refused, 3 needs a look).
 */
export function migrateStep(): PlanStep {
  return {
    id: 'migrate',
    title: 'Move the core to its new name',
    command: `${LEGACY_CORE.current}/${RUNOVA_CORE.binary} migrate-layout`,
  };
}

/** The exit code of a migration that failed and was put back: the server runs as before. */
export const MIGRATION_ROLLED_BACK_EXIT = 1;

/**
 * Removes the core of either layout. After a migration the old paths are links to the new ones,
 * which go with it.
 */
export function uninstallSteps(options: {
  keepData: boolean;
  layout?: DeployCoreLayout;
}): PlanStep[] {
  const names = coreNames(options.layout ?? 'runova');
  const links =
    names.layout === 'runova'
      ? [
          `rm -rf ${LEGACY_CORE.root}`,
          `rm -f ${RUNTIME_LINK_CONFIG}`,
          ...[
            LEGACY_CORE.dataDirectory,
            LEGACY_CORE.configDirectory,
            LEGACY_CORE.socketPath.slice(0, -'/core.sock'.length),
          ].map((path) => `{ ! test -L ${path} || rm -f ${path}; }`),
        ]
      : [];
  return [
    {
      id: 'stop',
      title: 'Stop the server core',
      command: `systemctl disable --now ${names.unit} >/dev/null 2>&1 || true; rm -f ${names.unitPath}; systemctl daemon-reload`,
    },
    {
      id: 'remove',
      title: options.keepData
        ? 'Remove the program and keep its data'
        : 'Remove the program and its data',
      command: options.keepData
        ? [`rm -rf ${names.root}`, ...links].join(' && ')
        : [
            `rm -rf ${names.root}`,
            ...links,
            `rm -rf ${names.dataDirectory} ${names.configDirectory}`,
            `{ ! getent group ${names.group} >/dev/null || groupdel ${names.group}; }`,
          ].join(' && '),
    },
  ];
}
