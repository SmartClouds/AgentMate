import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WP_CONNECTOR_VERSION,
  WP_LEGACY_CONNECTOR_MAIN,
  WP_LEGACY_CONNECTOR_NAME,
  WP_LEGACY_CONNECTOR_SLUG,
  WP_LEGACY_CONNECTOR_ZIP,
  WP_LEGACY_VERSION_CONSTANT,
  WP_UPDATE_MAX_FILE_BYTES,
  WP_UPDATE_MAX_FILES,
  WP_UPDATE_MAX_TOTAL_BYTES,
  wpLegacyConnectorReleaseUrl,
} from '@runova/core';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import {
  compareConnectorVersions,
  readConnectorBundle,
  readShippedConnector,
} from './connectorBundle';
import { BRIDGE_ZIP_NAME, connectorZipPath } from './connectorZip';

/**
 * The shipped plugin zip, unpacked into what `/connector/update` sends: the files under the
 * plugin folder, sorted, hashed, and only when the zip is a connector this app can vouch for.
 */

const ROOT = 'runova-connector/';

function mainFile(header: string, constant: string = header): string {
  return `<?php
/**
 * Plugin Name:       Runova Connector
 * Version:           ${header}
 */
define('RUNOVA_CONNECTOR_VERSION', '${constant}');
`;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runova-wp-bundle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function zipOf(entries: Record<string, string | Buffer>, name = 'connector.zip'): string {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.addFile(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
  }
  const file = join(dir, name);
  writeFileSync(file, zip.toBuffer());
  return file;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the read to fail.');
}

describe('readConnectorBundle', () => {
  it('lists the files under the plugin folder, sorted, with their hashes', async () => {
    const source = '<?php\nnamespace Runova\\Connector;\n';
    const file = zipOf({
      [`${ROOT}src/Plugin.php`]: source,
      [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
      [`${ROOT}readme.txt`]: '=== Runova Connector ===',
      [`${ROOT}src/`]: '',
    });

    const bundle = await readConnectorBundle(file);

    expect(bundle.version).toBe(WP_CONNECTOR_VERSION);
    expect(bundle.files.map((entry) => entry.path)).toEqual([
      'readme.txt',
      'runova-connector.php',
      'src/Plugin.php',
    ]);
    const plugin = bundle.files.find((entry) => entry.path === 'src/Plugin.php');
    expect(plugin).toMatchObject({
      size: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    expect(plugin?.bytes.toString('utf-8')).toBe(source);
    expect(bundle.totalBytes).toBe(bundle.files.reduce((sum, entry) => sum + entry.size, 0));
  });

  it('refuses a zip that is not there, with a way forward', async () => {
    const error = await failure(readConnectorBundle(join(dir, 'missing.zip')));

    expect(wordPressErrorCode(error)).toBe('internal');
    expect(error.message).toContain('does not include the Runova Connector plugin');
  });

  it('refuses a damaged zip', async () => {
    const file = join(dir, 'damaged.zip');
    writeFileSync(file, Buffer.from('this is not a zip file at all'));

    expect(await failure(readConnectorBundle(file))).toHaveProperty(
      'message',
      expect.stringContaining('the zip is damaged'),
    );
  });

  it.each([
    ['no main file', { [`${ROOT}readme.txt`]: 'x' }, 'runova-connector.php is missing'],
    [
      'a file outside the plugin folder',
      {
        [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
        'other/evil.php': '<?php',
      },
      'other/evil.php is outside the plugin folder',
    ],
    [
      'a type the update does not carry',
      {
        [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
        [`${ROOT}src/run.exe`]: 'MZ',
      },
      'src/run.exe is not a file type the update carries',
    ],
    [
      'a name the path policy refuses',
      {
        [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
        [`${ROOT}src/CLAUDE.md`]: 'notes',
      },
      'src/CLAUDE.md is not a path a site accepts',
    ],
    [
      'a version header that disagrees with the constant',
      { [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION, '0.0.1') },
      'its version header and constant disagree',
    ],
    [
      'a version this app does not expect',
      { [`${ROOT}runova-connector.php`]: mainFile('0.0.1') },
      `it is version 0.0.1 but this app expects ${WP_CONNECTOR_VERSION}`,
    ],
    [
      'a main file without a version',
      { [`${ROOT}runova-connector.php`]: '<?php\n// nothing here' },
      'its version is not readable',
    ],
  ])('refuses %s', async (_name, entries, reason) => {
    const error = await failure(readConnectorBundle(zipOf(entries)));

    expect(wordPressErrorCode(error)).toBe('internal');
    expect(error.message).toContain(reason);
  });

  it('refuses the same path twice in different letter case', async () => {
    const error = await failure(
      readConnectorBundle(
        zipOf({
          [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
          [`${ROOT}src/Plugin.php`]: '<?php',
          [`${ROOT}src/plugin.php`]: '<?php',
        }),
      ),
    );

    expect(error.message).toContain('appears twice');
  });

  it('holds the same limits the site holds', async () => {
    const many: Record<string, string> = {
      [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
    };
    for (let index = 0; index < WP_UPDATE_MAX_FILES; index += 1) {
      many[`${ROOT}src/F${index}.php`] = '<?php';
    }
    expect((await failure(readConnectorBundle(zipOf(many, 'many.zip')))).message).toContain(
      'too many files',
    );

    const big = zipOf(
      {
        [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
        [`${ROOT}src/Big.php`]: Buffer.alloc(WP_UPDATE_MAX_FILE_BYTES + 1, 97),
      },
      'big.zip',
    );
    expect((await failure(readConnectorBundle(big))).message).toContain('src/Big.php is too large');

    const parts = Math.ceil(WP_UPDATE_MAX_TOTAL_BYTES / WP_UPDATE_MAX_FILE_BYTES) + 1;
    const heavy: Record<string, string | Buffer> = {
      [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
    };
    for (let index = 0; index < parts; index += 1) {
      heavy[`${ROOT}src/P${index}.php`] = Buffer.alloc(WP_UPDATE_MAX_FILE_BYTES, 98);
    }
    expect((await failure(readConnectorBundle(zipOf(heavy, 'heavy.zip')))).message).toContain(
      'it is too large',
    );
  });

  const built = connectorZipPath({
    isPackaged: false,
    resourcesPath: '',
    appPath: fileURLToPath(new URL('../../../../', import.meta.url)),
  });
  it.skipIf(!existsSync(built))(
    'reads the plugin zip that scripts/wordpress-connector builds',
    async () => {
      const bundle = await readConnectorBundle(built);

      expect(bundle.version).toBe(WP_CONNECTOR_VERSION);
      const paths = bundle.files.map((entry) => entry.path);
      expect(paths).toContain('runova-connector.php');
      expect(paths).toContain('src/Plugin.php');
      expect(paths.every((path) => !path.startsWith(ROOT))).toBe(true);
    },
  );
});

describe('readShippedConnector', () => {
  const shipped = (isPackaged: boolean) => {
    zipOf(
      {
        [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
        [`${ROOT}src/Plugin.php`]: '<?php',
      },
      'runova-connector.zip',
    );
    // The development path is <appPath>/../wordpress-connector/dist; the packaged one is
    // <resources>/wordpress-connector.
    const folder = isPackaged
      ? join(dir, 'wordpress-connector')
      : join(dir, 'wordpress-connector', 'dist');
    mkdirSync(folder, { recursive: true });
    renameSync(join(dir, 'runova-connector.zip'), join(folder, 'runova-connector.zip'));
    return readShippedConnector({ isPackaged, resourcesPath: dir, appPath: join(dir, 'app') });
  };

  it('names the GitHub release a site can download it from in a packaged app', async () => {
    const bundle = await shipped(true);
    expect(bundle.downloadUrl).toBe(
      `https://github.com/SmartClouds/Runova/releases/download/v${WP_CONNECTOR_VERSION}/runova-connector.zip`,
    );
  });

  it('names none in a development build, whose zip may match no release', async () => {
    expect((await shipped(false)).downloadUrl).toBeUndefined();
  });
});

describe('compareConnectorVersions', () => {
  it.each([
    ['1.57.1', '1.57.1', 0],
    ['1.57.1', '1.57.10', -1],
    ['1.58.0', '1.57.9', 1],
    ['2.0', '2.0.0', 0],
    ['1.0.0-beta', '1.0.0', 0],
    ['', '1.0.0', -1],
  ])('%s against %s is %i', (a, b, expected) => {
    expect(compareConnectorVersions(a, b)).toBe(expected);
  });
});

describe('the bridge package', () => {
  const BRIDGE = `${WP_LEGACY_CONNECTOR_SLUG}/`;
  const legacyMain = (version: string) => `<?php
/**
 * Plugin Name:       ${WP_LEGACY_CONNECTOR_NAME}
 * Version:           ${version}
 */
define('${WP_LEGACY_VERSION_CONSTANT}', '${version}');
`;

  it('reads the old folder, with the 1.63 main file and the Runova one in layout/', async () => {
    const file = zipOf({
      [`${BRIDGE}${WP_LEGACY_CONNECTOR_MAIN}`]: legacyMain(WP_CONNECTOR_VERSION),
      [`${BRIDGE}layout/runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION),
      [`${BRIDGE}src/Plugin.php`]: '<?php',
    });
    const bundle = await readConnectorBundle(file, 'bridge');
    expect(bundle.package).toBe('bridge');
    expect(bundle.files.map((entry) => entry.path)).toEqual([
      WP_LEGACY_CONNECTOR_MAIN,
      'layout/runova-connector.php',
      'src/Plugin.php',
    ]);
  });

  it('refuses the Runova zip as the bridge, and the bridge as the Runova zip', async () => {
    const runova = zipOf({ [`${ROOT}runova-connector.php`]: mainFile(WP_CONNECTOR_VERSION) });
    expect(wordPressErrorCode(await failure(readConnectorBundle(runova, 'bridge')))).toBe(
      'internal',
    );
    const bridge = zipOf(
      { [`${BRIDGE}${WP_LEGACY_CONNECTOR_MAIN}`]: legacyMain(WP_CONNECTOR_VERSION) },
      'bridge.zip',
    );
    expect(wordPressErrorCode(await failure(readConnectorBundle(bridge)))).toBe('internal');
  });

  it('names the release under the repository address a 1.63 site downloads from', async () => {
    const folder = join(dir, 'wordpress-connector');
    mkdirSync(folder, { recursive: true });
    zipOf(
      { [`${BRIDGE}${WP_LEGACY_CONNECTOR_MAIN}`]: legacyMain(WP_CONNECTOR_VERSION) },
      `wordpress-connector/${BRIDGE_ZIP_NAME}`,
    );
    const bundle = await readShippedConnector(
      { isPackaged: true, resourcesPath: dir, appPath: join(dir, 'app') },
      'bridge',
    );
    expect(bundle.downloadUrl).toBe(wpLegacyConnectorReleaseUrl(WP_CONNECTOR_VERSION));
    expect(bundle.downloadUrl).toContain(`/${WP_LEGACY_CONNECTOR_ZIP}`);
  });

  it('is built beside the Runova zip, from the same source', async () => {
    const appPath = fileURLToPath(new URL('../../../../', import.meta.url));
    const bridgeZip = connectorZipPath(
      { isPackaged: false, resourcesPath: '', appPath },
      BRIDGE_ZIP_NAME,
    );
    if (!existsSync(bridgeZip)) return;
    const bridge = await readConnectorBundle(bridgeZip, 'bridge');
    const runova = await readConnectorBundle(
      connectorZipPath({ isPackaged: false, resourcesPath: '', appPath }),
    );
    const byPath = new Map(runova.files.map((entry) => [entry.path, entry.sha256]));
    expect(bridge.files.find((entry) => entry.path === 'layout/runova-connector.php')?.sha256).toBe(
      byPath.get('runova-connector.php'),
    );
    for (const entry of bridge.files) {
      if (entry.path.startsWith('src/'))
        expect(byPath.get(entry.path), entry.path).toBe(entry.sha256);
    }
  });
});
