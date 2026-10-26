import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeProjectWordPressLink,
  type Project,
  WP_CONNECTOR_VERSION,
  WP_LEGACY_CONNECTOR_SLUG,
  WP_LEGACY_REST_NAMESPACE,
  WP_ROUTES,
  type WpItemRef,
  wpLegacyConnectorReleaseUrl,
} from '@runova/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { systemTestsEnabled } from '../testing/testServerMachines';
import { WpClient } from './client';
import { readShippedConnector } from './connectorBundle';
import { BRIDGE_ZIP_NAME, connectorZipPath } from './connectorZip';
import { privateKeyFromPem } from './crypto';
import type { WpProjectsPort } from './projectLink';
import { WordPressProjectService } from './projectService';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { createFetchTransport } from './transport';

/**
 * A site that runs the real 1.63 connector (the release zip, from before the rename) moving to
 * Runova Connector the way it will in the field: paired and deployed to under the old names,
 * updated through the 1.63 updater itself to the bridge package (the site downloads it, which
 * proves the old updater's health probe gets its answer from the new code), then moved to
 * runova-connector/ by /connector/migrate. Once on a single site, once on a network.
 *
 * The 1.63 zip comes from the v1.63.0 release, pinned by its sha256, and is kept in a cache
 * folder. Opt in with RUNOVA_SYSTEM_TESTS=1 (Linux containers), like wordpress.int.test.ts.
 */

const enabled = systemTestsEnabled();
const LEGACY_VERSION = '1.63.0';
const LEGACY_ZIP_URL = wpLegacyConnectorReleaseUrl(LEGACY_VERSION);
const LEGACY_ZIP_SHA256 = '965c33d9497137e7545d085e913c28a568b1d50a75be70b493e096d37d707c7b';
const LEGACY_CLI = 'agentmate'; // legacy-name
const APP_PATH = fileURLToPath(new URL('../../../../', import.meta.url));
const CONTENT = '/var/www/html/wp-content';
const THEME: WpItemRef = { kind: 'theme', slug: 'mv-int' };
const THEME_DIR = `${CONTENT}/themes/mv-int`;

interface Fixture {
  url: string;
  exec: (command: string, options?: { allowFail?: boolean }) => string;
  wp: (args: string[], options?: { allowFail?: boolean }) => string;
  writeFile: (path: string, content: string) => void;
  serveDownloads: (map: Record<string, string>) => void;
  keyFor: (scope: 'read' | 'write') => string;
  stop: () => void;
}

/** The 1.63.0 release zip, downloaded once into a cache folder and checked against its pin. */
async function legacyZip(): Promise<string> {
  const cache = join(tmpdir(), 'runova-test-cache');
  const file = join(cache, `agentmate-connector-${LEGACY_VERSION}.zip`); // legacy-name
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (!existsSync(file) || sha(file) !== LEGACY_ZIP_SHA256) {
    const response = await fetch(LEGACY_ZIP_URL, { redirect: 'follow' });
    if (!response.ok)
      throw new Error(`Could not download ${LEGACY_ZIP_URL}: HTTP ${response.status}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  if (sha(file) !== LEGACY_ZIP_SHA256) throw new Error(`${file} is not the pinned 1.63.0 release.`);
  return file;
}

function projectsPort(): WpProjectsPort {
  const projects = new Map<string, Project>();
  return {
    get: async (id) => projects.get(id) ?? null,
    create: async (input) => {
      const created = {
        id: randomUUID(),
        name: input.name,
        folderPath: input.folderPath,
        description: input.description,
        tags: input.tags,
        agentType: input.agentType,
        prompt: input.prompt ?? '',
        websiteUrl: input.websiteUrl ?? '',
        wordpress: normalizeProjectWordPressLink(input.wordpress),
      } as Project;
      projects.set(created.id, created);
      return created;
    },
    setLink: async (id, link) => {
      const next = { ...(projects.get(id) as Project), wordpress: link };
      if (!link) delete next.wordpress;
      projects.set(id, next);
      return next;
    },
  };
}

/** One site's whole move, from pairing on 1.63 to the old folder's removal. */
function moveSuite(options: { port: number; multisite: boolean }) {
  const label = options.multisite ? 'on a network' : 'on a single site';
  describe.skipIf(!enabled)(`Moving a 1.63 connector to Runova Connector ${label}`, () => {
    let site: Fixture;
    let dir: string;
    let state: WordPressState;
    let service: WordPressProjectService;
    let siteId: string;
    let project: Project;
    let ops = 0;
    const op = () => `mv-${++ops}-${randomUUID().slice(0, 8)}`;
    const transport = createFetchTransport(globalThis.fetch as never);

    const activePlugins = (): string[] =>
      options.multisite
        ? Object.keys(
            JSON.parse(
              site.wp(['site', 'option', 'get', 'active_sitewide_plugins', '--format=json']),
            ),
          )
        : JSON.parse(site.wp(['option', 'get', 'active_plugins', '--format=json']));
    const ls = (folder: string) => site.exec(`ls -A ${folder}`).split(/\s+/).filter(Boolean);
    const write = (path: string, content: string) => {
      const full = join(project.folderPath, 'wp-content', 'themes', 'mv-int', ...path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    const deploy = async (content: string) => {
      write('inc/setup.php', content);
      const plan = await service.planDeploy({ projectId: project.id });
      return service.deploy({ planId: plan.planId, operationId: op(), force: false });
    };
    const onSite = (path: string) =>
      site.exec(`cat ${THEME_DIR}/${path} 2>/dev/null || echo __missing__`).trim();

    /** A client for the saved site with other addresses, to reach one endpoint on purpose. */
    async function clientAt(endpoints: {
      restUrl: string;
      ajaxUrl: string;
      rescueUrl: string | null;
    }) {
      const stored = await state.site(siteId);
      if (!stored) throw new Error('The site is not saved.');
      return new WpClient({
        transport,
        endpoints,
        sitePublicKey: stored.sitePublicKey,
        connectionId: stored.connectionId,
        privateKey: privateKeyFromPem(
          Buffer.from(stored.privateKey.ciphertext, 'base64').toString('utf-8'),
        ),
      });
    }

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'runova-wp-move-'));
      // The fixture mounts the zip's folder in the container, so the bridge goes beside it.
      const dist = join(dir, 'dist');
      mkdirSync(dist);
      const oldZip = join(dist, `agentmate-connector-${LEGACY_VERSION}.zip`); // legacy-name
      copyFileSync(await legacyZip(), oldZip);
      const bridgeZip = connectorZipPath(
        { isPackaged: false, resourcesPath: '', appPath: APP_PATH },
        BRIDGE_ZIP_NAME,
      );
      if (!existsSync(bridgeZip)) {
        throw new Error(
          'Build the connector zips first: node scripts/wordpress-connector.mjs build',
        );
      }
      copyFileSync(bridgeZip, join(dist, BRIDGE_ZIP_NAME));

      const fixture = new URL(
        '../../../../../wordpress-connector/tests/smoke/fixture.mjs',
        import.meta.url,
      );
      const { startWordPressFixture } = (await import(fixture.href)) as {
        startWordPressFixture: (options: Record<string, unknown>) => Promise<Fixture>;
      };
      site = await startWordPressFixture({
        port: options.port,
        multisite: options.multisite,
        zip: oldZip,
        slug: WP_LEGACY_CONNECTOR_SLUG,
        cli: LEGACY_CLI,
      });
      // The release zip under the address a 1.63 site downloads it from, served from the mount.
      site.serveDownloads({
        [wpLegacyConnectorReleaseUrl(WP_CONNECTOR_VERSION)]: `/runova-dist/${BRIDGE_ZIP_NAME}`,
      });
      site.exec(
        [
          `mkdir -p ${THEME_DIR}/inc`,
          `printf '/*\\nTheme Name: Move Int\\n*/\\n' > ${THEME_DIR}/style.css`,
          `printf '<?php echo "home ok";\\n' > ${THEME_DIR}/index.php`,
          `printf '<?php\\nrequire __DIR__ . "/inc/setup.php";\\n' > ${THEME_DIR}/functions.php`,
          `printf '<?php // setup v1\\n' > ${THEME_DIR}/inc/setup.php`,
          `chown -R www-data:www-data ${THEME_DIR}`,
        ].join(' && '),
      );
      site.wp(['theme', 'enable', 'mv-int', ...(options.multisite ? ['--network'] : [])], {
        allowFail: true,
      });
      site.wp(['theme', 'activate', 'mv-int']);

      state = new WordPressState(wordPressStateFilePort(join(dir, 'deploy-wordpress.json')));
      const dev = { isPackaged: false, resourcesPath: '', appPath: APP_PATH };
      service = new WordPressProjectService({
        state,
        bases: new WordPressBases(join(dir, 'bases')),
        transport,
        seal: async (plain) => ({
          mode: 'safeStorage',
          ciphertext: Buffer.from(plain).toString('base64'),
        }),
        unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString('utf-8'),
        isLocked: () => false,
        progress: () => undefined,
        hostname: () => 'move-int',
        saveConnectorZip: async () => ({ saved: false }),
        readConnectorBundle: () => readShippedConnector(dev),
        // As a packaged app would: the site is asked to download the bridge itself first.
        readBridgeBundle: async () => {
          const bundle = await readShippedConnector(dev, 'bridge');
          return { ...bundle, downloadUrl: wpLegacyConnectorReleaseUrl(bundle.version) };
        },
        projects: projectsPort(),
      });
    }, 900_000);

    afterAll(() => {
      site?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('pairs with the 1.63 plugin and deploys under the old names', async () => {
      const connected = await service.connect({ connectionKey: site.keyFor('write') });
      siteId = connected.id;
      const stored = await state.site(siteId);
      expect(stored?.restUrl).toContain(`/${WP_LEGACY_REST_NAMESPACE}`);
      const info = await service.siteInfo(siteId);
      expect(info.pluginVersion).toBe(LEGACY_VERSION);
      expect(info.layout).toBeUndefined();

      project = await service.createProject({
        operationId: op(),
        siteId,
        items: [THEME],
        folderPath: join(dir, 'project'),
        name: 'Move Int',
        agentType: 'claude-code',
      });
      expect(await deploy('<?php // setup v2\n')).toMatchObject({ state: 'done', uploaded: 1 });
      expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
    }, 300_000);

    if (!options.multisite) {
      it('installs the bridge through the 1.63 updater, then puts it all back when the move fails its health check', async () => {
        // Fails the loopback ping only once Runova Connector is the active copy.
        site.writeFile(
          `${CONTENT}/mu-plugins/zz-test-health.php`,
          [
            '<?php',
            "if (isset($_GET['runova_health'], $_GET['action']) && in_array('runova-connector/runova-connector.php', (array) get_option('active_plugins'), true)) {",
            "  add_action('admin_init', function () { status_header(500); exit; }, 0);",
            '}',
            '',
          ].join('\n'),
        );
        const result = await service.updateConnector(siteId);
        expect(result).toMatchObject({
          outcome: 'updated',
          source: 'site',
          fromVersion: LEGACY_VERSION,
        });
        expect(result.moved).toBeUndefined();
        expect(result.moveProblem).toContain('health check');

        expect(activePlugins()).toContain('agentmate-connector/agentmate-connector.php'); // legacy-name
        expect(ls(`${CONTENT}/plugins`)).not.toContain('runova-connector');
        expect(ls(`${CONTENT}/plugins/${WP_LEGACY_CONNECTOR_SLUG}`)).toContain('layout');
        const info = await service.siteInfo(siteId);
        expect(info.layout).toBe('bridge');
        // The bridge answers WP-CLI under both names, with the guard it put in place.
        expect(site.wp([LEGACY_CLI, 'status', '--format=json'])).toContain('guard');
        expect(site.wp(['runova', 'status', '--format=json'])).toContain('guard');
        site.exec(`rm ${CONTENT}/mu-plugins/zz-test-health.php`);
      }, 300_000);

      it('stays in the old folder while the plugins folder is read-only', async () => {
        site.exec(`chmod 555 ${CONTENT}/plugins`);
        try {
          const result = await service.updateConnector(siteId);
          expect(result.moved).toBeUndefined();
          expect(result.moveProblem).toMatch(/not writable|cannot write/i);
          expect(ls(`${CONTENT}/plugins`)).not.toContain('runova-connector');
          expect((await service.siteInfo(siteId)).layout).toBe('bridge');
        } finally {
          site.exec(`chmod 755 ${CONTENT}/plugins`);
        }
      }, 300_000);
    }

    it('moves to its own folder and saves the new addresses', async () => {
      // On the single site the old folder goes after a short grace period, so the test can see
      // it go; the network keeps it, so the owner can delete it first.
      if (!options.multisite) {
        site.wp(['config', 'set', 'RUNOVA_CONNECTOR_MIGRATION_GRACE_SECONDS', '2', '--raw']);
      }
      const result = await service.updateConnector(siteId);
      expect(result.moved).toBe(true);
      expect(result.moveProblem).toBeUndefined();

      const active = activePlugins();
      expect(active).toContain('runova-connector/runova-connector.php');
      expect(active).not.toContain('agentmate-connector/agentmate-connector.php'); // legacy-name
      const mu = ls(`${CONTENT}/mu-plugins`);
      expect(mu).toContain('00-runova-connector-guard.php');
      expect(mu).not.toContain('00-agentmate-connector-guard.php'); // legacy-name
      expect(site.exec(`cat ${CONTENT}/mu-plugins/00-runova-connector-guard.php`)).toContain(
        `${CONTENT}/plugins/runova-connector'`,
      );
      const files = ls(`${CONTENT}/plugins/runova-connector`);
      expect(files).toContain('runova-connector.php');
      expect(files).not.toContain('layout');

      const stored = await state.site(siteId);
      expect(stored?.restUrl).toContain('/runova/v1');
      expect(stored?.rescueUrl).toContain('/runova-connector/rescue.php');
      const info = await service.siteInfo(siteId);
      expect(info.layout).toBe('runova');
      expect(info.pluginVersion).toBe(WP_CONNECTOR_VERSION);
      expect(info.guard.installed).toBe(true);
    }, 300_000);

    it('answers at both namespaces, and rescue.php answers at its new address', async () => {
      const stored = await state.site(siteId);
      if (!stored) throw new Error('The site is not saved.');
      const legacy = await clientAt({
        restUrl: `${site.url}/wp-json/${WP_LEGACY_REST_NAMESPACE}`,
        ajaxUrl: stored.ajaxUrl,
        rescueUrl: null,
      });
      expect(legacy.legacy).toBe(true);
      expect((await legacy.call(WP_ROUTES.siteInfo, {})).data.layout).toBe('runova');
      const viaAjax = await clientAt({
        restUrl: `${site.url}/wp-json/${WP_LEGACY_REST_NAMESPACE}`,
        ajaxUrl: stored.ajaxUrl,
        rescueUrl: null,
      });
      viaAjax.endpoint = 'ajax';
      expect((await viaAjax.call(WP_ROUTES.siteInfo, {})).data.layout).toBe('runova');

      // REST and admin-ajax answer with WordPress's own 404 page (addresses the guard does not
      // take for ours either), so the client falls back to rescue.php.
      const rescue = await clientAt({
        restUrl: `${site.url}/no-such-place`,
        ajaxUrl: `${site.url}/no-such-place.php`,
        rescueUrl: stored.rescueUrl,
      });
      const status = await rescue.call(WP_ROUTES.rescueStatus, {});
      expect(status.data.pending).toBeNull();
    }, 120_000);

    it('still honors the read-only switch under its 1.63 name in wp-config.php', async () => {
      site.wp(['config', 'set', 'AGENTMATE_CONNECTOR_READ_ONLY', 'true', '--raw']); // legacy-name
      try {
        expect((await service.siteInfo(siteId)).readOnlyByConstant).toBe(true);
        const error = await deploy('<?php // setup read-only\n').then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(wordPressErrorCode(error)).toBe('readOnly');
      } finally {
        site.wp(['config', 'delete', 'AGENTMATE_CONNECTOR_READ_ONLY']); // legacy-name
      }
      expect((await service.siteInfo(siteId)).readOnlyByConstant).toBe(false);
    }, 120_000);

    it('deploys after the move', async () => {
      expect(await deploy('<?php // setup v3\n')).toMatchObject({ state: 'done' });
      expect(onSite('inc/setup.php')).toBe('<?php // setup v3');
    }, 240_000);

    if (options.multisite) {
      it('keeps the tables when the old copy is deleted with its uninstall.php', async () => {
        // A long grace period on this one: the owner deletes the old copy first.
        site.wp(['plugin', 'uninstall', WP_LEGACY_CONNECTOR_SLUG]);
        expect(ls(`${CONTENT}/plugins`)).not.toContain(WP_LEGACY_CONNECTOR_SLUG);
        const tables = site
          .wp(['db', 'query', "SHOW TABLES LIKE '%agentmate\\_%'", '--skip-column-names']) // legacy-name
          .split(/\s+/)
          .filter(Boolean);
        expect(tables).toHaveLength(7);
        expect((await service.siteInfo(siteId)).layout).toBe('runova');
      }, 120_000);
    } else {
      it('removes the old folder once its grace period is over, and keeps the tables', async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        // Any call of the app's runs the check.
        await service.siteInfo(siteId);
        expect(ls(`${CONTENT}/plugins`)).not.toContain(WP_LEGACY_CONNECTOR_SLUG);
        const tables = site
          .wp(['db', 'query', "SHOW TABLES LIKE '%agentmate\\_%'", '--skip-column-names']) // legacy-name
          .split(/\s+/)
          .filter(Boolean);
        expect(tables).toHaveLength(7);
        expect((await service.siteInfo(siteId)).layout).toBe('runova');
      }, 120_000);
    }
  });
}

moveSuite({ port: 18_994, multisite: false });
moveSuite({ port: 18_993, multisite: true });
