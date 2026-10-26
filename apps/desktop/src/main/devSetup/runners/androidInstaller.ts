import type { ChildProcess } from 'node:child_process';
import { ANDROID_REPOSITORY_MANIFEST_URL, parseCmdlineToolsArchive } from '@runova/core';
import type { SdkManagerStreamHandlers } from '../../android/exec';
import type { ResolvedAndroidSdk } from '../../android/sdk';
import { createDownloadHooks, type ManagedKit } from './managed';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * Setting up the Android SDK without Android Studio. Google publishes the command-line tools as a
 * plain zip; Runova downloads that, checks it and puts it in `cmdline-tools/latest` inside the
 * SDK folder. Everything after that (platform tools, the emulator, a platform, a system image and
 * the licenses) is `sdkmanager`, which this drives and reports on.
 *
 * Licenses are the part to be careful with. They are only ever accepted in the licenses step,
 * which the install flow does not start until the person has agreed. A package step that meets a
 * license it was not expecting says no and tells them, rather than accepting it for them.
 */

/** sdkmanager prints while it works; this long without a word and it is treated as stuck. */
const IDLE_MS = 10 * 60_000;

export interface AndroidInstallerDeps {
  kit: ManagedKit;
  /** The SDK as Runova sees it now. */
  androidSdk: () => Promise<ResolvedAndroidSdk>;
  refreshAndroidSdk: () => void;
  /** Where a new SDK goes when none exists. */
  defaultSdkRoot: () => string;
  runSdkManager: (
    sdk: ResolvedAndroidSdk,
    args: string[],
    handlers: SdkManagerStreamHandlers,
  ) => Promise<void>;
  killProcess: (child: ChildProcess) => void;
}

const CANCELLED: RunResult = { ok: false, code: null, cancelled: true };
const OK: RunResult = { ok: true, code: 0, cancelled: false };
const fail = (message: string): RunResult => ({ ok: false, code: null, cancelled: false, message });

/** A real SDK package id: letters, digits and `; . _ -`, and never something that reads as a flag. */
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9;._-]*$/;
const JAVA_MISSING = /JAVA_HOME|no 'java' command|Unable to locate a Java Runtime/i;
const NO_TOOLS = 'The Android command-line tools are not installed yet.';

function phaseOf(label: string): 'downloading' | 'installing' | null {
  if (/download/i.test(label)) return 'downloading';
  if (/unzip|install|extract/i.test(label)) return 'installing';
  return null;
}

export function createAndroidInstaller(deps: AndroidInstallerDeps): {
  runCmdlineTools: (hooks: RunHooks) => Promise<RunResult>;
  runLicenses: (hooks: RunHooks) => Promise<RunResult>;
  runPackage: (sdkPackage: string, hooks: RunHooks) => Promise<RunResult>;
} {
  const { kit } = deps;
  const sep = kit.os === 'win32' ? '\\' : '/';

  /**
   * Runs sdkmanager and works out how it ended. `answer` decides what to say to a license
   * question; the log, progress, cancel and the stuck-for-ten-minutes check are the same for both.
   */
  async function runSdkManagerStep(
    sdk: ResolvedAndroidSdk,
    args: string[],
    hooks: RunHooks,
    answer: (prompt: string) => string,
  ): Promise<{ failure: string | null; declinedLicense: boolean }> {
    let child: ChildProcess | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    let lastLine = '';
    let javaMissing = false;
    let declinedLicense = false;
    let lastPhase: 'downloading' | 'installing' | null = null;

    const stop = (): void => {
      if (child) deps.killProcess(child);
    };
    const touch = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        stop();
      }, IDLE_MS);
    };
    hooks.onCancel?.(stop);
    touch();

    try {
      await deps.runSdkManager(sdk, args, {
        onSpawn: (spawned) => {
          child = spawned;
        },
        onLine: (line) => {
          touch();
          const text = line.trim();
          if (!text) return;
          lastLine = text;
          if (JAVA_MISSING.test(text)) javaMissing = true;
          hooks.onLine(text);
        },
        onProgress: ({ percent, label }) => {
          touch();
          const phase = phaseOf(label) ?? lastPhase;
          lastPhase = phase;
          hooks.onProgress({
            ...(phase ? { phase } : {}),
            fraction: percent / 100,
            detail: `${percent}%`,
          });
        },
        onPrompt: (prompt) => {
          touch();
          const reply = answer(prompt);
          if (reply.trim().toLowerCase().startsWith('n')) declinedLicense = true;
          return reply;
        },
      });
      return { failure: null, declinedLicense };
    } catch (error) {
      if (stalled) {
        return {
          failure: 'The Android tools stopped responding, so they were stopped.',
          declinedLicense,
        };
      }
      if (javaMissing) {
        return {
          failure:
            'The Android tools need Java and could not find it. Open a new terminal or restart Runova, then try again.',
          declinedLicense,
        };
      }
      return {
        failure: lastLine || (error instanceof Error ? error.message : String(error)),
        declinedLicense,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sdkWithTools(): Promise<ResolvedAndroidSdk | null> {
    const sdk = await deps.androidSdk();
    return sdk.paths.sdkmanager ? sdk : null;
  }

  return {
    async runCmdlineTools(hooks) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'preparing', fraction: null });

      const sdk = await deps.androidSdk();
      if (sdk.status === 'override-invalid') {
        return fail('The Android SDK folder set in Settings is not an SDK. Fix or clear it there.');
      }
      if (sdk.paths.sdkmanager) return OK;
      const root = sdk.status === 'found' && sdk.root ? sdk.root : deps.defaultSdkRoot();

      let xml: string;
      try {
        xml = await kit.fetchText(ANDROID_REPOSITORY_MANIFEST_URL);
      } catch {
        if (hooks.token.cancelled) return CANCELLED;
        return fail(
          'Could not reach the Android download list. Check your internet connection and try again.',
        );
      }
      // The list cannot be interrupted, so a cancel that came during it is only seen here. Without
      // this the download that comes next would start anyway.
      if (hooks.token.cancelled) return CANCELLED;
      const archive = parseCmdlineToolsArchive(xml, kit.os, kit.arch);
      if (!archive) return fail('The Android download list was not in the expected format.');

      const zipPath = `${kit.workDir}${sep}commandlinetools-${archive.revision}.zip`;
      const download = createDownloadHooks(hooks);
      try {
        await kit.download(
          { url: archive.url, destPath: zipPath, expectedSize: archive.size },
          download.hooks,
        );
      } catch {
        if (hooks.token.cancelled) return CANCELLED;
        if (download.gaveUp()) {
          return fail(
            'The Android tools download keeps losing its connection, so it was stopped. Check your internet connection and try again.',
          );
        }
        return fail(
          'The Android tools download failed. Check your internet connection and try again.',
        );
      }
      if (hooks.token.cancelled) return CANCELLED;

      hooks.onProgress({ phase: 'verifying', fraction: null });
      if ((await kit.hashFile(zipPath, 'sha1')).toLowerCase() !== archive.sha1) {
        await kit.fs.rm(zipPath);
        return fail('The download did not match its checksum, so it was deleted. Try again.');
      }
      if (hooks.token.cancelled) return CANCELLED;

      hooks.onProgress({ phase: 'extracting', fraction: null });
      const staging = `${root}${sep}.runova-cmdline-tools-${kit.randomId()}`;
      await kit.fs.mkdir(staging);
      try {
        const extracted = await kit.extract(zipPath, staging, {
          token: hooks.token,
          onLine: hooks.onLine,
        });
        if (hooks.token.cancelled) return CANCELLED;
        if (!extracted.ok) {
          return fail(`Could not unpack the Android tools. ${extracted.message ?? ''}`.trim());
        }
        // The zip holds one folder, named cmdline-tools, which has to end up called "latest".
        const unpacked = `${staging}${sep}cmdline-tools`;
        const binary = `${unpacked}${sep}bin${sep}${kit.os === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'}`;
        if (!(await kit.fs.exists(binary))) {
          return fail('The Android tools archive did not contain what was expected.');
        }
        const parent = `${root}${sep}cmdline-tools`;
        const latest = `${parent}${sep}latest`;
        await kit.fs.mkdir(parent);
        if (await kit.fs.exists(latest)) await kit.fs.rm(latest);
        await kit.fs.rename(unpacked, latest);
      } finally {
        await kit.fs.rm(staging);
      }
      await kit.fs.rm(zipPath);
      deps.refreshAndroidSdk();
      return OK;
    },

    async runLicenses(hooks) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'preparing', fraction: null });
      const sdk = await sdkWithTools();
      if (!sdk) return fail(NO_TOOLS);

      // Answered yes, which is sound only because the install flow makes the person agree to the
      // licenses before this step is ever started.
      const { failure } = await runSdkManagerStep(sdk, ['--licenses'], hooks, () => 'y\n');
      if (hooks.token.cancelled) return CANCELLED;
      if (failure) return fail(failure);
      deps.refreshAndroidSdk();
      return OK;
    },

    async runPackage(sdkPackage, hooks) {
      if (!PACKAGE_ID.test(sdkPackage)) return fail('That is not an Android SDK package.');
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'preparing', fraction: null });
      const sdk = await sdkWithTools();
      if (!sdk) return fail(NO_TOOLS);

      const args = [...(sdk.root ? [`--sdk_root=${sdk.root}`] : []), sdkPackage];
      // A license that turns up here was not part of what the person agreed to, so it is refused.
      const { failure, declinedLicense } = await runSdkManagerStep(sdk, args, hooks, () => 'n\n');
      if (hooks.token.cancelled) return CANCELLED;
      if (declinedLicense) {
        return fail(
          'Android needs a license that has not been accepted yet. Run the Android SDK licenses step first.',
        );
      }
      if (failure) return fail(failure);
      deps.refreshAndroidSdk();
      return OK;
    },
  };
}
