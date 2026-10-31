import type { DevArch, DevOs } from './types.js';

/**
 * Choosing which Flutter archive to download. Flutter has no package on winget, so the app fetches
 * the official archive itself. Google publishes a release list per OS, and the current stable
 * build is named in it by hash.
 *
 * The result is a file that gets downloaded and unpacked on the person's machine, so everything
 * read from the list is checked: it has to be https on Google's release bucket, the path has to
 * stay inside it, and the checksum has to look like one. Anything else is "no release".
 */

const RELEASE_HOST = 'storage.googleapis.com';
const RELEASE_PATH = '/flutter_infra_release/';

export interface FlutterRelease {
  version: string;
  url: string;
  /** Lowercase hex. */
  sha256: string;
  format: 'zip' | 'tar.xz';
  /** The Dart SDK this build ships, e.g. `3.13.5`, or null when the list does not say. */
  dartVersion: string | null;
}

const OS_FILE: Record<DevOs, string> = { win32: 'windows', darwin: 'macos', linux: 'linux' };

export function flutterManifestUrl(os: DevOs): string {
  return `https://${RELEASE_HOST}${RELEASE_PATH}releases/releases_${OS_FILE[os]}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256 = /^[0-9a-f]{64}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A relative path inside the releases folder: no leading slash, no `..`, no scheme. */
function safeArchivePath(archive: string): boolean {
  const segments = archive.split('/');
  return segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

function baseUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== RELEASE_HOST) return null;
    if (!url.pathname.startsWith(RELEASE_PATH)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The current stable build of Flutter for this OS and CPU, or null if there is none to trust. */
export function pickFlutterRelease(
  manifest: unknown,
  os: DevOs,
  arch: DevArch,
): FlutterRelease | null {
  if (!isRecord(manifest) || arch === 'other') return null;
  const base = baseUrlOf(manifest.base_url);
  const current = isRecord(manifest.current_release) ? manifest.current_release.stable : null;
  if (!base || typeof current !== 'string' || !Array.isArray(manifest.releases)) return null;

  for (const release of manifest.releases) {
    if (!isRecord(release)) continue;
    if (release.hash !== current || release.channel !== 'stable') continue;
    // The older entries do not name an architecture, and those are the x64 ones.
    const built = release.dart_sdk_arch ?? 'x64';
    if (built !== arch) continue;

    const { version, archive, sha256 } = release;
    if (typeof version !== 'string' || !VERSION.test(version)) continue;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) continue;
    if (typeof archive !== 'string' || !safeArchivePath(archive)) continue;
    // Each OS has its own list, and its archives sit in a folder named for it. A list for another
    // OS would otherwise hand over an archive that cannot run here.
    if (!archive.startsWith(`stable/${OS_FILE[os]}/`)) continue;
    const format = archive.endsWith('.tar.xz') ? 'tar.xz' : archive.endsWith('.zip') ? 'zip' : null;
    if (!format) continue;

    // Betas print `3.14.0 (build 3.14.0-315.1.beta)`; the leading version is the one that counts.
    const dart =
      typeof release.dart_sdk_version === 'string'
        ? (/^\d+\.\d+\.\d+/.exec(release.dart_sdk_version.trim())?.[0] ?? null)
        : null;
    return {
      version,
      url: `${base}/${archive}`,
      sha256: sha256.toLowerCase(),
      format,
      dartVersion: dart,
    };
  }
  return null;
}

/**
 * Where Runova puts Flutter: a `develop` folder in the home folder. Flutter's own guide says to
 * avoid a path with spaces or one that needs administrator rights, and this is neither.
 */
export function flutterInstallRoot(os: DevOs, home: string): string {
  return os === 'win32' ? `${home}\\develop\\flutter` : `${home}/develop/flutter`;
}

/** The folder with the `flutter` and `dart` commands, which is what goes on PATH. */
export function flutterBinDir(os: DevOs, home: string): string {
  return os === 'win32'
    ? `${flutterInstallRoot(os, home)}\\bin`
    : `${flutterInstallRoot(os, home)}/bin`;
}
