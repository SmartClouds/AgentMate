import { execFile, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DownloadFatalError } from './resumableDownload';

const execFileAsync = promisify(execFile);

/**
 * macOS installs bypass Squirrel.Mac. Squirrel only installs an update into an app signed
 * with a Developer ID, and the release builds are unsigned, so electron-updater's handoff
 * never finished: the dialog sat at 100% (or, before that, "Restart now" did nothing).
 *
 * Instead the verified zip is unpacked next to the running bundle, and a small shell script
 * swaps the bundles once the app has exited. Unpacking beside the target keeps both moves
 * on one volume, so each is a plain rename.
 */

export interface PreparedMacUpdate {
  /** The running bundle, e.g. /Applications/Runova.app. */
  target: string;
  /** The new bundle, unpacked and ready to move into place. */
  stagedApp: string;
  /** Where the new bundle goes: `target`, or beside it under the new bundle's own name when the
   *  app was renamed (an install from before the rename is replaced by Runova.app). */
  destination: string;
  /** Hidden folder beside `target` holding `stagedApp`; the script removes it when done. */
  stagingDir: string;
  scriptPath: string;
  logPath: string;
}

/** The .app bundle holding `execPath` (…/Runova.app/Contents/MacOS/Runova). */
export function appBundleFor(execPath: string): string | null {
  const bundle = dirname(dirname(dirname(execPath)));
  return bundle.endsWith('.app') ? bundle : null;
}

/** Picks the release zip for this Mac's chip, whichever build happens to be running. */
export function pickMacZip(names: string[], appleSilicon: boolean): string | null {
  const zips = names.filter((name) => name.toLowerCase().endsWith('.zip'));
  const isArm = (name: string): boolean => name.includes('arm64');
  // Apple Silicon can fall back to the Intel build under Rosetta; an Intel Mac can't run arm64.
  if (appleSilicon) return zips.find(isArm) ?? zips.find((name) => !isArm(name)) ?? null;
  return zips.find((name) => !isArm(name)) ?? null;
}

/**
 * Runs as a detached process. Waits for the app to exit (at most a minute), moves the old
 * bundle aside, moves the new one in (under its own name when that differs), and puts the old
 * one back if that second move fails.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"
target="$2"
staged="$3"
staging="$4"
relaunch="$5"
log="$6"
destination="\${7:-$target}"
exec >>"$log" 2>&1
echo "$(date) installing $staged over $target"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then
    echo "$(date) app is still running, giving up"
    exit 1
  fi
  sleep 0.1
done
backup="$staging/previous.app"
rm -rf "$backup"
opened="$target"
if mv "$target" "$backup"; then
  if mv "$staged" "$destination"; then
    rm -rf "$staging"
    opened="$destination"
    echo "$(date) installed at $destination"
  else
    mv "$backup" "$target"
    echo "$(date) could not move the new version in, restored the old one"
  fi
else
  echo "$(date) could not move the old version aside"
fi
if [ "$relaunch" = "1" ]; then
  open "$opened"
fi
`;

/**
 * Unpacks the update and writes the install script, so the swap itself can start
 * synchronously from a quit handler. Throws a DownloadFatalError when retrying can't help.
 */
export async function prepareMacUpdate(options: {
  zipPath: string;
  execPath: string;
  workDir: string;
}): Promise<PreparedMacUpdate> {
  const target = appBundleFor(options.execPath);
  if (target == null) {
    throw new DownloadFatalError('Could not find the Runova app bundle to update.');
  }
  if (target.includes('/AppTranslocation/')) {
    throw new DownloadFatalError(
      'macOS is running Runova from a temporary copy. Move Runova to the Applications folder, open it from there, and update again.',
    );
  }
  const parent = dirname(target);
  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new DownloadFatalError(
      `Runova can't write to ${parent}, so it can't replace itself. Download the new version from the releases page instead.`,
    );
  }

  const stagingDir = join(parent, `.${basename(target, '.app')}-update`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  // ditto keeps the symlinks and permissions inside the framework bundles, which unzip mangles.
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', options.zipPath, stagingDir]);
  const appName = (await readdir(stagingDir)).find((name) => name.endsWith('.app'));
  if (appName == null) {
    await rm(stagingDir, { recursive: true, force: true });
    throw new DownloadFatalError('The update archive did not contain an app.');
  }
  const stagedApp = join(stagingDir, appName);
  // A bundle from before the rename is replaced by one under the new name, unless something
  // already sits at that name.
  const renamed = join(parent, appName);
  const destination = renamed !== target && !existsSync(renamed) ? renamed : target;
  // The app downloads the zip itself, so it normally carries no quarantine flag, but a copy
  // that does would be blocked by Gatekeeper on first launch.
  await execFileAsync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagedApp]).catch(
    () => undefined,
  );

  await mkdir(options.workDir, { recursive: true });
  const scriptPath = join(options.workDir, 'install-update.sh');
  await writeFile(scriptPath, INSTALL_SCRIPT, { mode: 0o755 });
  return {
    target,
    stagedApp,
    destination,
    stagingDir,
    scriptPath,
    logPath: join(options.workDir, 'install.log'),
  };
}

/** Starts the swap in the background. It waits for `pid` to exit before touching anything. */
export function launchMacInstall(
  prepared: PreparedMacUpdate,
  pid: number,
  relaunch: boolean,
): void {
  const child = spawn(
    '/bin/sh',
    [
      prepared.scriptPath,
      String(pid),
      prepared.target,
      prepared.stagedApp,
      prepared.stagingDir,
      relaunch ? '1' : '0',
      prepared.logPath,
      prepared.destination,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}
