import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  normalizeProjectWordPressLink,
  type Project,
  type WpItemRef,
  wpItemKey,
} from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeployWordPressProgressEvent } from '../../../shared/deployWordPressTypes';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import type { WpProjectsPort } from './projectLink';
import { WordPressProjectService } from './projectService';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { FakeConnector } from './testing/fakeConnector';
import { WP_AGENT_FILES } from './testing/vectors';
import { createFetchTransport } from './transport';

/**
 * WordPress projects end to end against the fake connector over HTTP: a new project pulled from
 * a site, pulls and deploys with their plans, conflicts, PHP syntax errors, health checks that
 * roll back, cancels, the agent-files fixture on a real deploy, item changes and relinks.
 */

const THEME: WpItemRef = { kind: 'theme', slug: 'shop' };
const TOOLS: WpItemRef = { kind: 'plugin', slug: 'tools' };
const HELLO: WpItemRef = { kind: 'plugin', slug: 'hello.php' };
const nodeTransport = createFetchTransport(globalThis.fetch as never);

let fake: FakeConnector;
let dir: string;
let events: DeployWordPressProgressEvent[];
let onProgress: ((event: DeployWordPressProgressEvent) => void) | null;
let projects: Map<string, Project>;
let service: WordPressProjectService;
let state: WordPressState;
let bases: WordPressBases;
let siteId: string;
let opCount = 0;

const op = () => `op-test-${++opCount}-${randomUUID().slice(0, 8)}`;
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

const port: WpProjectsPort = {
  get: async (id) => projects.get(id) ?? null,
  create: async (input) => {
    const project = {
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
    projects.set(project.id, project);
    return project;
  },
  setLink: async (id, link, changes) => {
    const current = projects.get(id) as Project;
    const next = { ...current, ...changes, wordpress: link };
    if (!link) delete next.wordpress;
    projects.set(id, next);
    return next;
  },
};

function make(planTtlMs?: number) {
  state = new WordPressState(wordPressStateFilePort(join(dir, 'deploy-wordpress.json')));
  bases = new WordPressBases(join(dir, 'bases'));
  service = new WordPressProjectService({
    state,
    bases,
    transport: nodeTransport,
    seal: async (plain) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plain).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString('utf-8'),
    isLocked: () => false,
    progress: (event) => {
      events.push(event);
      onProgress?.(event);
    },
    hostname: () => 'laptop',
    saveConnectorZip: async () => ({ saved: false }),
    readConnectorBundle: async () => {
      throw new Error('No connector bundle in this test.');
    },
    sleep: async () => undefined,
    projects: port,
    ...(planTtlMs === undefined ? {} : { planTtlMs }),
  });
}

beforeEach(async () => {
  fake = await new FakeConnector().start();
  fake.addItem(
    THEME,
    {
      'style.css': '/* Theme Name: Shop */',
      'functions.php': '<?php // shop',
      'index.php': '<?php // index',
      'inc/setup.php': '<?php // setup',
    },
    { active: true, name: 'Shop' },
  );
  fake.addItem(
    TOOLS,
    { 'tools.php': '<?php // tools', 'readme.txt': 'Tools' },
    { active: true, mainFile: 'tools/tools.php', name: 'Tools' },
  );
  fake.addItem(HELLO, { 'hello.php': '<?php // hello' }, { isFile: true, name: 'Hello' });
  dir = mkdtempSync(join(tmpdir(), 'runova-wp-projects-'));
  events = [];
  onProgress = null;
  projects = new Map();
  make();
  siteId = (await service.connect({ connectionKey: fake.createKey() })).id;
});

afterEach(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  return join(dir, `project-${randomUUID().slice(0, 8)}`);
}

async function createShop(items: WpItemRef[] = [THEME], folderPath = folder()): Promise<Project> {
  return service.createProject({
    operationId: op(),
    siteId,
    items,
    folderPath,
    name: 'Shop',
    agentType: 'claude-code',
  });
}

function local(project: Project, path: string): string | null {
  const full = join(project.folderPath, ...path.split('/'));
  return existsSync(full) ? readFileSync(full, 'utf-8') : null;
}

function write(project: Project, path: string, content: string): void {
  const full = join(project.folderPath, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

function plainProject(overrides: Partial<Project> = {}): Project {
  const folderPath = folder();
  mkdirSync(folderPath, { recursive: true });
  const project = {
    id: randomUUID(),
    name: 'Plain',
    folderPath,
    prompt: 'Use tabs.',
    websiteUrl: '',
    ...overrides,
  } as Project;
  projects.set(project.id, project);
  return project;
}

async function deployAll(project: Project, force = false) {
  const plan = await service.planDeploy({ projectId: project.id });
  return { plan, result: await service.deploy({ planId: plan.planId, operationId: op(), force }) };
}

describe('createProject', () => {
  it('pulls the items, writes the base and makes the project with its prompt', async () => {
    const project = await createShop([THEME, TOOLS, HELLO]);
    expect(local(project, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(local(project, 'wp-content/plugins/tools/tools.php')).toBe('<?php // tools');
    expect(local(project, 'wp-content/plugins/hello.php')).toBe('<?php // hello');
    expect(project.wordpress?.siteId).toBe(siteId);
    expect(project.wordpress?.items.map(wpItemKey)).toEqual([
      'theme:shop',
      'plugin:tools',
      'plugin:hello.php',
    ]);
    expect(project.prompt).toContain(
      'Theme "Shop" (version 1.0.0, active): wp-content/themes/shop/',
    );
    expect(project.prompt).toContain('wp-content/plugins/hello.php');
    expect(project.websiteUrl).toBe(fake.siteUrl);

    const base = await bases.read(project.id);
    expect(base?.items['plugin:hello.php']).toEqual({
      isFile: true,
      files: { 'hello.php': { sha256: sha('<?php // hello'), size: 14 } },
    });
    expect(Object.keys(base?.items['theme:shop'].files ?? {}).sort()).toEqual([
      'functions.php',
      'inc/setup.php',
      'index.php',
      'style.css',
    ]);
    const phases = events.filter((event) => event.kind === 'createProject').map((e) => e.phase);
    expect(phases[0]).toBe('connecting');
    expect(phases).toContain('download');
    expect(phases.at(-1)).toBe('done');

    // Nothing changed on either side since.
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
    expect((await service.planPull({ projectId: project.id })).changes).toEqual([]);
    expect(await service.localChanges(project.id)).toMatchObject({
      added: 0,
      modified: 0,
      deleted: 0,
    });
  });

  it('refuses item folders that already hold files', async () => {
    const path = folder();
    mkdirSync(join(path, 'wp-content', 'themes', 'shop'), { recursive: true });
    writeFileSync(join(path, 'wp-content', 'themes', 'shop', 'mine.txt'), 'mine');
    const error = await failure(createShop([THEME], path));
    expect(wordPressErrorCode(error)).toBe('folderNotEmpty');
    expect(error.message).toContain('wp-content/themes/shop');
    expect(readFileSync(join(path, 'wp-content/themes/shop/mine.txt'), 'utf-8')).toBe('mine');

    writeFileSync(join(path, 'wp-content', 'plugins'), 'not a folder');
    expect(wordPressErrorCode(await failure(createShop([HELLO], path)))).toBe('pathRejected');
    writeFileSync(join(dir, 'a-file'), 'x');
    expect(wordPressErrorCode(await failure(createShop([THEME], join(dir, 'a-file'))))).toBe(
      'folderNotEmpty',
    );
  });

  it('removes only what it made when it fails', async () => {
    const fresh = folder();
    const missing = await failure(createShop([THEME, { kind: 'plugin', slug: 'nope' }], fresh));
    expect(wordPressErrorCode(missing)).toBe('itemUnknown');
    expect(existsSync(fresh)).toBe(false);

    const existing = folder();
    mkdirSync(existing);
    writeFileSync(join(existing, 'notes.md'), 'mine');
    fake.switches.rateLimitNext = 0;
    onProgress = (event) => {
      if (event.phase === 'download') fake.switches.foreign = { status: 503 };
    };
    expect(wordPressErrorCode(await failure(createShop([THEME], existing)))).toBe(
      'foreignResponse',
    );
    onProgress = null;
    fake.switches.foreign = null;
    expect(readFileSync(join(existing, 'notes.md'), 'utf-8')).toBe('mine');
    expect(existsSync(join(existing, 'wp-content'))).toBe(false);
    expect(projects.size).toBe(0);
  });

  it('refuses the connector itself', async () => {
    fake.addItem({ kind: 'plugin', slug: 'runova-connector' }, {}, { protected: true });
    expect(
      wordPressErrorCode(await failure(createShop([{ kind: 'plugin', slug: 'runova-connector' }]))),
    ).toBe('itemProtected');
  });
});

describe('deploy', () => {
  it('sends local changes and moves the base once the site says done', async () => {
    const project = await createShop([THEME, TOOLS]);
    write(project, 'wp-content/themes/shop/style.css', '/* Theme Name: Shop 2 */');
    write(project, 'wp-content/themes/shop/inc/new.php', '<?php // new');
    rmSync(join(project.folderPath, 'wp-content/themes/shop/index.php'));

    expect(await service.localChanges(project.id)).toMatchObject({
      added: 1,
      modified: 1,
      deleted: 1,
    });
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.changes.map((change) => `${change.action}:${change.path}`)).toEqual([
      'upload:inc/new.php',
      'deleteRemote:index.php',
      'upload:style.css',
    ]);
    expect(plan.warnings).toContain('touchesActiveThemeCore');
    expect(plan.expiresAt).toBeGreaterThan(Date.now());

    const result = await service.deploy({ planId: plan.planId, operationId: op(), force: false });
    expect(result).toMatchObject({ state: 'done', uploaded: 2, deleted: 1 });
    expect(result.health.map((check) => check.name)).toEqual(['home', 'ajaxPing', 'external']);
    expect(result.health.at(-1)).toMatchObject({ ok: true, status: 200 });
    expect(fake.file(THEME, 'style.css')).toBe('/* Theme Name: Shop 2 */');
    expect(fake.file(THEME, 'inc/new.php')).toBe('<?php // new');
    expect(fake.file(THEME, 'index.php')).toBeNull();
    expect(await state.inflight(siteId)).toBeNull();
    expect(await bases.readPending(project.id)).toBeNull();
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
    expect(fake.deploys.at(-1)?.label).toBe('Runova: Shop');
    const phases = events.filter((event) => event.kind === 'deploy').map((event) => event.phase);
    expect(phases).toEqual(
      expect.arrayContaining(['hashing', 'upload', 'validate', 'verify', 'finalize', 'done']),
    );
  });

  it('never sends agent or Runova files: the shared fixture', async () => {
    const project = await createShop([THEME]);
    const root = 'wp-content/themes/shop';
    for (const file of WP_AGENT_FILES.files) write(project, `${root}/${file.path}`, file.path);
    write(project, 'AGENTS.md', 'project agents');
    write(project, '.claude/settings.json', '{}');

    const plan = await service.planDeploy({ projectId: project.id });
    const planned = new Set(plan.changes.map((change) => change.path));
    const leftOut = new Map(plan.leftOut.map((entry) => [entry.path, entry.reason]));
    for (const file of WP_AGENT_FILES.files) {
      if (file.expect === 'synced') expect(planned.has(file.path), file.path).toBe(true);
      else expect(planned.has(file.path), file.path).toBe(false);
      if (file.expect === 'hardDenied') expect(leftOut.has(file.path), file.path).toBe(true);
    }
    expect(leftOut.get('.claude/settings.json')).toBe('agentFiles');
    expect(leftOut.get('.git/HEAD')).toBe('hardDenied');

    await service.deploy({ planId: plan.planId, operationId: op(), force: false });
    const onSite = [...(fake.items.get('theme:shop')?.files.keys() ?? [])];
    for (const file of WP_AGENT_FILES.files.filter((entry) => entry.expect !== 'synced')) {
      expect(onSite, file.path).not.toContain(file.path);
    }
    expect(onSite).toContain('templates/single.html');
  });

  it('uploads big files in pieces and halves its batches on a 413', async () => {
    fake.limits.maxRequestBytes = 1024 * 1024;
    const project = await createShop([THEME]);
    // Random bytes, so gzip cannot shrink the request under the limit.
    const big = randomBytes(700 * 1024);
    const full = join(project.folderPath, 'wp-content/themes/shop/assets/big.bin');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, big);
    write(project, 'wp-content/themes/shop/assets/small.js', 'small');
    fake.switches.maxBodyBytes = 400 * 1024;
    const { result } = await deployAll(project);
    expect(result.state).toBe('done');
    expect(fake.items.get('theme:shop')?.files.get('assets/big.bin')?.equals(big)).toBe(true);
    expect(fake.file(THEME, 'assets/small.js')).toBe('small');
    expect(Math.max(...fake.uploadSizes)).toBeLessThanOrEqual(256 * 1024);
    expect(fake.uploadSizes.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a deploy with conflicts unless forced', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'mine');
    fake.setFile(THEME, 'style.css', 'theirs');
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.conflicts.map((change) => change.path)).toEqual(['style.css']);
    const refused = await failure(
      service.deploy({ planId: plan.planId, operationId: op(), force: false }),
    );
    expect(wordPressErrorCode(refused)).toBe('conflict');
    expect(refused.message).toBe(
      '[wp:conflict] 1 file changed both here and on the site.\nwp-content/themes/shop/style.css: changed both here and on the site',
    );
    // The same reviewed plan can then go ahead with force.
    const result = await service.deploy({ planId: plan.planId, operationId: op(), force: true });
    expect(result.state).toBe('done');
    expect(fake.file(THEME, 'style.css')).toBe('mine');
  });

  it('stops when the site changed again after the plan', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'mine');
    const plan = await service.planDeploy({ projectId: project.id });
    fake.setFile(THEME, 'style.css', 'changed meanwhile');
    const error = await failure(
      service.deploy({ planId: plan.planId, operationId: op(), force: false }),
    );
    expect(wordPressErrorCode(error)).toBe('conflict');
    expect(error.message).toContain(
      'wp-content/themes/shop/style.css: changed on the site since the plan',
    );
    expect(fake.deploys).toHaveLength(0);
  });

  it('reports PHP syntax errors line by line, and leaves the site as it was', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/functions.php', '<?php SYNTAX_ERROR');
    const { plan } = await (async () => {
      const made = await service.planDeploy({ projectId: project.id });
      return { plan: made };
    })();
    const error = await failure(
      service.deploy({ planId: plan.planId, operationId: op(), force: false }),
    );
    expect(error.message).toBe(
      '[wp:syntaxError] 1 PHP file has a syntax error.\nwp-content/themes/shop/functions.php:1: syntax error',
    );
    expect(fake.deploys.at(-1)?.state).toBe('aborted');
    expect(fake.file(THEME, 'functions.php')).toBe('<?php // shop');
    expect(await state.inflight(siteId)).toBeNull();
    expect(await bases.readPending(project.id)).toBeNull();
    expect(events.at(-1)).toMatchObject({ kind: 'deploy', phase: 'failed' });
  });

  it('returns a rolled-back result when the site health check fails', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'broken');
    fake.switches.healthFails = true;
    const { result } = await deployAll(project);
    expect(result).toMatchObject({ state: 'rolledBack', reason: 'healthCheck' });
    expect(fake.file(THEME, 'style.css')).toBe('/* Theme Name: Shop */');
    expect((await service.planDeploy({ projectId: project.id })).changes).toHaveLength(1);
  });

  it('rolls back when this computer sees the home page fail after the apply', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'breaks the front end');
    onProgress = (event) => {
      if (event.phase === 'verify') fake.switches.homeStatus = 500;
    };
    const { result } = await deployAll(project);
    expect(result.state).toBe('rolledBack');
    expect(result.health.at(-1)).toMatchObject({ name: 'external', ok: false, status: 500 });
    expect(fake.file(THEME, 'style.css')).toBe('/* Theme Name: Shop */');
  });

  it('rolls back an applied deploy when cancelled', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'new');
    const plan = await service.planDeploy({ projectId: project.id });
    const operationId = op();
    onProgress = (event) => {
      if (event.phase === 'verify') {
        fake.switches.delayMs = 300;
        setTimeout(() => void service.cancel(operationId), 50);
      }
    };
    const error = await failure(service.deploy({ planId: plan.planId, operationId, force: false }));
    fake.switches.delayMs = 0;
    expect(wordPressErrorCode(error)).toBe('cancelled');
    expect(fake.deploys.at(-1)?.state).toBe('rolledBack');
    expect(fake.file(THEME, 'style.css')).toBe('/* Theme Name: Shop */');
    expect(await state.inflight(siteId)).toBeNull();
  });

  it('refuses files changed after the plan, an old plan, and a used plan', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'one');
    const plan = await service.planDeploy({ projectId: project.id });
    write(project, 'wp-content/themes/shop/style.css', 'two!');
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: plan.planId, operationId: op(), force: false })),
      ),
    ).toBe('localChanged');
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: plan.planId, operationId: op(), force: false })),
      ),
    ).toBe('planExpired');

    make(1);
    const old = await service.planDeploy({ projectId: project.id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: old.planId, operationId: op(), force: false })),
      ),
    ).toBe('planExpired');
    const pullPlan = await service.planPull({ projectId: project.id });
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: pullPlan.planId, operationId: op(), force: false })),
      ),
    ).toBe('planExpired');
  });

  it('says when there is nothing to deploy, or the key can only read', async () => {
    const project = await createShop([THEME]);
    const empty = await service.planDeploy({ projectId: project.id });
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: empty.planId, operationId: op(), force: false })),
      ),
    ).toBe('badRequest');

    await service.connect({ connectionKey: fake.createKey({ scope: 'read' }) });
    write(project, 'wp-content/themes/shop/style.css', 'x');
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.warnings).toContain('readOnlyScope');
    expect(
      wordPressErrorCode(
        await failure(service.deploy({ planId: plan.planId, operationId: op(), force: false })),
      ),
    ).toBe('readOnly');
  });

  it('creates a new item on the site, and warns about deleting an active plugin main file', async () => {
    const project = await createShop([TOOLS]);
    const fresh: WpItemRef = { kind: 'plugin', slug: 'fresh' };
    await port.setLink(project.id, {
      siteId,
      items: [TOOLS, fresh],
      linkedAt: new Date().toISOString(),
    });
    write(project, 'wp-content/plugins/fresh/fresh.php', '<?php // fresh');
    rmSync(join(project.folderPath, 'wp-content/plugins/tools/tools.php'));
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.warnings).toEqual(
      expect.arrayContaining(['createsItem', 'deletesActivePluginMainFile']),
    );
    // The fake refuses it like the plugin would, unless forced.
    const refused = await failure(
      service.deploy({ planId: plan.planId, operationId: op(), force: false }),
    );
    expect(wordPressErrorCode(refused)).toBe('conflict');
    expect(refused.message).toContain(
      "wp-content/plugins/tools/tools.php: it would delete an active plugin's main file",
    );
    const { result } = await deployAll(
      { ...project, wordpress: projects.get(project.id)?.wordpress },
      true,
    );
    expect(result.state).toBe('done');
    expect(fake.file(fresh, 'fresh.php')).toBe('<?php // fresh');
  });

  it('leaves a missing item folder alone instead of deleting it on the site', async () => {
    const project = await createShop([THEME]);
    rmSync(join(project.folderPath, 'wp-content'), { recursive: true });
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
    expect(await service.localChanges(project.id)).toMatchObject({ deleted: 0 });
  });
});

describe('the saved ignore list', () => {
  it('is kept on the link, and plans made before it are dropped', async () => {
    const project = await createShop([THEME, TOOLS]);
    write(project, 'wp-content/themes/shop/inc/new.php', '<?php // new');
    const before = await service.planDeploy({ projectId: project.id });

    const updated = await service.setProjectIgnore({
      projectId: project.id,
      ignore: { '*': ['*.map'], 'theme:shop': ['/inc/'], 'plugin:gone': ['/x/'] },
    });
    expect(updated.wordpress?.ignore).toEqual({ '*': ['*.map'], 'theme:shop': ['/inc/'] });
    expect(updated.wordpress?.items.map(wpItemKey)).toEqual(['theme:shop', 'plugin:tools']);
    expect(projects.get(project.id)?.wordpress?.ignore).toEqual(updated.wordpress?.ignore);

    const stale = await failure(
      service.deploy({ planId: before.planId, operationId: op(), force: false }),
    );
    expect(wordPressErrorCode(stale)).toBe('planExpired');

    const cleared = await service.setProjectIgnore({ projectId: project.id, ignore: {} });
    expect(cleared.wordpress && 'ignore' in cleared.wordpress).toBe(false);
  });

  it('keeps a changed file out of the plan and the count, and says it was left out', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/inc/setup.php', '<?php // changed');
    write(project, 'wp-content/themes/shop/inc/more.php', '<?php // more');
    write(project, 'wp-content/themes/shop/style.css', '/* Theme Name: Shop 2 */');
    expect(await service.localChanges(project.id)).toMatchObject({ added: 1, modified: 2 });

    await service.setProjectIgnore({ projectId: project.id, ignore: { 'theme:shop': ['/inc/'] } });
    expect(await service.localChanges(project.id)).toMatchObject({
      added: 0,
      modified: 1,
      deleted: 0,
    });
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.changes.map((change) => `${change.action}:${change.path}`)).toEqual([
      'upload:style.css',
    ]);
    expect(plan.leftOut).toContainEqual({ item: THEME, path: 'inc/', reason: 'ignored' });
  });

  it('does not delete on the site what it now ignores, and never sends it', async () => {
    const project = await createShop([THEME]);
    await service.setProjectIgnore({ projectId: project.id, ignore: { '*': ['/inc/'] } });
    rmSync(join(project.folderPath, 'wp-content/themes/shop/inc'), { recursive: true });
    write(project, 'wp-content/themes/shop/style.css', '/* Theme Name: Shop 2 */');

    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.changes.map((change) => `${change.action}:${change.path}`)).toEqual([
      'upload:style.css',
    ]);
    const result = await service.deploy({ planId: plan.planId, operationId: op(), force: false });
    expect(result.state).toBe('done');
    expect(fake.file(THEME, 'inc/setup.php')).toBe('<?php // setup');
    expect(await service.localChanges(project.id)).toMatchObject({ deleted: 0 });
  });

  it('does not pull what is ignored either', async () => {
    const project = await createShop([THEME]);
    await service.setProjectIgnore({ projectId: project.id, ignore: { 'theme:shop': ['/inc/'] } });
    fake.setFile(THEME, 'inc/setup.php', '<?php // site edit');
    fake.setFile(THEME, 'style.css', '/* site edit */');
    const plan = await service.planPull({ projectId: project.id });
    expect(plan.changes.map((change) => change.path)).toEqual(['style.css']);
    expect(plan.leftOut).toContainEqual({ item: THEME, path: 'inc/setup.php', reason: 'ignored' });
  });

  it('stays when items are added or taken away, for the items that remain', async () => {
    const project = await createShop([THEME]);
    await service.setProjectIgnore({
      projectId: project.id,
      ignore: { '*': ['*.map'], 'theme:shop': ['/inc/'] },
    });
    const more = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [THEME, TOOLS],
    });
    expect(more.wordpress?.ignore).toEqual({ '*': ['*.map'], 'theme:shop': ['/inc/'] });

    await service.setProjectIgnore({
      projectId: project.id,
      ignore: { '*': ['*.map'], 'theme:shop': ['/inc/'], 'plugin:tools': ['/docs/'] },
    });
    const fewer = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [TOOLS],
    });
    expect(fewer.wordpress?.ignore).toEqual({ '*': ['*.map'], 'plugin:tools': ['/docs/'] });
  });

  it('refuses a line it cannot read, naming the line, and keeps what was saved', async () => {
    const project = await createShop([THEME]);
    await service.setProjectIgnore({ projectId: project.id, ignore: { '*': ['*.map'] } });
    const error = await failure(
      service.setProjectIgnore({
        projectId: project.id,
        ignore: { 'theme:shop': ['/ok/', '[z-a]'] },
      }),
    );
    expect(wordPressErrorCode(error)).toBe('badRequest');
    expect(error.message).toContain('Line 2');
    expect(error.message).toContain('theme:shop');
    expect(projects.get(project.id)?.wordpress?.ignore).toEqual({ '*': ['*.map'] });
  });

  it('refuses a project that is not linked', async () => {
    const plain = plainProject();
    const error = await failure(
      service.setProjectIgnore({ projectId: plain.id, ignore: { '*': ['*.map'] } }),
    );
    expect(wordPressErrorCode(error)).toBe('projectNotLinked');
  });
});

describe('what git ignores, on a real deploy', () => {
  it('leaves out files the project .gitignore names, until the site has them', async () => {
    const project = await createShop([THEME]);
    write(project, '.gitignore', 'vendor/\n*.map\n');
    write(project, 'wp-content/themes/shop/vendor/lib.php', '<?php // lib');
    write(project, 'wp-content/themes/shop/assets/app.js.map', '{}');
    write(project, 'wp-content/themes/shop/inc/new.php', '<?php // new');
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.changes.map((change) => change.path)).toEqual(['inc/new.php']);
    expect(plan.leftOut).toEqual(
      expect.arrayContaining([
        { item: THEME, path: 'vendor/', reason: 'ignored' },
        { item: THEME, path: 'assets/app.js.map', reason: 'ignored' },
      ]),
    );
  });
});

describe('pull', () => {
  it('downloads site changes, deletes site deletions, and moves the base', async () => {
    const project = await createShop([THEME, HELLO]);
    fake.setFile(THEME, 'style.css', 'site edit');
    fake.setFile(THEME, 'inc/added.php', '<?php // added on site');
    fake.setFile(THEME, 'inc/setup.php', null);
    fake.setFile(HELLO, 'hello.php', '<?php // hello 2');
    const plan = await service.planPull({ projectId: project.id });
    expect(plan.changes.map((change) => `${change.action}:${change.path}`).sort()).toEqual([
      'deleteLocal:inc/setup.php',
      'download:hello.php',
      'download:inc/added.php',
      'download:style.css',
    ]);
    const result = await service.pull({ planId: plan.planId, operationId: op(), force: false });
    expect(result).toMatchObject({ downloaded: 3, deletedLocal: 1, conflictCopies: [] });
    expect(local(project, 'wp-content/themes/shop/style.css')).toBe('site edit');
    expect(local(project, 'wp-content/themes/shop/inc/setup.php')).toBeNull();
    expect(local(project, 'wp-content/plugins/hello.php')).toBe('<?php // hello 2');
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
    expect((await service.planPull({ projectId: project.id })).changes).toEqual([]);
  });

  it('settles conflicts the way the user chose, keeping a copy of what it replaced', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'mine');
    write(project, 'wp-content/themes/shop/index.php', 'my index');
    fake.setFile(THEME, 'style.css', 'theirs');
    fake.setFile(THEME, 'index.php', 'their index');
    const plan = await service.planPull({ projectId: project.id });
    expect(plan.conflicts).toHaveLength(2);
    const result = await service.pull({
      planId: plan.planId,
      operationId: op(),
      force: false,
      resolutions: { 'theme:shop/style.css': 'takeRemote', 'theme:shop/index.php': 'keepLocal' },
    });
    expect(local(project, 'wp-content/themes/shop/style.css')).toBe('theirs');
    expect(local(project, 'wp-content/themes/shop/index.php')).toBe('my index');
    expect(result.conflictCopies).toHaveLength(1);
    expect(result.conflictCopies[0]).toMatch(
      /^\.runova\/wordpress\/conflicts\/[0-9T-]+Z\/wp-content\/themes\/shop\/style\.css$/,
    );
    expect(local(project, result.conflictCopies[0])).toBe('mine');

    // Keeping this computer's copy makes the next deploy send it over the site's.
    const next = await service.planDeploy({ projectId: project.id });
    expect(next.changes).toEqual([
      expect.objectContaining({
        path: 'index.php',
        action: 'upload',
        expectedRemote: sha('their index'),
      }),
    ]);
    expect(next.leftOut.some((entry) => entry.path.includes('conflicts'))).toBe(false);
  });

  it('leaves an unresolved conflict as it is', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/themes/shop/style.css', 'mine');
    fake.setFile(THEME, 'style.css', 'theirs');
    const plan = await service.planPull({ projectId: project.id });
    await service.pull({ planId: plan.planId, operationId: op(), force: false });
    expect(local(project, 'wp-content/themes/shop/style.css')).toBe('mine');
    expect((await service.planPull({ projectId: project.id })).conflicts).toHaveLength(1);
  });

  it('refuses to overwrite a file changed after the plan', async () => {
    const project = await createShop([THEME]);
    fake.setFile(THEME, 'style.css', 'theirs');
    const plan = await service.planPull({ projectId: project.id });
    write(project, 'wp-content/themes/shop/style.css', 'edited meanwhile');
    expect(
      wordPressErrorCode(
        await failure(service.pull({ planId: plan.planId, operationId: op(), force: false })),
      ),
    ).toBe('localChanged');
    expect(local(project, 'wp-content/themes/shop/style.css')).toBe('edited meanwhile');
  });

  it('refuses a site file that changed after the review, and writes nothing for it', async () => {
    const project = await createShop([THEME]);
    fake.setFile(THEME, 'style.css', 'reviewed');
    const plan = await service.planPull({ projectId: project.id });
    fake.setFile(THEME, 'style.css', 'swapped after the review');
    const error = await failure(
      service.pull({ planId: plan.planId, operationId: op(), force: false }),
    );
    expect(wordPressErrorCode(error)).toBe('conflict');
    expect(error.message).toContain(
      'wp-content/themes/shop/style.css: changed on the site since the review',
    );
    expect(local(project, 'wp-content/themes/shop/style.css')).toBe('/* Theme Name: Shop */');
  });

  it('fills in an item folder that went missing, and lists what the site left out', async () => {
    const project = await createShop([THEME]);
    rmSync(join(project.folderPath, 'wp-content'), { recursive: true });
    fake.setFile(THEME, 'notes.log', 'log');
    write(project, '.runovaignore', 'secret-dir/\n');
    fake.setFile(THEME, 'secret-dir/a.txt', 'x');
    const plan = await service.planPull({ projectId: project.id });
    expect(plan.leftOut).toContainEqual({
      item: THEME,
      path: 'secret-dir/a.txt',
      reason: 'ignored',
    });
    await service.pull({ planId: plan.planId, operationId: op(), force: false });
    expect(local(project, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(local(project, 'wp-content/themes/shop/notes.log')).toBe('log');
    expect(local(project, 'wp-content/themes/shop/secret-dir/a.txt')).toBeNull();
  });

  it('reads big site files in pieces', async () => {
    fake.limits.maxResponseBytes = 100 * 1024;
    fake.limits.maxPathsPerRead = 2;
    const big = Buffer.alloc(300 * 1024, 7);
    fake.addItem(
      { kind: 'plugin', slug: 'big' },
      { 'a.bin': big, 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' },
    );
    const project = await createShop([{ kind: 'plugin', slug: 'big' }]);
    expect(readFileSync(join(project.folderPath, 'wp-content/plugins/big/a.bin')).equals(big)).toBe(
      true,
    );
    expect(local(project, 'wp-content/plugins/big/d.txt')).toBe('d');
  });

  it('pulls nothing for an item gone from the site', async () => {
    const project = await createShop([THEME]);
    fake.items.delete('theme:shop');
    expect((await service.planPull({ projectId: project.id })).changes).toEqual([]);
    expect(local(project, 'wp-content/themes/shop/style.css')).not.toBeNull();
  });
});

describe('project items and links', () => {
  it('adds items by pulling them, and drops removed ones from the base', async () => {
    const project = await createShop([THEME]);
    const updated = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [THEME, TOOLS],
    });
    expect(updated.wordpress?.items.map(wpItemKey)).toEqual(['theme:shop', 'plugin:tools']);
    expect(local(project, 'wp-content/plugins/tools/tools.php')).toBe('<?php // tools');
    expect(Object.keys((await bases.read(project.id))?.items ?? {}).sort()).toEqual([
      'plugin:tools',
      'theme:shop',
    ]);

    const fewer = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [TOOLS],
    });
    expect(fewer.wordpress?.items.map(wpItemKey)).toEqual(['plugin:tools']);
    expect(Object.keys((await bases.read(project.id))?.items ?? {})).toEqual(['plugin:tools']);
    // The files stay on this computer.
    expect(local(project, 'wp-content/themes/shop/style.css')).not.toBeNull();

    expect(
      wordPressErrorCode(
        await failure(
          service.setProjectItems({
            operationId: op(),
            projectId: project.id,
            items: [{ kind: 'theme', slug: 'missing' }],
          }),
        ),
      ),
    ).toBe('itemUnknown');
    expect(
      wordPressErrorCode(
        await failure(
          service.setProjectItems({
            operationId: op(),
            projectId: project.id,
            items: [THEME, TOOLS],
          }),
        ),
      ),
    ).toBe('folderNotEmpty');
  });

  it('relinks to a site connected again, keeping the base only for the same site key', async () => {
    const project = await createShop([THEME]);
    const before = await bases.read(project.id);
    // Connected again from scratch: a new id for the same site.
    await service.disconnect({ siteId, revokeOnSite: false });
    const again = await service.connect({ connectionKey: fake.createKey() });
    expect(again.id).not.toBe(siteId);
    expect(wordPressErrorCode(await failure(service.planDeploy({ projectId: project.id })))).toBe(
      'siteUnknown',
    );
    const relinked = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      siteId: again.id,
      items: [THEME],
    });
    expect(relinked.wordpress?.siteId).toBe(again.id);
    const kept = await bases.read(project.id);
    expect(kept?.siteId).toBe(again.id);
    expect(kept?.items).toEqual(before?.items);
    siteId = again.id;
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
  });

  it('drops a base from a different site key on relink', async () => {
    const project = await createShop([THEME]);
    await service.disconnect({ siteId, revokeOnSite: false });
    const again = await service.connect({ connectionKey: fake.createKey() });
    const base = await bases.read(project.id);
    await bases.write(project.id, {
      ...(base as NonNullable<typeof base>),
      sitePublicKey: 'B'.repeat(43),
    });
    await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      siteId: again.id,
      items: [THEME],
    });
    expect(await bases.read(project.id)).toEqual(
      expect.objectContaining({ siteId: again.id, items: {} }),
    );
    // Without a base, every file is new on both sides but the same, so nothing travels.
    siteId = again.id;
    expect((await service.planPull({ projectId: project.id })).changes).toEqual([]);
  });

  it('drops a base from a staging clone that shares the site key', async () => {
    const project = await createShop([THEME]);
    const base = await bases.read(project.id);
    expect(base?.siteOrigin).toBe(new URL(fake.restUrl).origin);
    await service.disconnect({ siteId, revokeOnSite: false });
    const again = await service.connect({ connectionKey: fake.createKey() });
    // Same key, but written for another address: a clone, not this site.
    await bases.write(project.id, {
      ...(base as NonNullable<typeof base>),
      siteOrigin: 'https://staging.example',
    });
    await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      siteId: again.id,
      items: [THEME],
    });
    expect((await bases.read(project.id))?.items).toEqual({});
  });

  it('unlinks, and refuses projects that are not linked', async () => {
    const project = await createShop([THEME]);
    const unlinked = await service.unlinkProject(project.id);
    expect(unlinked.wordpress).toBeUndefined();
    expect(await bases.read(project.id)).toBeNull();
    for (const call of [
      service.planDeploy({ projectId: project.id }),
      service.localChanges(project.id),
      service.unlinkProject(project.id),
      service.planPull({ projectId: 'missing' }),
    ]) {
      expect(wordPressErrorCode(await failure(call))).toBe('projectNotLinked');
    }
  });

  it('refuses items the project does not link', async () => {
    const project = await createShop([THEME]);
    const error = await failure(service.planDeploy({ projectId: project.id, items: [TOOLS] }));
    expect(wordPressErrorCode(error)).toBe('badRequest');
    expect(error.message).toContain('wp-content/plugins/tools is not linked');
    const one = await service.planPull({ projectId: project.id, items: [THEME] });
    expect(one.changes).toEqual([]);
  });
});

describe('linkProject', () => {
  const link = (project: Project, items: WpItemRef[]) =>
    service.linkProject({ operationId: op(), projectId: project.id, siteId, items });

  it('pulls items into empty folders and adds the site to the prompt', async () => {
    const plain = plainProject();
    mkdirSync(join(plain.folderPath, 'wp-content', 'plugins', 'tools'), { recursive: true });
    const { project, notPulled } = await link(plain, [THEME, TOOLS]);
    expect(notPulled).toEqual([]);
    expect(local(project, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(local(project, 'wp-content/plugins/tools/tools.php')).toBe('<?php // tools');
    expect(project.wordpress?.items.map(wpItemKey)).toEqual(['theme:shop', 'plugin:tools']);
    expect(project.prompt.startsWith('Use tabs.\n\nThis project mirrors part of')).toBe(true);
    expect(project.prompt).toContain('wp-content/plugins/tools/');
    expect(project.websiteUrl).toBe(fake.siteUrl);
    expect((await service.planPull({ projectId: project.id })).changes).toEqual([]);
    expect(await service.localChanges(project.id)).toMatchObject({ added: 0, modified: 0 });
  });

  it('links a folder that already holds an item without touching it', async () => {
    const plain = plainProject({ websiteUrl: 'https://mine.example' });
    write(plain, 'wp-content/themes/shop/style.css', '/* Theme Name: Shop */');
    write(plain, 'wp-content/themes/shop/functions.php', '<?php // mine');
    const { project, notPulled } = await link(plain, [THEME]);
    expect(notPulled).toEqual([THEME]);
    expect(local(project, 'wp-content/themes/shop/functions.php')).toBe('<?php // mine');
    expect(local(project, 'wp-content/themes/shop/index.php')).toBeNull();
    expect(project.websiteUrl).toBe('https://mine.example');

    // The first pull brings in what is missing and asks about what differs.
    const plan = await service.planPull({ projectId: project.id });
    expect(plan.conflicts.map((change) => change.path)).toEqual(['functions.php']);
    expect(
      plan.changes.filter((change) => change.action === 'download').map((change) => change.path),
    ).toEqual(['inc/setup.php', 'index.php']);
  });

  it('refuses a linked project and items the site does not have', async () => {
    const linked = await createShop([THEME]);
    expect(wordPressErrorCode(await failure(link(linked, [TOOLS])))).toBe('badRequest');

    const plain = plainProject();
    const error = await failure(link(plain, [{ kind: 'plugin', slug: 'nope' }]));
    expect(wordPressErrorCode(error)).toBe('itemUnknown');
    expect(projects.get(plain.id)?.wordpress).toBeUndefined();
    expect(await bases.read(plain.id)).toBeNull();
  });

  it('takes the site out of the prompt again on unlink', async () => {
    const { project } = await link(plainProject(), [THEME]);
    const unlinked = await service.unlinkProject(project.id);
    expect(unlinked.prompt).toBe('Use tabs.');
    expect(unlinked.wordpress).toBeUndefined();
    expect(local(unlinked, 'wp-content/themes/shop/style.css')).toBe('/* Theme Name: Shop */');
  });
});

describe('moving an item between projects', () => {
  const linkedKeys = (id: string) => projects.get(id)?.wordpress?.items.map(wpItemKey);
  const baseKeys = async (id: string) => Object.keys((await bases.read(id))?.items ?? {}).sort();

  it('pulls a fresh copy into the other project and keeps the files in the first', async () => {
    const from = await createShop([THEME, TOOLS]);
    const to = await createShop([HELLO]);
    // An edit not yet deployed stays with the first project.
    write(from, 'wp-content/themes/shop/style.css', 'mine, not deployed');

    const moved = await service.setProjectItems({
      operationId: op(),
      projectId: to.id,
      items: [...(to.wordpress?.items ?? []), THEME],
    });
    expect(moved.wordpress?.items.map(wpItemKey)).toEqual(['plugin:hello.php', 'theme:shop']);
    expect(local(to, 'wp-content/themes/shop/style.css')).toBe('/* Theme Name: Shop */');
    expect(local(to, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(await baseKeys(to.id)).toEqual(['plugin:hello.php', 'theme:shop']);
    expect((await service.planPull({ projectId: to.id })).changes).toEqual([]);
    // Holding it in the second project does not change the first.
    expect(linkedKeys(from.id)).toEqual(['theme:shop', 'plugin:tools']);
    expect(await baseKeys(from.id)).toEqual(['plugin:tools', 'theme:shop']);

    const left = await service.setProjectItems({
      operationId: op(),
      projectId: from.id,
      items: [TOOLS],
    });
    expect(left.wordpress?.items.map(wpItemKey)).toEqual(['plugin:tools']);
    expect(await baseKeys(from.id)).toEqual(['plugin:tools']);
    expect(local(from, 'wp-content/themes/shop/style.css')).toBe('mine, not deployed');
    expect(local(from, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect((await service.planDeploy({ projectId: from.id })).changes).toEqual([]);
    // The second project keeps its copy and its base.
    expect(linkedKeys(to.id)).toEqual(['plugin:hello.php', 'theme:shop']);
    expect(await baseKeys(to.id)).toEqual(['plugin:hello.php', 'theme:shop']);
  });

  it('links a plain project with the item, then unlinks the first when it was its last', async () => {
    const from = await createShop([THEME]);
    const { project: to, notPulled } = await service.linkProject({
      operationId: op(),
      projectId: plainProject().id,
      siteId,
      items: [THEME],
    });
    expect(notPulled).toEqual([]);
    expect(to.wordpress?.siteId).toBe(siteId);
    expect(to.wordpress?.items.map(wpItemKey)).toEqual(['theme:shop']);
    expect(local(to, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(await baseKeys(to.id)).toEqual(['theme:shop']);

    const unlinked = await service.unlinkProject(from.id);
    expect(unlinked.wordpress).toBeUndefined();
    expect(projects.get(from.id)?.wordpress).toBeUndefined();
    expect(await bases.read(from.id)).toBeNull();
    expect(local(from, 'wp-content/themes/shop/style.css')).toBe('/* Theme Name: Shop */');
    expect(local(from, 'wp-content/themes/shop/inc/setup.php')).toBe('<?php // setup');
    expect(linkedKeys(to.id)).toEqual(['theme:shop']);
    expect((await service.planPull({ projectId: to.id })).changes).toEqual([]);
  });

  it('refuses to pull over files already at the item path, and leaves the first project alone', async () => {
    const from = await createShop([THEME, TOOLS]);
    const to = await createShop([HELLO]);
    write(to, 'wp-content/themes/shop/mine.txt', 'mine');
    const fromBase = await bases.read(from.id);

    const error = await failure(
      service.setProjectItems({
        operationId: op(),
        projectId: to.id,
        items: [...(to.wordpress?.items ?? []), THEME],
      }),
    );
    expect(wordPressErrorCode(error)).toBe('folderNotEmpty');
    expect(error.message).toContain('wp-content/themes/shop');
    expect(local(to, 'wp-content/themes/shop/mine.txt')).toBe('mine');
    expect(local(to, 'wp-content/themes/shop/style.css')).toBeNull();
    expect(linkedKeys(to.id)).toEqual(['plugin:hello.php']);
    expect(await baseKeys(to.id)).toEqual(['plugin:hello.php']);

    expect(linkedKeys(from.id)).toEqual(['theme:shop', 'plugin:tools']);
    expect(await bases.read(from.id)).toEqual(fromBase);
    expect(local(from, 'wp-content/themes/shop/style.css')).toBe('/* Theme Name: Shop */');
  });
});

describe('new themes and plugins', () => {
  const FRESH: WpItemRef = { kind: 'plugin', slug: 'fresh' };
  const SKIN: WpItemRef = { kind: 'theme', slug: 'skin' };
  const SOLO: WpItemRef = { kind: 'plugin', slug: 'solo.php' };
  const steps = (plan: { changes: { action: string; path: string }[] }) =>
    plan.changes.map((change) => `${change.action}:${change.path}`).sort();

  it('lists the theme and plugin folders in a project, and which ones it already syncs', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/plugins/fresh/fresh.php', '<?php // fresh');
    write(project, 'wp-content/plugins/solo.php', '<?php // solo');
    write(project, 'wp-content/plugins/index.php', '<?php // Silence is golden.');
    write(project, 'wp-content/themes/skin/style.css', '/* Theme Name: Skin */');
    write(project, 'wp-content/themes/index.php', '<?php // Silence is golden.');
    write(project, 'wp-content/themes/.claude-notes/x.md', 'notes');
    write(project, 'wp-content/mu-plugins/loader.php', '<?php // loader');
    mkdirSync(join(project.folderPath, 'wp-content/plugins/empty'), { recursive: true });
    expect(await service.localItems(project.id)).toEqual([
      { kind: 'theme', slug: 'shop', isFile: false, linked: true },
      { kind: 'theme', slug: 'skin', isFile: false, linked: false },
      { kind: 'plugin', slug: 'fresh', isFile: false, linked: false },
      { kind: 'plugin', slug: 'solo.php', isFile: true, linked: false },
      { kind: 'mu-plugin', slug: 'loader.php', isFile: true, linked: false },
    ]);
  });

  it('lists nothing for a project with no wp-content, and works for a project not linked', async () => {
    const plain = plainProject();
    expect(await service.localItems(plain.id)).toEqual([]);
    write(plain, 'wp-content/themes/skin/style.css', '/* Theme Name: Skin */');
    expect(await service.localItems(plain.id)).toEqual([
      { kind: 'theme', slug: 'skin', isFile: false, linked: false },
    ]);
    expect(wordPressErrorCode(await failure(service.localItems('nope')))).toBe('projectNotLinked');
  });

  it('links a plugin the site does not have without pulling, then deploys it as new', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/plugins/fresh/fresh.php', '<?php // fresh');
    write(project, 'wp-content/plugins/fresh/inc/a.php', '<?php // a');
    const updated = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [THEME, FRESH],
      newItems: [FRESH],
    });
    expect(updated.wordpress?.items.map(wpItemKey)).toEqual(['theme:shop', 'plugin:fresh']);
    expect(local(project, 'wp-content/plugins/fresh/fresh.php')).toBe('<?php // fresh');

    const plan = await service.planDeploy({ projectId: project.id, items: [FRESH] });
    expect(plan.warnings).toContain('createsItem');
    expect(steps(plan)).toEqual(['upload:fresh.php', 'upload:inc/a.php']);
    const result = await service.deploy({ planId: plan.planId, operationId: op(), force: false });
    expect(result).toMatchObject({ state: 'done', uploaded: 2 });
    expect(fake.file(FRESH, 'fresh.php')).toBe('<?php // fresh');
    expect(fake.file(FRESH, 'inc/a.php')).toBe('<?php // a');
    expect((await service.planDeploy({ projectId: project.id })).changes).toEqual([]);
  });

  it('adds new items beside items it pulls from the site, in one change', async () => {
    const project = await createShop([THEME]);
    write(project, 'wp-content/plugins/fresh/fresh.php', '<?php // fresh');
    const updated = await service.setProjectItems({
      operationId: op(),
      projectId: project.id,
      items: [THEME, TOOLS, FRESH],
      newItems: [FRESH],
    });
    expect(updated.wordpress?.items.map(wpItemKey)).toEqual([
      'theme:shop',
      'plugin:tools',
      'plugin:fresh',
    ]);
    expect(local(project, 'wp-content/plugins/tools/tools.php')).toBe('<?php // tools');
    expect(Object.keys((await bases.read(project.id))?.items ?? {}).sort()).toEqual([
      'plugin:tools',
      'theme:shop',
    ]);
  });

  it('links a project that has no site yet with a new theme and a single-file plugin', async () => {
    const plain = plainProject();
    write(plain, 'wp-content/themes/skin/style.css', '/* Theme Name: Skin */');
    write(plain, 'wp-content/plugins/solo.php', '<?php // solo');
    const { project } = await service.linkProject({
      operationId: op(),
      projectId: plain.id,
      siteId,
      items: [SKIN, SOLO],
      newItems: [SKIN, SOLO],
    });
    expect(project.wordpress?.items.map(wpItemKey)).toEqual(['theme:skin', 'plugin:solo.php']);
    const plan = await service.planDeploy({ projectId: project.id });
    expect(plan.warnings).toContain('createsItem');
    expect(steps(plan)).toEqual(['upload:solo.php', 'upload:style.css']);
    const result = await service.deploy({ planId: plan.planId, operationId: op(), force: false });
    expect(result.state).toBe('done');
    expect(fake.file(SKIN, 'style.css')).toBe('/* Theme Name: Skin */');
    expect(fake.file(SOLO, 'solo.php')).toBe('<?php // solo');
  });

  it('refuses a new item the site already has, one without files, and one not in the list', async () => {
    const project = await createShop([THEME]);
    const linked = () => projects.get(project.id)?.wordpress?.items.map(wpItemKey);
    const change = (items: WpItemRef[], newItems: WpItemRef[]) =>
      service.setProjectItems({ operationId: op(), projectId: project.id, items, newItems });

    write(project, 'wp-content/plugins/tools/tools.php', '<?php // mine');
    const known = await failure(change([THEME, TOOLS], [TOOLS]));
    expect(wordPressErrorCode(known)).toBe('badRequest');
    expect(known.message).toContain('already has wp-content/plugins/tools');

    mkdirSync(join(project.folderPath, 'wp-content/plugins/hollow'), { recursive: true });
    const hollow: WpItemRef = { kind: 'plugin', slug: 'hollow' };
    const empty = await failure(change([THEME, hollow], [hollow]));
    expect(wordPressErrorCode(empty)).toBe('badRequest');
    expect(empty.message).toContain('wp-content/plugins/hollow has no files');
    const absent = await failure(change([THEME, FRESH], [FRESH]));
    expect(absent.message).toContain('wp-content/plugins/fresh has no files');

    write(project, 'wp-content/plugins/fresh/fresh.php', '<?php // fresh');
    const outside = await failure(change([THEME], [FRESH]));
    expect(wordPressErrorCode(outside)).toBe('badRequest');
    expect(linked()).toEqual(['theme:shop']);
  });

  it('keeps the other item rules: an item the site lacks is still unknown unless it is new', async () => {
    const project = await createShop([THEME]);
    const ghost: WpItemRef = { kind: 'plugin', slug: 'ghost' };
    write(project, 'wp-content/plugins/ghost/ghost.php', '<?php // ghost');
    const error = await failure(
      service.setProjectItems({ operationId: op(), projectId: project.id, items: [THEME, ghost] }),
    );
    expect(wordPressErrorCode(error)).toBe('itemUnknown');
  });
});

describe('remoteFile', () => {
  it('gives the site copy as text, or just its facts', async () => {
    const project = await createShop([THEME]);
    expect(
      await service.remoteFile({ projectId: project.id, item: THEME, path: 'functions.php' }),
    ).toEqual({
      text: '<?php // shop',
      binary: false,
      tooLarge: false,
      sha256: sha('<?php // shop'),
    });

    fake.setFile(THEME, 'logo.png', null);
    const found = fake.items.get('theme:shop');
    found?.files.set('logo.png', Buffer.from([137, 80, 78, 71, 0, 1]));
    expect(
      await service.remoteFile({ projectId: project.id, item: THEME, path: 'logo.png' }),
    ).toMatchObject({ text: null, binary: true, tooLarge: false });
    found?.files.set('bad.txt', Buffer.from([0xff, 0xfe, 0x41]));
    expect(
      (await service.remoteFile({ projectId: project.id, item: THEME, path: 'bad.txt' })).binary,
    ).toBe(true);
    found?.files.set('huge.css', Buffer.alloc(1024 * 1024 + 1, 65));
    expect(
      await service.remoteFile({ projectId: project.id, item: THEME, path: 'huge.css' }),
    ).toMatchObject({ text: null, tooLarge: true });
    expect(
      await service.remoteFile({ projectId: project.id, item: THEME, path: 'gone.css' }),
    ).toEqual({ text: null, binary: false, tooLarge: false, sha256: null });
    expect(
      wordPressErrorCode(
        await failure(
          service.remoteFile({ projectId: project.id, item: TOOLS, path: 'tools.php' }),
        ),
      ),
    ).toBe('badRequest');
  });
});
