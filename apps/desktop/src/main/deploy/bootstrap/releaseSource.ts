import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { LEGACY_CORE } from '../coreLayout';
import type { ReleaseRid } from './osSupport';

/**
 * Where the server core the app installs comes from. Packaged builds download the GitHub
 * release asset for their own version; development builds use `pnpm server-core:publish`
 * output. Either way the file must match the SHA-256 in the release manifest, and the installer
 * checks it again on the server before unpacking it.
 *
 * A packaged build can also name the release's public address (`remote`), so a server that can
 * reach GitHub downloads the core itself and this app downloads and uploads nothing.
 *
 * Each release is also published under the tarball name from before the rename (same bytes, same
 * checksum), the only one a core from 1.63 or older takes when it updates itself.
 */

export interface ReleaseAsset {
  rid: ReleaseRid;
  file: string;
  /** The same tarball under its old name, for cores from before the rename. */
  legacyFile?: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  version: string;
  assets: ReleaseAsset[];
}

export interface CoreRelease {
  version: string;
  rid: ReleaseRid;
  file: string;
  legacyFile?: string;
  sha256: string;
  /** A local copy that was just checked against `sha256`. */
  localPath: string;
}

/** A release the server could download itself, with the checksum the app already holds for it. */
export interface RemoteRelease {
  version: string;
  rid: ReleaseRid;
  file: string;
  sha256: string;
  /** In bytes, from the manifest: a core that downloads it stops at the first byte past this. */
  size: number;
  url: string;
  /** The same tarball under its old name and address, for a core from before the rename. */
  legacy?: { file: string; url: string };
}

export interface ReleaseSource {
  release: (rid: ReleaseRid) => Promise<CoreRelease>;
  /**
   * Where a server could fetch this release itself, without this app downloading it first. Left
   * out by sources with no public address (development builds), which always upload.
   */
  remote?: (rid: ReleaseRid) => RemoteRelease | null;
}

export type Downloader = (url: string, destination: string) => Promise<void>;

const REPOSITORY = 'SmartClouds/Runova';
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RIDS: ReadonlySet<string> = new Set<ReleaseRid>(['linux-x64', 'linux-arm64']);

function invalid(reason: string): Error {
  return new Error(`The server core release manifest is not valid: ${reason}.`);
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (typeof value !== 'object' || value === null) throw invalid('it is not an object');
  const { version, assets } = value as { version?: unknown; assets?: unknown };
  if (typeof version !== 'string' || !VERSION.test(version))
    throw invalid('the version is missing or odd');
  if (!Array.isArray(assets)) throw invalid('it lists no assets');
  return {
    version,
    assets: assets.map((asset: unknown): ReleaseAsset => {
      const { rid, file, legacyFile, sha256, size } = (asset ?? {}) as Record<string, unknown>;
      if (typeof rid !== 'string' || !RIDS.has(rid))
        throw invalid(`"${String(rid)}" is not a Linux build`);
      if (typeof file !== 'string' || file !== `runova-core-${version}-${rid}.tar.gz`) {
        throw invalid(`"${String(file)}" is not the ${rid} release file`);
      }
      if (
        legacyFile !== undefined &&
        legacyFile !== `${LEGACY_CORE.tarballPrefix}${version}-${rid}.tar.gz`
      ) {
        throw invalid(`"${String(legacyFile)}" is not the ${rid} release file under its old name`);
      }
      if (typeof sha256 !== 'string' || !SHA256.test(sha256))
        throw invalid(`${file} has no SHA-256`);
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0)
        throw invalid(`${file} has no size`);
      return {
        rid: rid as ReleaseRid,
        file,
        ...(typeof legacyFile === 'string' ? { legacyFile } : {}),
        sha256,
        size,
      };
    }),
  };
}

export function releaseDownloadUrl(version: string, file: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function assertChecksum(path: string, asset: ReleaseAsset): Promise<void> {
  if ((await sha256Of(path)) !== asset.sha256) {
    throw new Error(`${asset.file} does not match its published checksum, so it was not used.`);
  }
}

function assetFor(manifest: ReleaseManifest, rid: ReleaseRid, where: string): ReleaseAsset {
  const asset = manifest.assets.find((candidate) => candidate.rid === rid);
  if (!asset)
    throw new Error(`There is no ${rid} build of server core ${manifest.version} ${where}.`);
  return asset;
}

/**
 * Where `pnpm server-core:publish` writes in this checkout, found by walking up from `start`, so
 * it works from `electron-vite dev` and from a build folder under the desktop app alike.
 */
export function repoReleaseDirectory(start: string): string | null {
  let directory = resolve(start);
  for (;;) {
    const serverCore = join(directory, 'apps', 'server-core');
    if (existsSync(serverCore)) return join(serverCore, 'artifacts', 'release');
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** `pnpm server-core:publish <rid>` output, for development builds. */
export function localArtifactSource(directory: string): ReleaseSource {
  return {
    release: async (rid) => {
      const manifestPath = join(directory, 'server-core-manifest.json');
      if (!existsSync(manifestPath)) {
        throw new Error(`No server core build found. Run "pnpm server-core:publish ${rid}" first.`);
      }
      const manifest = parseReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf-8')));
      const asset = assetFor(
        manifest,
        rid,
        `in ${directory}; run "pnpm server-core:publish ${rid}"`,
      );
      const localPath = join(directory, asset.file);
      await assertChecksum(localPath, asset);
      return {
        version: manifest.version,
        rid,
        file: asset.file,
        ...(asset.legacyFile ? { legacyFile: asset.legacyFile } : {}),
        sha256: asset.sha256,
        localPath,
      };
    },
  };
}

/** The GitHub release for the app's own version, cached locally after the first download. */
export function githubReleaseSource(
  manifestValue: unknown,
  cacheDirectory: string,
  download: Downloader,
): ReleaseSource {
  const manifest = parseReleaseManifest(manifestValue);
  return {
    remote: (rid) => {
      const asset = manifest.assets.find((candidate) => candidate.rid === rid);
      if (!asset) return null;
      return {
        version: manifest.version,
        rid,
        file: asset.file,
        sha256: asset.sha256,
        size: asset.size,
        url: releaseDownloadUrl(manifest.version, asset.file),
        ...(asset.legacyFile
          ? {
              legacy: {
                file: asset.legacyFile,
                url: releaseDownloadUrl(manifest.version, asset.legacyFile),
              },
            }
          : {}),
      };
    },
    release: async (rid) => {
      const asset = assetFor(manifest, rid, 'in this app build');
      await mkdir(cacheDirectory, { recursive: true });
      const localPath = join(cacheDirectory, asset.file);
      if (existsSync(localPath)) {
        try {
          await assertChecksum(localPath, asset);
          return {
            version: manifest.version,
            rid,
            file: asset.file,
            ...(asset.legacyFile ? { legacyFile: asset.legacyFile } : {}),
            sha256: asset.sha256,
            localPath,
          };
        } catch {
          await rm(localPath, { force: true });
        }
      }
      await download(releaseDownloadUrl(manifest.version, asset.file), localPath);
      try {
        await assertChecksum(localPath, asset);
      } catch (error) {
        await rm(localPath, { force: true });
        throw error;
      }
      return {
        version: manifest.version,
        rid,
        file: asset.file,
        ...(asset.legacyFile ? { legacyFile: asset.legacyFile } : {}),
        sha256: asset.sha256,
        localPath,
      };
    },
  };
}
