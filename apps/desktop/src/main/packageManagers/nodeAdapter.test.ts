import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { tempDir, writeTree } from '../../test/main/fixtures';
import type { UpdateProgressTick } from './types';

/**
 * The node adapter has to work out three things from the outside: which manager a folder uses,
 * what a given manager's `outdated` output means, and what to do when that output is missing.
 * Each manager prints something structurally different, so the parsing is where this goes wrong.
 */

interface CliCall {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

interface CliAnswer {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Set to simulate the CLI not being installed at all. */
  notFound?: boolean;
}

const cliState = vi.hoisted(() => ({
  calls: [] as CliCall[],
  answers: new Map<string, CliAnswer>(),
}));

// execUtils is this module's own process boundary. Its own tests cover the cmd.exe quoting, so
// here only the call is intercepted, which keeps the argv assertions readable.
vi.mock('./execUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execUtils')>();
  return {
    ...actual,
    runCli: async (command: string, args: string[], cwd: string, timeoutMs?: number) => {
      cliState.calls.push({ command, args, cwd, timeoutMs });
      const answer = cliState.answers.get(command) ?? {};
      if (answer.notFound) throw new actual.CliNotFoundError(`${command} is not available on PATH`);
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code ?? 0 };
    },
  };
});

const { nodeAdapter } = await import('./nodeAdapter');

/** Real `npm outdated --json --long` output, trimmed to the fields the adapter reads. */
const NPM_OUTDATED = JSON.stringify({
  'left-pad': {
    current: '1.2.0',
    wanted: '1.3.0',
    latest: '1.3.0',
    dependent: 'demo-app',
    type: 'dependencies',
  },
  vitest: {
    current: '3.0.0',
    wanted: '3.0.0',
    latest: '3.2.4',
    dependent: 'demo-app',
    type: 'devDependencies',
  },
});

/** Real `yarn outdated --json` output: NDJSON where only the "table" event carries data. */
const YARN_OUTDATED = [
  JSON.stringify({ type: 'info', data: 'Color legend : ...' }),
  JSON.stringify({
    type: 'table',
    data: {
      head: ['Package', 'Current', 'Wanted', 'Latest', 'Package Type', 'URL'],
      body: [
        ['left-pad', '1.2.0', '1.3.0', '1.3.0', 'dependencies', 'https://github.com/x'],
        ['vitest', '3.0.0', '3.0.0', '3.2.4', 'devDependencies', 'https://vitest.dev'],
      ],
    },
  }),
].join('\n');

/** Real `pnpm outdated --format json` output. */
const PNPM_OUTDATED = JSON.stringify({
  'left-pad': { current: '1.2.0', latest: '1.3.0', dependencyType: 'dependencies' },
});

const MANIFEST = JSON.stringify({
  name: 'demo-app',
  dependencies: { 'left-pad': '^1.2.0' },
  devDependencies: { vitest: '^3.0.0' },
});

let root = '';

beforeEach(() => {
  cliState.calls = [];
  cliState.answers = new Map();
  root = tempDir('runova-node-adapter-');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers every registry lookup, so no test can reach the real npm registry. */
function stubRegistry(versions: Record<string, string | null>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const name = decodeURIComponent(String(url).replace(/^.*registry\.npmjs\.org\//, '')).replace(
      /\/latest$/,
      '',
    );
    requested.push(name);
    const version = versions[name];
    if (version == null) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requested;
}

describe('detect', () => {
  it('is true when a package.json sits at the root', async () => {
    writeTree(root, { 'package.json': MANIFEST });
    await expect(nodeAdapter.detect(root)).resolves.toBe(true);
  });

  it('is true for a package.json in a nested workspace', async () => {
    writeTree(root, { 'apps/web/package.json': MANIFEST });
    await expect(nodeAdapter.detect(root)).resolves.toBe(true);
  });

  it('is false for a folder with no manifest anywhere', async () => {
    writeTree(root, { 'README.md': '# nothing here\n' });
    await expect(nodeAdapter.detect(root)).resolves.toBe(false);
  });

  it('ignores the package.json files inside node_modules', async () => {
    writeTree(root, { 'node_modules/left-pad/package.json': '{"name":"left-pad"}' });
    // Otherwise every installed dependency would be reported as a sub-project.
    await expect(nodeAdapter.detect(root)).resolves.toBe(false);
  });

  it.each(['dist', 'build', 'out', '.next', '.turbo', 'coverage', '.git'])(
    'ignores build output under %s',
    async (dir) => {
      writeTree(root, { [`${dir}/package.json`]: MANIFEST });
      await expect(nodeAdapter.detect(root)).resolves.toBe(false);
    },
  );

  it('stops descending past the depth cap', async () => {
    writeTree(root, { 'a/b/c/d/e/f/package.json': MANIFEST });
    await expect(nodeAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listPackages with npm', () => {
  beforeEach(() => {
    writeTree(root, {
      'package.json': MANIFEST,
      'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.2.0"}',
    });
    cliState.answers.set('npm', { stdout: NPM_OUTDATED, code: 1 });
    stubRegistry({});
  });

  it('runs npm outdated in long json form', async () => {
    await nodeAdapter.listPackages(root);

    expect(cliState.calls).toEqual([
      { command: 'npm', args: ['outdated', '--json', '--long'], cwd: root, timeoutMs: undefined },
    ]);
  });

  it('reports the section as npm when there is no other lockfile', async () => {
    const [section] = await nodeAdapter.listPackages(root);

    expect(section.ecosystem).toBe('node');
    expect(section.manager).toBe('npm');
    expect(section.status).toBe('ok');
    expect(section.message).toBeNull();
  });

  it('marks a dependency outdated using the CLI current and latest versions', async () => {
    const [section] = await nodeAdapter.listPackages(root);

    const leftPad = section.packages.find((p) => p.name === 'left-pad');
    expect(leftPad).toMatchObject({
      name: 'left-pad',
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      isOutdated: true,
      isDev: false,
      isInstalled: true,
      manifestPath: join(root, 'package.json'),
      projectLabel: 'demo-app',
    });
  });

  it('keeps devDependencies flagged as dev', async () => {
    const [section] = await nodeAdapter.listPackages(root);

    const vitest = section.packages.find((p) => p.name === 'vitest');
    expect(vitest?.isDev).toBe(true);
    expect(vitest?.isOutdated).toBe(true);
    // node_modules/vitest is absent, so it was never installed.
    expect(vitest?.isInstalled).toBe(false);
  });

  it('exit code 1 from npm means "found results", not a failure', async () => {
    const [section] = await nodeAdapter.listPackages(root);

    expect(section.status).toBe('ok');
    expect(section.packages).toHaveLength(2);
  });

  it('falls back to the installed version when the CLI lists nothing for a package', async () => {
    cliState.answers.set('npm', { stdout: '{}' });

    const [section] = await nodeAdapter.listPackages(root);

    const leftPad = section.packages.find((p) => p.name === 'left-pad');
    expect(leftPad?.currentVersion).toBe('1.2.0');
    // Nothing outdated came back and the CLI answered, so no registry guess is made.
    expect(leftPad?.isOutdated).toBe(false);
    expect(leftPad?.latestVersion).toBe('1.2.0');
  });

  it('falls back to the declared range when nothing is installed either', async () => {
    cliState.answers.set('npm', { stdout: '{}' });

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'vitest')?.currentVersion).toBe('^3.0.0');
  });

  it('reports cli-missing when npm is not on PATH', async () => {
    cliState.answers.set('npm', { notFound: true });

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.status).toBe('cli-missing');
    expect(section.message).toBe('Install npm to manage packages for demo-app.');
    expect(section.packages).toEqual([]);
  });

  it('returns an empty ok section for a folder with no manifest', async () => {
    const empty = tempDir('runova-node-empty-');

    const [section] = await nodeAdapter.listPackages(empty);

    expect(section).toEqual({
      ecosystem: 'node',
      manager: 'npm',
      status: 'ok',
      message: null,
      packages: [],
    });
    expect(cliState.calls).toEqual([]);
  });

  it('reports an error when package.json cannot be parsed', async () => {
    writeTree(root, { 'package.json': '{ this is not json' });

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.status).toBe('error');
    expect(section.message).toContain('Failed to read');
  });
});

describe('listPackages with pnpm and yarn', () => {
  it('uses the pnpm json format when a pnpm lockfile is present', async () => {
    writeTree(root, { 'package.json': MANIFEST, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' });
    cliState.answers.set('pnpm', { stdout: PNPM_OUTDATED, code: 1 });
    stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(cliState.calls[0]).toMatchObject({
      command: 'pnpm',
      args: ['outdated', '--format', 'json'],
    });
    expect(section.manager).toBe('pnpm');
    expect(section.packages.find((p) => p.name === 'left-pad')).toMatchObject({
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      isOutdated: true,
    });
  });

  it('reads the table event out of yarn classic NDJSON', async () => {
    writeTree(root, { 'package.json': MANIFEST, 'yarn.lock': '# yarn lockfile v1\n' });
    cliState.answers.set('yarn', { stdout: YARN_OUTDATED, code: 1 });
    stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(cliState.calls[0]).toMatchObject({ command: 'yarn', args: ['outdated', '--json'] });
    expect(section.manager).toBe('yarn');
    // Column positions come from the head row, not a fixed index.
    expect(section.packages.find((p) => p.name === 'vitest')).toMatchObject({
      currentVersion: '3.0.0',
      latestVersion: '3.2.4',
      isOutdated: true,
    });
  });

  it('prefers pnpm over yarn when both lockfiles exist', async () => {
    writeTree(root, {
      'package.json': MANIFEST,
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
    });
    cliState.answers.set('pnpm', { stdout: '{}' });
    stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.manager).toBe('pnpm');
  });
});

/** Real `bun outdated` output from bun 1.4. It has no JSON mode and lists only outdated rows. */
const BUN_OUTDATED = [
  'bun outdated v1.4.3 (c6da4a4d3)',
  '|----------------------------------------------|',
  '| Package          | Current | Update | Latest |',
  '|------------------|---------|--------|--------|',
  '| left-pad         | 1.2.0   | 1.3.0  | 1.3.0  |',
  '|------------------|---------|--------|--------|',
  '| vitest (dev)     | 3.0.0   | 3.0.0  | 3.2.4  |',
  '|----------------------------------------------|',
].join('\n');

describe('listPackages with bun', () => {
  it('reads the bun outdated table when a bun lockfile is present', async () => {
    writeTree(root, { 'package.json': MANIFEST, 'bun.lock': '{}' });
    cliState.answers.set('bun', { stdout: BUN_OUTDATED });
    const requested = stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(cliState.calls[0]).toMatchObject({
      command: 'bun',
      args: ['outdated', '--no-progress'],
    });
    expect(section.manager).toBe('bun');
    // The "(dev)" suffix is bun's decoration, not part of the name.
    expect(section.packages.find((p) => p.name === 'vitest')).toMatchObject({
      currentVersion: '3.0.0',
      latestVersion: '3.2.4',
      isOutdated: true,
    });
    expect(requested).toEqual([]);
  });

  it('treats a clean run without a table as everything up to date', async () => {
    writeTree(root, {
      'package.json': MANIFEST,
      'bun.lockb': '',
      'node_modules/left-pad/package.json': '{"version":"1.3.0"}',
    });
    cliState.answers.set('bun', { stdout: 'bun outdated v1.4.3 (c6da4a4d3)\n' });
    const requested = stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'left-pad')).toMatchObject({
      currentVersion: '1.3.0',
      latestVersion: '1.3.0',
      isOutdated: false,
    });
    expect(requested).toEqual([]);
  });

  it('falls back to the registry when bun fails before printing a table', async () => {
    writeTree(root, { 'package.json': MANIFEST, 'bun.lock': '{}' });
    cliState.answers.set('bun', {
      stdout: 'bun outdated v1.4.3 (c6da4a4d3)\n',
      stderr: 'error: missing lockfile, nothing outdated',
      code: 1,
    });
    const requested = stubRegistry({ 'left-pad': '1.3.0', vitest: '3.2.4' });

    await nodeAdapter.listPackages(root);

    expect(requested.sort()).toEqual(['left-pad', 'vitest']);
  });

  it('reads the older box-drawn table', async () => {
    writeTree(root, { 'package.json': MANIFEST, 'bun.lock': '{}' });
    cliState.answers.set('bun', {
      stdout: [
        'bun outdated v1.1.30 (7996d06b)',
        '┌──────────┬─────────┬────────┬────────┐',
        '│ Package  │ Current │ Update │ Latest │',
        '├──────────┼─────────┼────────┼────────┤',
        '│ left-pad │ 1.2.0   │ 1.3.0  │ 1.3.0  │',
        '└──────────┴─────────┴────────┴────────┘',
      ].join('\n'),
    });
    stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'left-pad')).toMatchObject({
      latestVersion: '1.3.0',
      isOutdated: true,
    });
  });

  it('uses the workspace root lockfile for a member package', async () => {
    writeTree(root, {
      'package.json': JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }),
      'bun.lock': '{}',
      'packages/app/package.json': JSON.stringify({
        name: '@demo/app',
        dependencies: { '@demo/lib': 'workspace:*', 'left-pad': '^1.2.0' },
      }),
      // Hoisted to the root, the member has no node_modules of its own.
      'node_modules/left-pad/package.json': '{"version":"1.2.0"}',
    });
    cliState.answers.set('bun', { code: 1 });
    const requested = stubRegistry({ 'left-pad': '1.3.0', '@demo/lib': '9.9.9' });

    const [section] = await nodeAdapter.listPackages(root);

    expect(cliState.calls.map((call) => call.command)).toEqual(['bun', 'bun']);
    expect(section.packages.find((p) => p.name === 'left-pad')).toMatchObject({
      currentVersion: '1.2.0',
      isInstalled: true,
    });
    // A workspace sibling is never looked up on the public registry.
    expect(requested).toEqual(['left-pad']);
  });
});

describe('registry fallback', () => {
  beforeEach(() => {
    writeTree(root, {
      'package.json': MANIFEST,
      'yarn.lock': '',
      'node_modules/left-pad/package.json': '{"version":"1.2.0"}',
    });
  });

  it('asks the npm registry when yarn berry prints no table event', async () => {
    // Yarn berry's `outdated` is a plugin; without it the NDJSON never has a table line.
    cliState.answers.set('yarn', { stdout: JSON.stringify({ type: 'info', data: 'nope' }) });
    const requested = stubRegistry({ 'left-pad': '1.3.0', vitest: '3.2.4' });

    const [section] = await nodeAdapter.listPackages(root);

    expect(requested.sort()).toEqual(['left-pad', 'vitest']);
    expect(section.packages.find((p) => p.name === 'left-pad')).toMatchObject({
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      isOutdated: true,
    });
  });

  it('leaves latestVersion null when the registry lookup fails', async () => {
    cliState.answers.set('yarn', { stdout: 'not json at all' });
    stubRegistry({});

    const [section] = await nodeAdapter.listPackages(root);

    const leftPad = section.packages.find((p) => p.name === 'left-pad');
    // A failed lookup currently reads back as the current version rather than null, so the row
    // shows as up to date. See the note in the report about PackageInfo.latestVersion.
    expect(leftPad?.latestVersion).toBe('1.2.0');
    expect(leftPad?.isOutdated).toBe(false);
  });

  it('does not reach the registry when the CLI answered', async () => {
    cliState.answers.set('yarn', { stdout: YARN_OUTDATED });
    const requested = stubRegistry({ 'left-pad': '9.9.9' });

    await nodeAdapter.listPackages(root);

    expect(requested).toEqual([]);
  });
});

describe('multiple sub-projects', () => {
  beforeEach(() => {
    writeTree(root, {
      'package.json': JSON.stringify({ name: 'monorepo', dependencies: {} }),
      'apps/web/package.json': JSON.stringify({ dependencies: { 'left-pad': '^1.2.0' } }),
      'packages/core/package.json': JSON.stringify({
        name: '@demo/core',
        dependencies: { vitest: '^3.0.0' },
      }),
    });
    stubRegistry({});
  });

  it('labels a sub-project by its package name, or its folder when it has none', async () => {
    cliState.answers.set('npm', { stdout: '{}' });

    const [section] = await nodeAdapter.listPackages(root);

    const labels = new Set(section.packages.map((p) => p.projectLabel));
    // apps/web has no "name", so it falls back to its path relative to the scanned folder.
    expect(labels).toEqual(new Set([join('apps', 'web'), '@demo/core']));
  });

  it('scans each manifest in its own folder', async () => {
    cliState.answers.set('npm', { stdout: '{}' });

    await nodeAdapter.listPackages(root);

    expect(new Set(cliState.calls.map((call) => call.cwd))).toEqual(
      new Set([root, join(root, 'apps', 'web'), join(root, 'packages', 'core')]),
    );
  });

  it('keeps the packages it could read and notes how many sub-projects failed', async () => {
    writeTree(root, { 'apps/web/package.json': 'broken {' });
    cliState.answers.set('npm', { stdout: '{}' });

    const [section] = await nodeAdapter.listPackages(root);

    expect(section.status).toBe('ok');
    expect(section.message).toBe('1 of 3 sub-projects failed to scan.');
    expect(section.packages.map((p) => p.name)).toEqual(['vitest']);
  });

  it('prefers the cli-missing outcome when nothing could be listed at all', async () => {
    cliState.answers.set('npm', { notFound: true });

    const [section] = await nodeAdapter.listPackages(root);

    // cli-missing is actionable ("install npm"), a generic error is not.
    expect(section.status).toBe('cli-missing');
  });
});

describe('one section per package manager', () => {
  beforeEach(() => {
    stubRegistry({});
  });

  it('names the manager of the sub-projects when the root has no lockfile', async () => {
    // BitIronPlatform's shape: no root manifest or lockfile, the web app lives in web/ on bun.
    writeTree(root, {
      'web/package.json': JSON.stringify({ name: 'web', dependencies: { 'left-pad': '^1.2.0' } }),
      'web/bun.lock': '{}',
      'app/pubspec.yaml': 'name: app',
    });

    const sections = await nodeAdapter.listPackages(root);

    expect(sections.map((s) => s.manager)).toEqual(['bun']);
    expect(cliState.calls.map((call) => call.command)).toEqual(['bun']);
  });

  it('splits sub-projects on different managers into their own sections', async () => {
    writeTree(root, {
      'web/package.json': JSON.stringify({ name: 'web', dependencies: { 'left-pad': '^1.2.0' } }),
      'web/bun.lock': '{}',
      'docs/package.json': JSON.stringify({ name: 'docs', devDependencies: { vitest: '^3.0.0' } }),
      'docs/package-lock.json': '{}',
    });
    cliState.answers.set('npm', { stdout: '{}' });

    const sections = await nodeAdapter.listPackages(root);

    const byManager = new Map(sections.map((s) => [s.manager, s]));
    expect([...byManager.keys()].sort()).toEqual(['bun', 'npm']);
    expect(byManager.get('bun')?.packages.map((p) => p.name)).toEqual(['left-pad']);
    expect(byManager.get('npm')?.packages.map((p) => p.name)).toEqual(['vitest']);
  });

  it('marks only the section whose manager is missing', async () => {
    writeTree(root, {
      'web/package.json': JSON.stringify({ name: 'web', dependencies: { 'left-pad': '^1.2.0' } }),
      'web/bun.lock': '{}',
      'docs/package.json': JSON.stringify({ name: 'docs', devDependencies: { vitest: '^3.0.0' } }),
    });
    cliState.answers.set('bun', { notFound: true });
    cliState.answers.set('npm', { stdout: '{}' });

    const sections = await nodeAdapter.listPackages(root);

    const byManager = new Map(sections.map((s) => [s.manager, s]));
    expect(byManager.get('bun')).toMatchObject({ status: 'cli-missing', packages: [] });
    expect(byManager.get('npm')).toMatchObject({ status: 'ok', message: null });
  });
});

describe('updatePackages', () => {
  function request(overrides: Partial<PackageUpdateRequest>): PackageUpdateRequest {
    return {
      ecosystem: 'node',
      name: 'left-pad',
      targetVersion: '1.3.0',
      manifestPath: join(root, 'package.json'),
      ...overrides,
    };
  }

  it('does nothing for an empty batch', async () => {
    const ticks: UpdateProgressTick[] = [];

    await expect(nodeAdapter.updatePackages(root, [], (t) => ticks.push(t))).resolves.toEqual({
      ok: true,
      results: [],
    });
    expect(cliState.calls).toEqual([]);
    expect(ticks).toEqual([]);
  });

  it('installs every package of one folder in a single npm call', async () => {
    writeTree(root, { 'package.json': MANIFEST });

    await nodeAdapter.updatePackages(
      root,
      [request({}), request({ name: 'vitest', targetVersion: '3.2.4' })],
      () => undefined,
    );

    // One resolution pass for the batch instead of one per package.
    expect(cliState.calls).toEqual([
      {
        command: 'npm',
        args: ['install', 'left-pad@1.3.0', 'vitest@3.2.4'],
        cwd: root,
        timeoutMs: 5 * 60 * 1000,
      },
    ]);
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'update'],
    ['yarn.lock', 'yarn', 'upgrade'],
    ['bun.lock', 'bun', 'add'],
  ])('uses the %s manager verb', async (lockfile, command, verb) => {
    writeTree(root, { 'package.json': MANIFEST, [lockfile]: '' });

    await nodeAdapter.updatePackages(root, [request({})], () => undefined);

    expect(cliState.calls[0]).toMatchObject({ command, args: [verb, 'left-pad@1.3.0'] });
  });

  it('updates a workspace member with the manager of the root lockfile', async () => {
    writeTree(root, {
      'package.json': MANIFEST,
      'bun.lock': '{}',
      'packages/app/package.json': MANIFEST,
    });

    await nodeAdapter.updatePackages(
      root,
      [request({ manifestPath: join(root, 'packages', 'app', 'package.json') })],
      () => undefined,
    );

    expect(cliState.calls[0]).toMatchObject({
      command: 'bun',
      args: ['add', 'left-pad@1.3.0'],
      cwd: join(root, 'packages', 'app'),
    });
  });

  it('groups by manifest folder so each sub-project gets its own manager', async () => {
    writeTree(root, {
      'package.json': MANIFEST,
      'apps/web/package.json': MANIFEST,
      'apps/web/yarn.lock': '',
    });

    await nodeAdapter.updatePackages(
      root,
      [request({}), request({ manifestPath: join(root, 'apps', 'web', 'package.json') })],
      () => undefined,
    );

    expect(cliState.calls.map((call) => call.command)).toEqual(['npm', 'yarn']);
  });

  it('announces every package as running before any install starts', async () => {
    writeTree(root, { 'package.json': MANIFEST });
    const ticks: UpdateProgressTick[] = [];

    await nodeAdapter.updatePackages(root, [request({}), request({ name: 'vitest' })], (tick) =>
      ticks.push(tick),
    );

    expect(ticks.slice(0, 2)).toEqual([
      { packageName: 'left-pad', status: 'running', completed: 0, total: 2 },
      { packageName: 'vitest', status: 'running', completed: 0, total: 2 },
    ]);
    expect(ticks.slice(2)).toEqual([
      { packageName: 'left-pad', status: 'done', message: undefined, completed: 2, total: 2 },
      { packageName: 'vitest', status: 'done', message: undefined, completed: 2, total: 2 },
    ]);
  });

  it('reports the tail of stderr when the install fails', async () => {
    writeTree(root, { 'package.json': MANIFEST });
    cliState.answers.set('npm', { code: 1, stderr: 'npm ERR! ERESOLVE unable to resolve tree' });
    const ticks: UpdateProgressTick[] = [];

    const result = await nodeAdapter.updatePackages(root, [request({})], (t) => ticks.push(t));

    expect(result.ok).toBe(false);
    expect(result.results).toEqual([
      { name: 'left-pad', ok: false, message: 'npm ERR! ERESOLVE unable to resolve tree' },
    ]);
    expect(ticks.at(-1)?.status).toBe('error');
  });

  it('falls back to a generic message when the failing CLI printed nothing', async () => {
    writeTree(root, { 'package.json': MANIFEST });
    cliState.answers.set('npm', { code: 7 });

    const result = await nodeAdapter.updatePackages(root, [request({})], () => undefined);

    expect(result.results[0].message).toBe('npm exited with code 7');
  });

  it('marks the whole batch failed when one group fails', async () => {
    writeTree(root, {
      'package.json': MANIFEST,
      'apps/web/package.json': MANIFEST,
      'apps/web/yarn.lock': '',
    });
    cliState.answers.set('yarn', { code: 1, stderr: 'boom' });

    const result = await nodeAdapter.updatePackages(
      root,
      [request({}), request({ manifestPath: join(root, 'apps', 'web', 'package.json') })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results.map((r) => r.ok)).toEqual([true, false]);
  });
});
