import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  validateWpItemPath,
  WP_CONNECTOR_VERSION,
  WP_LEGACY_CONNECTOR_MAIN,
  WP_LEGACY_CONNECTOR_SLUG,
  WP_LEGACY_VERSION_CONSTANT,
  WP_UPDATE_FILE_PATTERN,
  WP_UPDATE_MAX_FILE_BYTES,
  WP_UPDATE_MAX_FILES,
  WP_UPDATE_MAX_TOTAL_BYTES,
  wpConnectorReleaseUrl,
  wpLegacyConnectorReleaseUrl,
} from '@runova/core';
import AdmZip from 'adm-zip';
import { wordPressError } from '../../../shared/wordpressErrors';
import { BRIDGE_ZIP_NAME, type ConnectorZipDeps, connectorZipPath } from './connectorZip';

/**
 * The Runova Connector that ships with the app, unpacked from its plugin zip into the file
 * list `/connector/update` sends (E19). Reading the zip, not the plugin's source folder, keeps the
 * update byte for byte what "Download the plugin" hands out, in development and in a packaged app.
 */

/** The zip's top folder, which is the plugin folder on the site. */
export const CONNECTOR_ZIP_ROOT = 'runova-connector/';
const HEADER_VERSION = /^ \* Version:\s+(\S+)\s*$/m;

/**
 * Which package: the plugin in its own folder, or the bridge (the same plugin in the folder 1.63
 * used, under the main file and version constant 1.63 checks), with the Runova main file waiting
 * in layout/ for the move.
 */
export type ConnectorPackage = 'runova' | 'bridge';

const PACKAGES: Record<ConnectorPackage, { root: string; main: string; constant: RegExp }> = {
  runova: {
    root: CONNECTOR_ZIP_ROOT,
    main: 'runova-connector.php',
    constant: /define\(\s*'RUNOVA_CONNECTOR_VERSION'\s*,\s*'([^']+)'\s*\)/,
  },
  bridge: {
    root: `${WP_LEGACY_CONNECTOR_SLUG}/`,
    main: WP_LEGACY_CONNECTOR_MAIN,
    constant: new RegExp(`define\\(\\s*'${WP_LEGACY_VERSION_CONSTANT}'\\s*,\\s*'([^']+)'\\s*\\)`),
  },
};

export interface ConnectorBundleFile {
  /** Relative to the plugin folder, `/`-separated. */
  path: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
  bytes: Buffer;
}

export interface ConnectorBundle {
  version: string;
  package?: ConnectorPackage;
  /** Sorted by path. */
  files: ConnectorBundleFile[];
  totalBytes: number;
  /**
   * The GitHub release that holds this same zip, which a site can download itself. Only packaged
   * builds name one: a development build's zip may not match any release.
   */
  downloadUrl?: string;
}

function broken(why: string): Error {
  return wordPressError(
    'internal',
    `The Runova Connector that comes with this app can't be sent to a site (${why}). Reinstall Runova, or download the plugin and upload it in wp-admin.`,
  );
}

/**
 * Compares dotted version numbers ("1.57.10" is newer than "1.57.9"). Anything after a `-` or `+`
 * is ignored, and a part that is not a number counts as 0.
 */
export function compareConnectorVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Reads and checks the plugin zip. Throws `[wp:internal]` with a plain reason when it is unfit. */
export async function readConnectorBundle(
  zipFile: string,
  kind: ConnectorPackage = 'runova',
): Promise<ConnectorBundle> {
  const { root, main: mainFile, constant: constantVersion } = PACKAGES[kind];
  let archive: Buffer;
  try {
    archive = await readFile(zipFile);
  } catch {
    throw wordPressError(
      'internal',
      'This build of Runova does not include the Runova Connector plugin, or it has not been built yet (run "node scripts/wordpress-connector.mjs build"). Download it from the Runova release page instead.',
    );
  }
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(archive).getEntries();
  } catch {
    throw broken('the zip is damaged');
  }

  const files: ConnectorBundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (!name.startsWith(root)) throw broken(`${name} is outside the plugin folder`);
    const path = name.slice(root.length);
    if (!validateWpItemPath(path).ok) throw broken(`${path} is not a path a site accepts`);
    if (!WP_UPDATE_FILE_PATTERN.test(path))
      throw broken(`${path} is not a file type the update carries`);
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw broken(`${path} appears twice`);
    seen.add(folded);
    if (files.length >= WP_UPDATE_MAX_FILES) throw broken('it holds too many files');
    // The declared size is checked before anything is inflated, and the real one after.
    if (entry.header.size > WP_UPDATE_MAX_FILE_BYTES) throw broken(`${path} is too large`);
    const bytes = entry.getData();
    if (bytes.length > WP_UPDATE_MAX_FILE_BYTES) throw broken(`${path} is too large`);
    totalBytes += bytes.length;
    if (totalBytes > WP_UPDATE_MAX_TOTAL_BYTES) throw broken('it is too large');
    files.push({
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const main = files.find((file) => file.path === mainFile);
  if (!main) throw broken(`${mainFile} is missing`);
  const text = main.bytes.toString('utf-8');
  const header = HEADER_VERSION.exec(text)?.[1];
  const constant = constantVersion.exec(text)?.[1];
  if (!header || !constant) throw broken('its version is not readable');
  if (header !== constant) throw broken('its version header and constant disagree');
  if (header !== WP_CONNECTOR_VERSION) {
    throw broken(
      `it is version ${header} but this app expects ${WP_CONNECTOR_VERSION}; the plugin zip is out of date`,
    );
  }
  return { version: header, files, totalBytes, ...(kind === 'bridge' ? { package: kind } : {}) };
}

/** The shipped zip for this run (packaged resources, or the development build). */
export async function readShippedConnector(
  deps: Pick<ConnectorZipDeps, 'isPackaged' | 'resourcesPath' | 'appPath'>,
  kind: ConnectorPackage = 'runova',
): Promise<ConnectorBundle> {
  const bridge = kind === 'bridge';
  const bundle = await readConnectorBundle(
    connectorZipPath(deps, bridge ? BRIDGE_ZIP_NAME : undefined),
    kind,
  );
  if (!deps.isPackaged) return bundle;
  // A 1.63 site only downloads from the repository's old address, which GitHub redirects.
  const downloadUrl = bridge
    ? wpLegacyConnectorReleaseUrl(bundle.version)
    : wpConnectorReleaseUrl(bundle.version);
  return { ...bundle, downloadUrl };
}
