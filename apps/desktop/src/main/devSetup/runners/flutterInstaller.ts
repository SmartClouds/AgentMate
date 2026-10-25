import {
  type FlutterRelease,
  flutterBinDir,
  flutterInstallRoot,
  flutterManifestUrl,
  pickFlutterRelease,
} from '@agentmat/core';
import type { CancelToken } from '../../process/spawnStreaming';
import type { UserPathResult } from '../userPath';
import { type CommandResult, createDownloadHooks, type ManagedKit } from './managed';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * Installing Flutter by hand. Flutter has no winget package, so the app downloads the official
 * archive, checks its SHA-256, unpacks it next to where it will live, moves it into place in one
 * step and puts its commands on the PATH. Then it runs Flutter once, which is when Flutter fetches
 * Dart and its own tools, so the first command the person types is not the slow one.
 *
 * Everything that touches the machine is injected, which is what lets this be tested with a made
 * up disk: the order of the steps, what is cleaned up on each way out, and every message.
 */

/** Flutter's first run downloads a lot, but keeps printing while it does. */
const FIRST_RUN_IDLE_MS = 10 * 60_000;

export interface FlutterInstallerDeps {
  kit: ManagedKit;
  addToUserPath: (dir: string) => Promise<UserPathResult>;
  runCommand: (
    command: string,
    args: readonly string[],
    options: { token: CancelToken; onLine: (line: string) => void; idleMs: number },
  ) => Promise<CommandResult>;
}

const CANCELLED: RunResult = { ok: false, code: null, cancelled: true };
const fail = (message: string): RunResult => ({ ok: false, code: null, cancelled: false, message });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFlutterInstaller(deps: FlutterInstallerDeps): {
  run: (hooks: RunHooks) => Promise<RunResult>;
  /** Brings the Flutter that is already there up to date. `foundAt` is where it was found. */
  update: (hooks: RunHooks, foundAt: string | null) => Promise<RunResult>;
} {
  const { kit } = deps;
  const sep = kit.os === 'win32' ? '\\' : '/';
  const root = flutterInstallRoot(kit.os, kit.home);
  const binDir = flutterBinDir(kit.os, kit.home);
  const commandName = kit.os === 'win32' ? 'flutter.bat' : 'flutter';
  const flutterCommand = `${binDir}${sep}${commandName}`;

  /** True when the file is there, can be read and is exactly the archive Flutter published. */
  async function isWholeArchive(path: string, sha256: string): Promise<boolean> {
    try {
      return (await kit.hashFile(path, 'sha256')).toLowerCase() === sha256;
    } catch {
      return false;
    }
  }

  /** Gets the checked archive onto the disk at `archivePath`. Null means it is there. */
  async function obtainArchive(
    release: FlutterRelease,
    archivePath: string,
    hooks: RunHooks,
  ): Promise<RunResult | null> {
    // The download goes to a .part file and only gets the archive's name once it has finished. So
    // a file with the archive's name is a whole one, left by a cancel or failure while checking,
    // unpacking or moving. Flutter publishes no size, so asking the server to "carry on" a whole
    // file is refused every time and the download would retry for ever. Instead the checksum says
    // whether it can still be used, and if not it is thrown away. A .part is half a file: it is
    // carried on from, never checked.
    const partPath = `${archivePath}.part`;
    if (await kit.fs.exists(archivePath)) {
      hooks.onProgress({ phase: 'verifying', fraction: null });
      const whole = await isWholeArchive(archivePath, release.sha256);
      if (!whole) await kit.fs.rm(archivePath);
      if (hooks.token.cancelled) return CANCELLED;
      if (whole) {
        hooks.onLine('Using the Flutter download from an earlier try.');
        return null;
      }
    }

    const download = createDownloadHooks(hooks);
    try {
      await kit.download(
        { url: release.url, destPath: partPath, expectedSize: null },
        download.hooks,
      );
    } catch {
      // A cancel stops the download by making it throw, which is not a failure. The .part stays
      // either way, so the next try carries on from where this stopped.
      if (hooks.token.cancelled) return CANCELLED;
      if (!download.gaveUp()) {
        return fail('The Flutter download failed. Check your internet connection and try again.');
      }
      // Giving up looks the same for a dead connection and for a .part that is already whole (the
      // app closed between the last byte and the rename), which the server answers with "nothing
      // left to send" on every try. The checksum says which it was.
      const alreadyWhole =
        (await kit.fs.exists(partPath)) && (await isWholeArchive(partPath, release.sha256));
      if (!alreadyWhole) {
        return fail(
          'The Flutter download keeps losing its connection, so it was stopped. Check your internet connection and try again.',
        );
      }
    }
    await kit.fs.rename(partPath, archivePath);
    if (hooks.token.cancelled) return CANCELLED;

    hooks.onProgress({ phase: 'verifying', fraction: null });
    const actual = await kit.hashFile(archivePath, 'sha256');
    if (actual.toLowerCase() !== release.sha256) {
      await kit.fs.rm(archivePath);
      return fail('The download did not match its checksum, so it was deleted. Try again.');
    }
    if (hooks.token.cancelled) return CANCELLED;
    return null;
  }

  /** Downloads, checks, unpacks and moves Flutter into place. Null means it worked. */
  async function fetchAndUnpack(hooks: RunHooks): Promise<RunResult | null> {
    let text: string;
    try {
      text = await kit.fetchText(flutterManifestUrl(kit.os));
    } catch {
      if (hooks.token.cancelled) return CANCELLED;
      return fail(
        'Could not reach the Flutter download list. Check your internet connection and try again.',
      );
    }
    // The list cannot be interrupted, so a cancel that came during it is only seen here. Without
    // this the gigabyte download that comes next would start anyway.
    if (hooks.token.cancelled) return CANCELLED;
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      return fail('The Flutter download list was not in the expected format.');
    }
    const release = pickFlutterRelease(manifest, kit.os, kit.arch);
    if (!release) return fail('Flutter does not publish a build for this computer.');

    hooks.onLine(`Installing Flutter ${release.version}`);
    const archivePath = `${kit.workDir}${sep}flutter-${release.version}.${release.format}`;
    const problem = await obtainArchive(release, archivePath, hooks);
    if (problem) return problem;

    hooks.onProgress({ phase: 'extracting', fraction: null });
    // Beside the final folder, so moving it into place stays on one drive and is a rename.
    const staging = `${root.slice(0, root.lastIndexOf(sep))}${sep}.agentmate-flutter-${kit.randomId()}`;
    await kit.fs.mkdir(staging);
    try {
      const extracted = await kit.extract(archivePath, staging, {
        token: hooks.token,
        onLine: hooks.onLine,
      });
      if (hooks.token.cancelled) return CANCELLED;
      if (!extracted.ok) return fail(`Could not unpack Flutter. ${extracted.message ?? ''}`.trim());

      const unpacked = `${staging}${sep}flutter`;
      if (!(await kit.fs.exists(`${unpacked}${sep}bin${sep}${commandName}`))) {
        return fail('The Flutter archive did not contain what was expected.');
      }
      // Only an empty folder gets here (anything else was refused before the download).
      if (await kit.fs.exists(root)) await kit.fs.rm(root);
      await kit.fs.rename(unpacked, root);
    } finally {
      await kit.fs.rm(staging);
    }
    await kit.fs.rm(archivePath);
    return null;
  }

  return {
    async run(hooks) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'preparing', fraction: null });

      if (!(await kit.fs.exists(flutterCommand))) {
        // A folder of the person's own is theirs: say so now, not after a gigabyte of download.
        if ((await kit.fs.exists(root)) && !(await kit.fs.isEmptyDir(root))) {
          return fail(`A folder already exists at ${root}. Move or remove it, then try again.`);
        }
        const problem = await fetchAndUnpack(hooks);
        if (problem) return problem;
      }

      hooks.onProgress({ phase: 'installing', fraction: null });
      try {
        await deps.addToUserPath(binDir);
      } catch (error) {
        // Flutter is found in this folder anyway, so this is worth saying but not worth stopping.
        hooks.onLine(
          `Could not add Flutter to your PATH: ${errorMessage(error)} You can add this folder yourself: ${binDir}`,
        );
      }
      if (hooks.token.cancelled) return CANCELLED;

      const firstRun = await deps.runCommand(flutterCommand, ['--version'], {
        token: hooks.token,
        onLine: hooks.onLine,
        idleMs: FIRST_RUN_IDLE_MS,
      });
      if (firstRun.cancelled || hooks.token.cancelled) return CANCELLED;
      if (firstRun.timedOut) {
        return fail('Flutter is in place, but its first run stopped responding.');
      }
      if (firstRun.code !== 0) {
        return fail(
          'Flutter is in place, but its first run did not finish. Open the log for details.',
        );
      }
      return { ok: true, code: 0, cancelled: false };
    },

    async update(hooks, foundAt) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'preparing', fraction: null });

      // The copy the person has is the one to update, wherever it is, and the official archive
      // and a clone both carry the git history that `flutter upgrade` works from.
      const command = foundAt ?? flutterCommand;
      if (!(await kit.fs.exists(command)))
        return fail('Flutter was not found, so it was not updated.');
      const sdkRoot = parentOf(parentOf(command, sep), sep);
      if (!(await kit.fs.exists(`${sdkRoot}${sep}.git`))) {
        return fail(
          'This copy of Flutter was not installed with git, so it cannot update itself. Update it the way you installed it.',
        );
      }

      hooks.onProgress({ phase: 'installing', fraction: null });
      hooks.onLine('Running flutter upgrade');
      const upgrade = await deps.runCommand(command, ['upgrade'], {
        token: hooks.token,
        onLine: hooks.onLine,
        idleMs: FIRST_RUN_IDLE_MS,
      });
      if (upgrade.cancelled || hooks.token.cancelled) return CANCELLED;
      if (upgrade.timedOut) return fail('flutter upgrade stopped responding, so it was stopped.');
      if (upgrade.code !== 0) {
        return fail('flutter upgrade did not finish. Open the log for details.');
      }
      return { ok: true, code: 0, cancelled: false };
    },
  };
}

/** The folder a path is in. */
function parentOf(path: string, sep: string): string {
  const cut = path.lastIndexOf(sep);
  return cut > 0 ? path.slice(0, cut) : path;
}
