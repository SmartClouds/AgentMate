import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeProjectWordPressLink, type Project, type WpItemRef } from '@runova/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { systemTestsEnabled } from '../testing/testServerMachines';
import type { WpProjectsPort } from './projectLink';
import { WordPressProjectService } from './projectService';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { createFetchTransport } from './transport';

/**
 * The desktop's WordPress sync engine against the real Runova Connector plugin on WordPress in
 * Docker (E19 T10): pairing, a new project pulled from the site, a deploy with agent files left
 * in the theme folder (none may reach the site), a PHP syntax error refused before anything is
 * written, a fatal error rolled back on its own, a manual rollback, and a read-only key.
 *
 * Opt in with RUNOVA_SYSTEM_TESTS=1 (Linux containers). The fixture builds the plugin zip
 * when it is missing; its containers are named after the port and removed afterwards.
 */

const enabled = systemTestsEnabled();
const PORT = 18_997;
const THEME: WpItemRef = { kind: 'theme', slug: 'am-int' };
const THEME_DIR = '/var/www/html/wp-content/themes/am-int';

interface Fixture {
  url: string;
  exec: (command: string, options?: { allowFail?: boolean }) => string;
  wp: (args: string[]) => string;
  keyFor: (scope: 'read' | 'write') => string;
  stop: () => void;
}

describe.skipIf(!enabled)('WordPress projects against the real connector', () => {
  let site: Fixture;
  let dir: string;
  let service: WordPressProjectService;
  let siteId: string;
  let project: Project;
  const projects = new Map<string, Project>();
  let ops = 0;
  const op = () => `int-${++ops}-${randomUUID().slice(0, 8)}`;

  const port: WpProjectsPort = {
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

  const onSite = (path: string): string =>
    site.exec(`cat ${THEME_DIR}/${path} 2>/dev/null || echo __missing__`).trim();
  const local = (path: string): string | null => {
    const full = join(project.folderPath, 'wp-content', 'themes', 'am-int', ...path.split('/'));
    return existsSync(full) ? readFileSync(full, 'utf-8') : null;
  };
  const write = (path: string, content: string): void => {
    const full = join(project.folderPath, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const themeFile = (path: string) => `wp-content/themes/am-int/${path}`;

  async function plannedDeploy(force = false) {
    const plan = await service.planDeploy({ projectId: project.id });
    return { plan, result: service.deploy({ planId: plan.planId, operationId: op(), force }) };
  }

  beforeAll(async () => {
    const fixture = new URL(
      '../../../../../wordpress-connector/tests/smoke/fixture.mjs',
      import.meta.url,
    );
    const { startWordPressFixture } = (await import(fixture.href)) as {
      startWordPressFixture: (options: { port: number }) => Promise<Fixture>;
    };
    site = await startWordPressFixture({ port: PORT });
    site.exec(
      [
        `mkdir -p ${THEME_DIR}/inc`,
        `printf '/*\\nTheme Name: Runova Int\\n*/\\n' > ${THEME_DIR}/style.css`,
        `printf '<?php echo "home ok";\\n' > ${THEME_DIR}/index.php`,
        `printf '<?php\\nrequire __DIR__ . "/inc/setup.php";\\n' > ${THEME_DIR}/functions.php`,
        `printf '<?php // setup v1\\n' > ${THEME_DIR}/inc/setup.php`,
        `chown -R www-data:www-data ${THEME_DIR}`,
      ].join(' && '),
    );
    site.wp(['theme', 'activate', 'am-int']);

    dir = mkdtempSync(join(tmpdir(), 'runova-wp-int-'));
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
      readConnectorBundle: async () => {
        throw new Error('No connector bundle in this test.');
      },
      projects: port,
    });
  }, 900_000);

  afterAll(() => {
    site?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('pairs with a write key and reads the site', async () => {
    const connected = await service.connect({ connectionKey: site.keyFor('write') });
    siteId = connected.id;
    expect(connected).toMatchObject({ scope: 'write', transport: 'local-http' });

    const info = await service.siteInfo(siteId);
    expect(info.activeTheme.stylesheet).toBe('am-int');
    expect(info.guard.installed).toBe(true);
    const items = await service.listItems(siteId);
    expect(items.find((item) => item.kind === 'theme' && item.slug === 'am-int')).toMatchObject({
      active: true,
    });
    // The connector itself is never something to sync.
    const connector = items.find((item) => item.slug === 'runova-connector');
    if (connector) expect(connector.protected).toBe(true);
  }, 120_000);

  it('creates a project that keeps the site layout', async () => {
    project = await service.createProject({
      operationId: op(),
      siteId,
      items: [THEME],
      folderPath: join(dir, 'project'),
      name: 'Runova Int',
      agentType: 'claude-code',
    });
    expect(local('style.css')).toContain('Theme Name: Runova Int');
    expect(local('inc/setup.php')).toBe('<?php // setup v1\n');
    expect(project.prompt).toContain('untrusted data');
    expect(project.wordpress?.items).toEqual([THEME]);
  }, 180_000);

  it('deploys a change and never sends agent or Runova files', async () => {
    write(themeFile('inc/setup.php'), '<?php // setup v2\n');
    const agentFiles = [
      '.claude/settings.json',
      '.runova/hooks/notify.sh',
      '.agents/skills/x/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.mcp.json',
      '.env',
    ];
    for (const path of agentFiles) write(themeFile(path), 'local only');
    // Root-level agent files are not even walked.
    write('.claude/settings.json', '{}');
    write('AGENTS.md', '# local');

    const { plan, result } = await plannedDeploy();
    expect(plan.changes.map((change) => change.path)).toEqual(['inc/setup.php']);
    const leftOut = plan.leftOut.map((entry) => entry.path);
    for (const path of agentFiles) {
      expect(leftOut.some((left) => left === path || path.startsWith(left))).toBe(true);
    }

    expect(await result).toMatchObject({ state: 'done', uploaded: 1 });
    expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
    for (const path of agentFiles) expect(onSite(path)).toBe('__missing__');
  }, 240_000);

  it('refuses a PHP syntax error before anything is written', async () => {
    write(themeFile('inc/setup.php'), '<?php function broken( {\n');
    const { result } = await plannedDeploy();
    const error = await result.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(wordPressErrorCode(error)).toBe('syntaxError');
    expect(String(error)).toContain('wp-content/themes/am-int/inc/setup.php:1:');
    expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
  }, 240_000);

  it('rolls a deploy back on its own when the site stops working', async () => {
    write(themeFile('inc/setup.php'), '<?php runova_int_no_such_function();\n');
    const { result } = await plannedDeploy();
    const outcome = await result;
    expect(outcome.state).toBe('rolledBack');
    expect(['healthCheck', 'fatalError']).toContain(outcome.reason);
    expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
    expect((await fetch(`${site.url}/`)).status).toBe(200);
  }, 240_000);

  it('rolls back a finished deploy by hand from the history', async () => {
    write(themeFile('inc/setup.php'), '<?php // setup v3\n');
    const { result } = await plannedDeploy();
    const done = await result;
    expect(done.state).toBe('done');
    expect(onSite('inc/setup.php')).toBe('<?php // setup v3');

    const history = await service.history(siteId);
    expect(history[0]).toMatchObject({ deployId: done.deployId, state: 'done', canRollback: true });
    const rolled = await service.rollback({ operationId: op(), siteId, deployId: done.deployId });
    expect(rolled.state).toBe('rolledBack');
    expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
  }, 240_000);

  it('cannot deploy with a read-only key', async () => {
    const reconnected = await service.connect({ connectionKey: site.keyFor('read') });
    expect(reconnected).toMatchObject({ id: siteId, scope: 'read' });
    write(themeFile('inc/setup.php'), '<?php // setup v4\n');
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.warnings).toContain('readOnlyScope');
    const error = await service
      .deploy({ planId: plan.planId, operationId: op(), force: false })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(wordPressErrorCode(error)).toBe('readOnly');
    expect(onSite('inc/setup.php')).toBe('<?php // setup v2');
  }, 240_000);
});
