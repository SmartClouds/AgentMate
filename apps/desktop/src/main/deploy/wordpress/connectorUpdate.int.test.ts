import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WP_CONNECTOR_VERSION } from '@runova/core';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { systemTestsEnabled } from '../testing/testServerMachines';
import { readShippedConnector } from './connectorBundle';
import { CONNECTOR_ZIP_NAME, connectorZipPath } from './connectorZip';
import { WordPressProjectService } from './projectService';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { createFetchTransport } from './transport';

/**
 * Updating the connector from the app (E19 T13), against the real plugin on WordPress in Docker:
 * the site runs the current plugin code under an older version number, the app reads the zip that
 * ships with it, sends the files over the signed channel, and the plugin swaps its own folder.
 *
 * Opt in with RUNOVA_SYSTEM_TESTS=1 (Linux containers), like wordpress.int.test.ts.
 */

const enabled = systemTestsEnabled();
const PORT = 18_996;
const OLD_VERSION = '1.0.0';
const PLUGIN_DIR = '/var/www/html/wp-content/plugins/runova-connector';
const APP_PATH = fileURLToPath(new URL('../../../../', import.meta.url));

interface Fixture {
  url: string;
  exec: (command: string, options?: { allowFail?: boolean }) => string;
  wp: (args: string[]) => string;
  keyFor: (scope: 'read' | 'write') => string;
  stop: () => void;
}

/** The shipped zip with its version rewritten to an older one. */
function olderZip(folder: string): string {
  const shipped = connectorZipPath({ isPackaged: false, resourcesPath: '', appPath: APP_PATH });
  const zip = new AdmZip(shipped);
  for (const name of ['runova-connector/runova-connector.php']) {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`${name} is not in the shipped zip.`);
    zip.updateFile(
      entry,
      Buffer.from(entry.getData().toString('utf-8').replaceAll(WP_CONNECTOR_VERSION, OLD_VERSION)),
    );
  }
  const target = join(folder, CONNECTOR_ZIP_NAME);
  writeFileSync(target, zip.toBuffer());
  return target;
}

describe.skipIf(!enabled)('Connector update against the real plugin', () => {
  let site: Fixture;
  let dir: string;
  let service: WordPressProjectService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'runova-wp-update-'));
    const fixture = new URL(
      '../../../../../wordpress-connector/tests/smoke/fixture.mjs',
      import.meta.url,
    );
    const { startWordPressFixture } = (await import(fixture.href)) as {
      startWordPressFixture: (options: { port: number; zip: string }) => Promise<Fixture>;
    };
    site = await startWordPressFixture({ port: PORT, zip: olderZip(dir) });
    service = new WordPressProjectService({
      state: new WordPressState(wordPressStateFilePort(join(dir, 'deploy-wordpress.json'))),
      bases: new WordPressBases(join(dir, 'bases')),
      transport: createFetchTransport(globalThis.fetch as never),
      seal: async (plain) => ({
        mode: 'safeStorage',
        ciphertext: Buffer.from(plain).toString('base64'),
      }),
      unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString('utf-8'),
      isLocked: () => false,
      progress: () => undefined,
      hostname: () => 'int-test',
      saveConnectorZip: async () => ({ saved: false }),
      readConnectorBundle: () =>
        readShippedConnector({ isPackaged: false, resourcesPath: '', appPath: APP_PATH }),
      projects: {
        get: async () => null,
        create: async () => {
          throw new Error('No projects in this test.');
        },
        setLink: async () => {
          throw new Error('No projects in this test.');
        },
      },
    });
  }, 900_000);

  afterAll(() => {
    site?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a read-only key and leaves the plugin as it was', async () => {
    const reader = await service.connect({ connectionKey: site.keyFor('read') });
    const error = await service.updateConnector(reader.id).catch((reason) => reason);
    expect(wordPressErrorCode(error)).toBe('readOnly');
    expect((await service.siteInfo(reader.id)).pluginVersion).toBe(OLD_VERSION);
  }, 120_000);

  it('updates the plugin from the zip that ships with the app', async () => {
    const connected = await service.connect({ connectionKey: site.keyFor('write') });
    const before = await service.siteInfo(connected.id);
    expect(before.pluginVersion).toBe(OLD_VERSION);
    expect(before.selfUpdate).toBe(true);

    const result = await service.updateConnector(connected.id);

    expect(result).toMatchObject({
      outcome: 'updated',
      fromVersion: OLD_VERSION,
      version: WP_CONNECTOR_VERSION,
    });
    const after = await service.siteInfo(connected.id);
    expect(after.pluginVersion).toBe(WP_CONNECTOR_VERSION);
    expect(after.selfUpdate).toBe(true);
    expect(after.guard.installed).toBe(true);
    const header = site.exec(`grep -m1 "Version:" ${PLUGIN_DIR}/runova-connector.php`);
    expect(header).toContain(WP_CONNECTOR_VERSION);
    expect(site.exec('ls -A /var/www/html/wp-content/plugins')).not.toContain('.runova');
    expect(site.wp(['plugin', 'list', '--status=active', '--field=name'])).toContain(
      'runova-connector',
    );

    const again = await service.updateConnector(connected.id);
    expect(again).toMatchObject({ outcome: 'current', version: WP_CONNECTOR_VERSION });
  }, 300_000);
});
