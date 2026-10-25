import { posix, win32 } from 'node:path';
import {
  ANDROID_PLATFORM_PACKAGE,
  type AndroidSdkPiece,
  appliesToOs,
  type DetectSpec,
  type DevDetection,
  type DevItem,
  type DevItemId,
  type DevOs,
  expandPathTemplate,
  getDevItem,
  licensesAccepted,
  parsePackageRevision,
  parseVersion,
} from '@agentmat/core';
import type { ProbeResult } from './probe';

/**
 * Answers "is this installed, and which version" for each checklist item. All of the machine access
 * is injected (the probe, the filesystem, the Android SDK lookup), so every OS layout and every
 * odd tool output can be tested from any OS.
 */

/** The slice of the resolved Android SDK that detection needs. */
export interface DetectorAndroidSdk {
  status: 'found' | 'missing' | 'override-invalid';
  root: string | null;
  paths: {
    adb: string | null;
    emulator: string | null;
    sdkmanager: string | null;
    avdmanager: string | null;
  };
}

export interface DetectorDeps {
  os: DevOs;
  home: string;
  /** The environment a probe runs in. Read for each check, since an install can change it. */
  env: () => NodeJS.ProcessEnv;
  probe: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ProbeResult>;
  exists: (path: string) => Promise<boolean>;
  /** The file's text, or null when it cannot be read. */
  readFile: (path: string) => Promise<string | null>;
  listDir: (path: string) => Promise<string[]>;
  /** Where on PATH a command lives, without starting it. */
  findExecutable: (command: string) => Promise<string | null>;
  androidSdk: () => Promise<DetectorAndroidSdk>;
  now: () => number;
  /** How many items are checked at once. Fifteen Node tools starting together slow each other. */
  concurrency?: number;
}

export interface DevSetupDetector {
  detect(id: DevItemId, options?: { force?: boolean }): Promise<DevDetection>;
  /** What is remembered, without probing anything. Undefined for an item never checked. */
  peek(ids: readonly DevItemId[]): Record<DevItemId, DevDetection | undefined>;
  invalidate(): void;
}

const CACHE_TTL_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;
const FLUTTER_VERSION_TIMEOUT_MS = 45_000;
const WSL_TIMEOUT_MS = 15_000;

const ABSENT: DevDetection = { state: 'absent' };

function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    while (active < limit && waiting.length > 0) {
      active += 1;
      waiting.shift()?.();
    }
  };
  return async (task) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      release();
    });
    try {
      return await task();
    } finally {
      active -= 1;
      release();
    }
  };
}

export function createDevSetupDetector(deps: DetectorDeps): DevSetupDetector {
  const path = deps.os === 'win32' ? win32 : posix;
  const limit = createLimiter(Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY));
  const cache = new Map<DevItemId, { at: number; result: DevDetection }>();
  const inFlight = new Map<DevItemId, Promise<DevDetection>>();

  const found = (
    version: string | null,
    location: string | null,
    onPath: boolean,
  ): DevDetection => ({ state: 'found', version, path: location, onPath });

  const expand = (template: string): string | null =>
    expandPathTemplate(template, { os: deps.os, env: deps.env(), home: deps.home });

  async function detectCommand(
    spec: Extract<DetectSpec, { kind: 'command' }>,
  ): Promise<DevDetection> {
    const options = spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : undefined;
    const versionOf = (result: ProbeResult): string | null =>
      spec.noVersion
        ? null
        : parseVersion(
            spec.firstLineOnly ? (result.output.split(/\r?\n/)[0] ?? '') : result.output,
            {
              majorOnly: spec.majorOnly,
            },
          );

    const result = await deps.probe(spec.command, spec.args, options);
    if (result.timedOut) return { state: 'error', message: 'It did not answer in time.' };
    if (result.error) return { state: 'error', message: result.error };
    if (result.ok) {
      return found(versionOf(result), await deps.findExecutable(spec.command), true);
    }
    // It started and said no (dotnet without an SDK, docker with the engine stopped): not installed.
    if (!result.notFound) return ABSENT;

    // Not on PATH. A fresh install often is not yet, so look where installers put it.
    for (const template of spec.fallbackPaths ?? []) {
      const candidate = expand(template);
      if (!candidate || !(await deps.exists(candidate))) continue;
      const second = await deps.probe(candidate, spec.args, options);
      if (second.ok) return found(versionOf(second), candidate, false);
    }
    return ABSENT;
  }

  async function detectPaths(spec: Extract<DetectSpec, { kind: 'paths' }>): Promise<DevDetection> {
    for (const template of spec.anyOf) {
      const candidate = expand(template);
      if (candidate && (await deps.exists(candidate))) return found(null, candidate, true);
    }
    return ABSENT;
  }

  async function revisionBeside(directory: string): Promise<string | null> {
    return parsePackageRevision(await deps.readFile(path.join(directory, 'source.properties')));
  }

  async function detectFlutter(): Promise<DevDetection> {
    const binName = deps.os === 'win32' ? 'flutter.bat' : 'flutter';
    const onPath = await deps.findExecutable('flutter');
    const managedBin = path.join(deps.home, 'develop', 'flutter', 'bin', binName);
    const bin = onPath ?? ((await deps.exists(managedBin)) ? managedBin : null);
    if (!bin) return ABSENT;

    // bin/flutter lives one folder below the SDK root. The version is written beside the engine,
    // so reading it avoids starting Flutter, which can take many seconds on a cold cache.
    const root = path.dirname(path.dirname(bin));
    const raw = await deps.readFile(path.join(root, 'bin', 'cache', 'flutter.version.json'));
    let version: string | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { frameworkVersion?: unknown };
        if (typeof parsed.frameworkVersion === 'string') {
          version = parseVersion(parsed.frameworkVersion);
        }
      } catch {
        // A half-written file: fall through and ask Flutter instead.
      }
    }
    if (!version) {
      const result = await deps.probe(bin, ['--version'], {
        timeoutMs: FLUTTER_VERSION_TIMEOUT_MS,
      });
      if (result.ok) version = parseVersion(result.output);
    }
    return found(version, bin, onPath !== null);
  }

  async function detectWsl(): Promise<DevDetection> {
    const NOT_INSTALLED = /not installed/i;
    const current = await deps.probe('wsl', ['--version'], { timeoutMs: WSL_TIMEOUT_MS });
    if (current.notFound || current.timedOut) return ABSENT;
    if (NOT_INSTALLED.test(current.output)) return ABSENT;
    if (current.ok && /WSL version/i.test(current.output)) {
      return found(parseVersion(current.output), null, true);
    }
    // The built-in WSL that predates the store build has no --version but does answer --status.
    const status = await deps.probe('wsl', ['--status'], { timeoutMs: WSL_TIMEOUT_MS });
    if (status.ok && !NOT_INSTALLED.test(status.output)) return found(null, null, true);
    return ABSENT;
  }

  async function detectAndroidPiece(piece: AndroidSdkPiece): Promise<DevDetection> {
    const sdk = await deps.androidSdk();
    if (sdk.status === 'override-invalid') {
      return {
        state: 'error',
        message: 'The Android SDK folder set in Settings is not an SDK. Fix or clear it there.',
      };
    }
    if (sdk.status !== 'found' || !sdk.root) return ABSENT;
    const root = sdk.root;

    // The binaries are already located by the shared resolver, so a tool counts as installed when
    // its file is. The package folder beside it carries the revision shown as the version.
    const fromBinary = async (binary: string | null, levelsUp: number): Promise<DevDetection> => {
      if (!binary) return ABSENT;
      let folder = binary;
      for (let level = 0; level < levelsUp; level += 1) folder = path.dirname(folder);
      return found(await revisionBeside(folder), binary, true);
    };

    switch (piece) {
      case 'cmdline-tools':
        // .../cmdline-tools/<version>/bin/sdkmanager: the revision file is two folders up.
        return fromBinary(sdk.paths.sdkmanager, 2);
      case 'platform-tools':
        return fromBinary(sdk.paths.adb, 1);
      case 'emulator':
        return fromBinary(sdk.paths.emulator, 1);
      case 'platform': {
        const folder = path.join(root, 'platforms', platformFolderName());
        if (!(await deps.exists(path.join(folder, 'android.jar')))) return ABSENT;
        return found(await revisionBeside(folder), folder, true);
      }
      case 'system-image': {
        const images = path.join(root, 'system-images');
        for (const api of await deps.listDir(images)) {
          for (const tag of await deps.listDir(path.join(images, api))) {
            for (const abi of await deps.listDir(path.join(images, api, tag))) {
              const folder = path.join(images, api, tag, abi);
              if (await deps.exists(path.join(folder, 'source.properties'))) {
                return found(null, folder, true);
              }
            }
          }
        }
        return ABSENT;
      }
      case 'licenses': {
        const file = path.join(root, 'licenses', 'android-sdk-license');
        return licensesAccepted(await deps.readFile(file)) ? found(null, file, true) : ABSENT;
      }
    }
  }

  async function runDetection(item: DevItem): Promise<DevDetection> {
    const spec = item.detect;
    switch (spec.kind) {
      case 'command':
        return detectCommand(spec);
      case 'paths':
        return detectPaths(spec);
      case 'resolver':
        if (spec.id === 'flutter') return detectFlutter();
        if (spec.id === 'wsl') return detectWsl();
        return detectAndroidPiece(spec.piece ?? 'cmdline-tools');
    }
  }

  async function detect(id: DevItemId, options: { force?: boolean } = {}): Promise<DevDetection> {
    const item = getDevItem(id);
    if (!item) return { state: 'error', message: 'Unknown item.' };
    if (!appliesToOs(item, deps.os)) return ABSENT;

    if (!options.force) {
      const hit = cache.get(id);
      if (hit && deps.now() - hit.at < CACHE_TTL_MS) return hit.result;
    }
    const pending = inFlight.get(id);
    if (pending) return pending;

    const promise = (async (): Promise<DevDetection> => {
      try {
        const spec = item.detect;
        // Resolved before taking a slot: a guarded item holding a slot while it waits for the item
        // it is guarded by would starve that item of the slot it needs.
        if (spec.kind === 'command' && spec.guard && spec.guard.os === deps.os) {
          const guard = await detect(spec.guard.item, options);
          if (guard.state !== 'found') return ABSENT;
        }
        return await limit(() => runDetection(item));
      } catch (error) {
        return { state: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    })()
      .then((result) => {
        cache.set(id, { at: deps.now(), result });
        return result;
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, promise);
    return promise;
  }

  return {
    detect,
    peek(ids) {
      return Object.fromEntries(ids.map((id) => [id, cache.get(id)?.result]));
    },
    invalidate() {
      cache.clear();
    },
  };
}

/** `platforms;android-36` is installed into `platforms/android-36`. */
function platformFolderName(): string {
  return ANDROID_PLATFORM_PACKAGE.split(';')[1] ?? 'android-36';
}
