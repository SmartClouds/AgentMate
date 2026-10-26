import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname, join, relative, sep } from 'node:path';
import { app } from 'electron';
import {
  LEGACY_APP_NAME,
  LEGACY_PTY_PIPE_PREFIX,
  LEGACY_PTY_SOCKET_PREFIX,
} from '../../shared/legacyNames';
import { currentDataFolderMove } from '../rebrand/dataFolder';
import { HostClient } from './hostClient';
import {
  type HelloResult,
  PTY_HOST_PROTOCOL_VERSION,
  type PtyEndpointNames,
  type PtyHostPaths,
  ptyHostPaths,
} from './protocol';

const READY_TIMEOUT_MS = 15_000;

/**
 * Identifies the host code a process is running. Packaged builds use the release version;
 * dev builds add the bundle's mtime so a rebuilt host replaces an idle stale one.
 */
function hostIdentity(entry: string): string {
  if (app.isPackaged) return app.getVersion();
  try {
    return `${app.getVersion()}-dev.${Math.round(statSync(entry).mtimeMs)}`;
  } catch {
    return `${app.getVersion()}-dev`;
  }
}

function hostEntryPath(): string {
  // Plain Node mode cannot read inside app.asar, so the entry is shipped unpacked
  // (see electron-builder.yml's asarUnpack).
  return join(__dirname, 'ptyHost.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function endpointFree(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = connect(endpoint);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (!alive) return true;
    await sleep(100);
  }
  return false;
}

interface HostLocation {
  execPath: string;
  entry: string;
  /** Folder holding this copy, for the Windows relocation; null when running in place. */
  relocatedDir: string | null;
}

function relocationRoot(appName = app.getName()): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
  return join(localAppData, appName, 'pty-host');
}

/**
 * On Windows the installer force-kills every process whose image lives under the install
 * folder and then overwrites the files there, so a host started from the install folder
 * would die with every update. Running a copy that lives outside it (the exe, the V8/ICU
 * data it needs to boot, the host bundle, and node-pty) keeps the shells alive while the
 * installer replaces the app around them. One copy per version; old ones are pruned once no
 * running host still uses them.
 */
async function materializeWindowsHost(version: string): Promise<HostLocation | null> {
  const exeDir = dirname(process.execPath);
  const exeName = basename(process.execPath);
  const unpacked = join(process.resourcesPath, 'app.asar.unpacked');
  const target = join(relocationRoot(), version);
  const marker = join(target, '.complete');
  const location = (dir: string): HostLocation => ({
    execPath: join(dir, exeName),
    entry: join(dir, 'resources', 'app.asar.unpacked', 'out', 'main', 'ptyHost.mjs'),
    relocatedDir: dir,
  });
  if (existsSync(marker)) return location(target);

  const staging = `${target}.staging-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(staging, { recursive: true });
    for (const file of [exeName, 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) {
      await cp(join(exeDir, file), join(staging, file));
    }
    const stagedUnpacked = join(staging, 'resources', 'app.asar.unpacked');
    await cp(
      join(unpacked, 'out', 'main', 'ptyHost.mjs'),
      join(stagedUnpacked, 'out', 'main', 'ptyHost.mjs'),
    );
    await cp(
      join(unpacked, 'out', 'main', 'chunks'),
      join(stagedUnpacked, 'out', 'main', 'chunks'),
      {
        recursive: true,
      },
    );
    const ptyRoot = join(unpacked, 'node_modules', 'node-pty');
    const prebuilds = `prebuilds${sep}${process.platform}-${process.arch}`;
    await cp(ptyRoot, join(stagedUnpacked, 'node_modules', 'node-pty'), {
      recursive: true,
      filter: (source) => {
        const rel = relative(ptyRoot, source);
        if (rel === '') return true;
        if (rel.endsWith('.pdb')) return false;
        const top = rel.split(sep)[0];
        if (top === 'package.json' || top === 'lib') return true;
        if (top === 'build') return rel === 'build' || rel.startsWith(`build${sep}Release`);
        if (top === 'prebuilds')
          return rel === 'prebuilds' || prebuilds.startsWith(rel) || rel.startsWith(prebuilds);
        return false;
      },
    });
    await writeFile(join(staging, '.complete'), version);
    try {
      await rename(staging, target);
    } catch {
      // A half-built folder from an interrupted earlier attempt is in the way.
      if (existsSync(marker)) {
        await rm(staging, { recursive: true, force: true });
      } else {
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
      }
    }
    return location(target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // biome-ignore lint/suspicious/noConsole: surfaces why terminals will not survive this update
    console.warn('[pty-host] could not copy the terminal host out of the install folder', error);
    return null;
  }
}

async function pruneRelocatedHosts(keep: Set<string>): Promise<void> {
  const root = relocationRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveHostLocation(identity: string): Promise<HostLocation | null> {
  const entry = hostEntryPath();
  if (!app.isPackaged) return { execPath: process.execPath, entry, relocatedDir: null };
  if (process.platform === 'win32') return materializeWindowsHost(identity);
  // An AppImage runs from a FUSE mount that is torn down when the app exits, taking the
  // host's own files with it. Keep terminals in-process there.
  if (process.env.APPIMAGE) return null;
  return { execPath: process.execPath, entry, relocatedDir: null };
}

type LaunchOutcome = 'ready' | 'endpoint-taken' | 'failed';

function launch(
  location: HostLocation,
  identity: string,
  runtimeDir: string,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const child = fork(
      location.entry,
      ['--user-data', app.getPath('userData'), '--app-version', identity],
      {
        execPath: location.execPath,
        execArgv: [],
        // Anywhere but the install folder: a process's working directory keeps that folder
        // locked, which would get in the installer's way.
        cwd: runtimeDir,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const finish = (outcome: LaunchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome === 'ready') {
        // Cut every tie that would keep this process waiting on the host or take the host
        // down with it.
        child.disconnect();
        child.unref();
      } else if (child.exitCode === null) {
        child.kill();
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('failed'), READY_TIMEOUT_MS);
    child.on('message', (message: { type?: string }) => {
      if (message?.type === 'ready') finish('ready');
    });
    child.once('exit', (code) => finish(code === 3 ? 'endpoint-taken' : 'failed'));
    child.once('error', () => finish('failed'));
  });
}

export interface ConnectedHost {
  client: HostClient;
  hello: HelloResult;
}

const LEGACY_ENDPOINT_NAMES: PtyEndpointNames = {
  pipePrefix: LEGACY_PTY_PIPE_PREFIX,
  socketPrefix: LEGACY_PTY_SOCKET_PREFIX,
};

/**
 * A host started before the rename listens under the old name, or under a path hashed from the
 * old profile folder. Its token file moved with the profile, so the current one opens it. Its
 * shells keep running and the app uses it until it exits; the next host starts under the new name.
 */
async function adoptLegacyHost(paths: PtyHostPaths): Promise<ConnectedHost | null> {
  const folders = [app.getPath('userData'), currentDataFolderMove()?.legacyFolder].filter(
    (folder): folder is string => Boolean(folder),
  );
  const endpoints = new Set<string>();
  for (const folder of folders) {
    endpoints.add(ptyHostPaths(folder, LEGACY_ENDPOINT_NAMES).endpoint);
    endpoints.add(ptyHostPaths(folder).endpoint);
  }
  endpoints.delete(paths.endpoint);
  for (const endpoint of endpoints) {
    try {
      return await HostClient.connect(endpoint, paths.tokenFile);
    } catch {
      // nothing there
    }
  }
  return null;
}

/**
 * Connects to the terminal host, starting one if none is running. Resolves null when the
 * host cannot be used at all, in which case the caller runs terminals in-process.
 */
export async function connectToHost(): Promise<ConnectedHost | null> {
  const paths = ptyHostPaths(app.getPath('userData'));
  await mkdir(paths.runtimeDir, { recursive: true });
  const identity = hostIdentity(hostEntryPath());

  const tryConnect = async (): Promise<ConnectedHost | null> => {
    try {
      return await HostClient.connect(paths.endpoint, paths.tokenFile);
    } catch {
      return null;
    }
  };

  let existing = (await tryConnect()) ?? (await adoptLegacyHost(paths));
  if (existing) {
    const { client, hello } = existing;
    const incompatible = hello.protocolVersion !== PTY_HOST_PROTOCOL_VERSION;
    const stale = hello.appVersion !== identity && hello.sessionCount === 0;
    if (!incompatible && !stale) {
      // A host from an older release that still has shells running is kept as it is:
      // replacing it just to run newer code would kill them.
      void keepHostFiles(identity, hello.appVersion);
      return existing;
    }
    // A host this app cannot drive (or an idle one running old code) is retired first.
    // Its shells are lost, which only happens when the protocol itself changes.
    await client
      .request({ type: 'shutdown', payload: { killSessions: true } }, 2000)
      .catch(() => undefined);
    client.close();
    existing = null;
    await endpointFree(paths.endpoint, 3000);
  }

  const location = await resolveHostLocation(identity);
  if (!location) return null;

  let outcome = await launch(location, identity, paths.runtimeDir);
  if (outcome === 'endpoint-taken') {
    const raced = await tryConnect();
    if (raced) return raced;
    await sleep(300);
    outcome = await launch(location, identity, paths.runtimeDir);
  }
  if (outcome !== 'ready') return null;

  const connected = await tryConnect();
  if (connected) {
    void keepHostFiles(identity, connected.hello.appVersion);
    void removeLegacyHostCopies();
  }
  return connected;
}

/**
 * Hosts from before the rename ran from copies under the old name. A fresh host just started, so
 * none of those is in use any more (one that still were would have been adopted above).
 */
async function removeLegacyHostCopies(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const root = relocationRoot(LEGACY_APP_NAME);
  if (!existsSync(root)) return;
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  // The old app's folder goes too once nothing else is left in it.
  await rmdir(dirname(root)).catch(() => undefined);
}

async function keepHostFiles(current: string, running: string): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return;
  await pruneRelocatedHosts(new Set([current, running]));
}
