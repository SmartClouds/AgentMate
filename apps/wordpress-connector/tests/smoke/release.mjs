/**
 * A connector release for the update smoke checks: the files of the plugin zip, read from the
 * source the way the app reads them out of the zip, with the version bumped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from './client.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT = /\.(php|txt|md|css|js|json|xml|html)$/i;
const SHIPPED = [
  'runova-connector.php',
  'uninstall.php',
  'readme.txt',
  'rescue.php',
  'guard',
  'src',
];

/** @returns {Map<string, Buffer>} path inside the plugin folder to bytes */
export function sourceFiles() {
  const files = new Map();
  const walk = (relative) => {
    const absolute = join(source, relative);
    let names = null;
    try {
      names = readdirSync(absolute);
    } catch {
      names = null;
    }
    if (names === null) {
      const bytes = readFileSync(absolute);
      files.set(
        relative.replaceAll('\\', '/'),
        TEXT.test(relative) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes,
      );
      return;
    }
    for (const name of names) walk(join(relative, name));
  };
  for (const name of SHIPPED) walk(name);
  return files;
}

/** The version the source says it is. */
export function sourceVersion() {
  return readFileSync(join(source, 'runova-connector.php'), 'utf8').match(
    /^ \* Version:\s+(\S+)/m,
  )[1];
}

/** The next patch version after `version`. */
export function nextVersion(version) {
  const [major, minor, patch] = version.split('.');
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * The source files as release `version`, plus a marker file; `edit(files)` may change them first.
 * @param {string} current the version the source files say they are
 */
export function connectorRelease(current, version, edit) {
  const files = sourceFiles();
  for (const name of ['runova-connector.php', 'guard/00-runova-connector-guard.php']) {
    files.set(name, Buffer.from(files.get(name).toString('utf8').replaceAll(current, version)));
  }
  files.set('src/SmokeMarker.php', Buffer.from(`<?php // smoke ${version}\n`));
  if (edit) edit(files);
  return files;
}

/** Sends `files` as the update to `version`; `wrongHash` damages the first file's hash. */
export function sendConnectorUpdate(client, files, version, wrongHash = false) {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
  return client.call(
    '/connector/update',
    {
      version,
      files: entries.map(([path, bytes], index) => ({
        path,
        size: bytes.length,
        sha256: wrongHash && index === 0 ? '0'.repeat(64) : sha(bytes),
      })),
    },
    { blobs: entries.map(([, bytes]) => bytes) },
  );
}
