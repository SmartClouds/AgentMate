import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { tempDir, writeTree } from '../../test/main/fixtures';
import type { UpdateProgressTick } from './types';

/**
 * `dotnet list package` needs a successful restore and quietly reports nothing without one, so
 * the .csproj is the source of truth for which packages exist and the CLI only enriches it. The
 * cases worth pinning are the ones where those two disagree.
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
  notFound?: boolean;
}

const cliState = vi.hoisted(() => ({
  calls: [] as CliCall[],
  handler: (_command: string, _args: string[]): CliAnswer => ({}),
}));

// execUtils is this module's own process boundary; its own tests cover the cmd.exe quoting.
vi.mock('./execUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execUtils')>();
  return {
    ...actual,
    runCli: async (command: string, args: string[], cwd: string, timeoutMs?: number) => {
      cliState.calls.push({ command, args, cwd, timeoutMs });
      const answer = cliState.handler(command, args);
      if (answer.notFound) throw new actual.CliNotFoundError(`${command} is not available on PATH`);
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code ?? 0 };
    },
  };
});

const { dotnetAdapter } = await import('./dotnetAdapter');

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog">
      <Version>3.1.1</Version>
    </PackageReference>
  </ItemGroup>
</Project>
`;

/** Real `dotnet list package --format json` output. */
function listJson(packages: { id: string; resolvedVersion: string }[]): string {
  return JSON.stringify({
    version: 1,
    parameters: '--format json',
    projects: [
      {
        path: 'App.csproj',
        frameworks: [
          {
            framework: 'net8.0',
            topLevelPackages: packages.map((p) => ({
              id: p.id,
              requestedVersion: p.resolvedVersion,
              resolvedVersion: p.resolvedVersion,
            })),
          },
        ],
      },
    ],
  });
}

/** Real `dotnet list package --outdated --format json` output. */
function outdatedJson(packages: { id: string; resolved: string; latest: string }[]): string {
  return JSON.stringify({
    version: 1,
    parameters: '--outdated --format json',
    projects: [
      {
        path: 'App.csproj',
        frameworks: [
          {
            framework: 'net8.0',
            topLevelPackages: packages.map((p) => ({
              id: p.id,
              requestedVersion: p.resolved,
              resolvedVersion: p.resolved,
              latestVersion: p.latest,
            })),
          },
        ],
      },
    ],
  });
}

/** What the CLI prints when the project cannot be restored. */
const RESTORE_PROBLEM = JSON.stringify({
  version: 1,
  problems: [{ project: 'App.csproj', level: 'error', text: 'No assets file was found.' }],
});

let root = '';

beforeEach(() => {
  cliState.calls = [];
  cliState.handler = () => ({});
  root = tempDir('runova-dotnet-adapter-');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers nuget.org, so no test can reach the real feed. */
function stubNuget(versions: Record<string, string[]>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const name = /v3-flatcontainer\/([^/]+)\/index\.json/.exec(String(url))?.[1] ?? '';
    requested.push(name);
    const list = versions[name];
    if (!list) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ versions: list }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requested;
}

/** Answers both `dotnet list package` calls of a single project. */
function answerCli(installed: string | null, outdated: string | null): void {
  cliState.handler = (_command, args) =>
    args.includes('--outdated') ? { stdout: outdated ?? '' } : { stdout: installed ?? '' };
}

describe('detect', () => {
  it.each(['App.csproj', 'Lib.vbproj', 'Core.fsproj', 'Mixed.CSPROJ'])(
    'is true for %s',
    async (file) => {
      writeTree(root, { [file]: CSPROJ });
      await expect(dotnetAdapter.detect(root)).resolves.toBe(true);
    },
  );

  it('finds a project nested a few folders down', async () => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(true);
  });

  it('is false for a folder with no project file', async () => {
    writeTree(root, { 'App.sln': 'Microsoft Visual Studio Solution File\n' });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
  });

  it.each(['bin', 'obj', 'packages', 'TestResults', 'node_modules', '.git'])(
    'ignores build output under %s',
    async (dir) => {
      writeTree(root, { [`${dir}/App.csproj`]: CSPROJ });
      // obj holds generated copies of the project file that would otherwise be scanned twice.
      await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
    },
  );

  it('stops descending past the depth cap', async () => {
    writeTree(root, { 'a/b/c/d/e/f/App.csproj': CSPROJ });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listPackages CLI usage', () => {
  beforeEach(() => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    stubNuget({});
  });

  it('runs the plain and outdated listings against the project file', async () => {
    answerCli(listJson([{ id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' }]), outdatedJson([]));
    const project = join(root, 'src', 'App', 'App.csproj');

    await dotnetAdapter.listPackages(root);

    expect(cliState.calls).toEqual([
      {
        command: 'dotnet',
        args: ['list', project, 'package', '--format', 'json'],
        cwd: join(root, 'src', 'App'),
        timeoutMs: 3 * 60 * 1000,
      },
      {
        command: 'dotnet',
        args: ['list', project, 'package', '--outdated', '--format', 'json'],
        cwd: join(root, 'src', 'App'),
        timeoutMs: 3 * 60 * 1000,
      },
    ]);
  });

  it('reports cli-missing when the .NET SDK is not installed', async () => {
    cliState.handler = () => ({ notFound: true });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section).toEqual({
      ecosystem: 'dotnet',
      manager: 'nuget',
      status: 'cli-missing',
      message: 'Install the .NET SDK to manage NuGet packages for this project.',
      packages: [],
    });
  });

  it('returns an empty ok section when there is no project to scan', async () => {
    const empty = tempDir('runova-dotnet-empty-');

    const [section] = await dotnetAdapter.listPackages(empty);

    expect(section).toEqual({
      ecosystem: 'dotnet',
      manager: 'nuget',
      status: 'ok',
      message: null,
      packages: [],
    });
    expect(cliState.calls).toEqual([]);
  });
});

describe('manifest parsing', () => {
  beforeEach(() => stubNuget({}));

  it('reads both the Version attribute and the nested Version element', async () => {
    writeTree(root, { 'App.csproj': CSPROJ });
    answerCli(
      listJson([
        { id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' },
        { id: 'Serilog', resolvedVersion: '3.1.1' },
      ]),
      outdatedJson([]),
    );

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
    expect(section.packages.map((p) => p.currentVersion)).toEqual(['13.0.1', '3.1.1']);
  });

  it('ignores a PackageReference that is commented out', async () => {
    writeTree(root, {
      'App.csproj': `<Project>
  <ItemGroup>
    <PackageReference Include="Live" Version="1.0.0" />
    <!-- <PackageReference Include="Removed" Version="0.9.0" /> -->
  </ItemGroup>
</Project>`,
    });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    // A commented-out reference is not a dependency and must not be offered for update.
    expect(section.packages.map((p) => p.name)).toEqual(['Live']);
  });

  it('reads the Update form used to pin a version coming from a props import', async () => {
    writeTree(root, {
      'App.csproj': `<Project><ItemGroup>
        <PackageReference Update="Microsoft.SourceLink.GitHub" Version="8.0.0" />
      </ItemGroup></Project>`,
    });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({
      name: 'Microsoft.SourceLink.GitHub',
      currentVersion: '8.0.0',
    });
  });

  it('reads legacy packages.config alongside the project file', async () => {
    writeTree(root, {
      'App.csproj': '<Project><ItemGroup></ItemGroup></Project>',
      'packages.config': `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="EntityFramework" version="6.4.4" targetFramework="net48" />
  <package id="NUnit" version="3.13.3" targetFramework="net48" />
</packages>`,
    });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    // Non-SDK-style projects keep their packages here, not in the .csproj.
    expect(section.packages.map((p) => p.name)).toEqual(['EntityFramework', 'NUnit']);
    expect(section.packages[0].currentVersion).toBe('6.4.4');
  });

  it('resolves a Central Package Management version from the nearest props file', async () => {
    writeTree(root, {
      'Directory.Packages.props': `<Project>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
      'src/App/App.csproj': `<Project><ItemGroup>
        <PackageReference Include="Newtonsoft.Json" />
      </ItemGroup></Project>`,
    });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    // Under CPM the .csproj carries no version, so the walk up the tree is the only source.
    expect(section.packages[0]).toMatchObject({
      name: 'Newtonsoft.Json',
      currentVersion: '13.0.3',
    });
  });

  it('prefers the props file closest to the project', async () => {
    writeTree(root, {
      'Directory.Packages.props':
        '<Project><ItemGroup><PackageVersion Include="Serilog" Version="1.0.0" /></ItemGroup></Project>',
      'src/Directory.Packages.props':
        '<Project><ItemGroup><PackageVersion Include="Serilog" Version="4.0.0" /></ItemGroup></Project>',
      'src/App.csproj':
        '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>',
    });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('4.0.0');
  });

  it('falls back to unknown when no version can be found anywhere', async () => {
    writeTree(root, {
      'App.csproj':
        '<Project><ItemGroup><PackageReference Include="Mystery" /></ItemGroup></Project>',
    });
    answerCli('', '');
    stubNuget({ mystery: ['1.0.0'] });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('unknown');
    // An unknown current version can never be compared, so it is never flagged outdated.
    expect(section.packages[0].isOutdated).toBe(false);
  });
});

describe('merging CLI output with the manifest', () => {
  beforeEach(() => {
    writeTree(root, { 'App.csproj': CSPROJ });
  });

  it('marks a package outdated from the outdated listing', async () => {
    stubNuget({});
    answerCli(
      listJson([
        { id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' },
        { id: 'Serilog', resolvedVersion: '3.1.1' },
      ]),
      outdatedJson([{ id: 'Newtonsoft.Json', resolved: '13.0.1', latest: '13.0.3' }]),
    );

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')).toMatchObject({
      currentVersion: '13.0.1',
      latestVersion: '13.0.3',
      isOutdated: true,
      isInstalled: true,
      projectLabel: 'App',
      manifestPath: join(root, 'App.csproj'),
    });
  });

  it('treats a package missing from the outdated listing as up to date', async () => {
    stubNuget({});
    answerCli(listJson([{ id: 'Serilog', resolvedVersion: '3.1.1' }]), outdatedJson([]));

    const [section] = await dotnetAdapter.listPackages(root);

    const serilog = section.packages.find((p) => p.name === 'Serilog');
    expect(serilog?.isOutdated).toBe(false);
    expect(serilog?.latestVersion).toBe('3.1.1');
  });

  it('includes a package the CLI found but the manifest does not declare', async () => {
    stubNuget({});
    answerCli(
      listJson([
        { id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' },
        { id: 'Serilog', resolvedVersion: '3.1.1' },
        { id: 'Microsoft.Extensions.Logging', resolvedVersion: '8.0.0' },
      ]),
      outdatedJson([]),
    );

    const [section] = await dotnetAdapter.listPackages(root);

    // A package can come in through an imported .props file the parser never sees.
    expect(section.packages.map((p) => p.name)).toContain('Microsoft.Extensions.Logging');
  });

  it('sorts packages by name so the list does not reshuffle between scans', async () => {
    stubNuget({});
    answerCli(
      listJson([
        { id: 'Serilog', resolvedVersion: '3.1.1' },
        { id: 'AWSSDK.Core', resolvedVersion: '3.7.0' },
        { id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' },
      ]),
      outdatedJson([]),
    );

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual([
      'AWSSDK.Core',
      'Newtonsoft.Json',
      'Serilog',
    ]);
  });

  it('asks nuget.org only for packages the CLI never resolved', async () => {
    const requested = stubNuget({ serilog: ['3.1.1', '4.0.0', '4.1.0-dev.1'] });
    answerCli(listJson([{ id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' }]), outdatedJson([]));

    const [section] = await dotnetAdapter.listPackages(root);

    // Newtonsoft.Json resolved, so its absence from the outdated list really means up to date.
    expect(requested).toEqual(['serilog']);
    expect(section.packages.find((p) => p.name === 'Serilog')).toMatchObject({
      currentVersion: '3.1.1',
      latestVersion: '4.0.0',
      isOutdated: true,
      isInstalled: false,
    });
  });

  it('picks the newest stable version from the nuget index, not a prerelease', async () => {
    stubNuget({ 'newtonsoft.json': ['12.0.3', '13.0.3', '14.0.0-beta1'] });
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    // The flat container index is sorted ascending, so the last stable entry is the latest.
    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')?.latestVersion).toBe(
      '13.0.3',
    );
  });

  it('leaves a package alone when nuget.org has never heard of it', async () => {
    stubNuget({});
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    // A 404 means a private feed package, which is not an error worth showing.
    expect(section.packages.every((p) => p.isOutdated === false)).toBe(true);
  });
});

describe('degraded projects', () => {
  it('warns that versions came from the project file when restore failed', async () => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    stubNuget({});
    answerCli(RESTORE_PROBLEM, RESTORE_PROBLEM);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.status).toBe('ok');
    expect(section.message).toContain('Could not restore App');
    expect(section.message).toContain('may not reflect what is resolved at build time');
    // The packages still come through, just from the manifest alone.
    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
    expect(section.packages.every((p) => p.isInstalled === false)).toBe(true);
  });

  it('names every project that could not be restored', async () => {
    writeTree(root, { 'a/A.csproj': CSPROJ, 'b/B.csproj': CSPROJ });
    stubNuget({});
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toContain('A, B');
    expect(section.message).toContain('those are');
  });

  it('says nothing when every project restored', async () => {
    writeTree(root, { 'App.csproj': CSPROJ });
    stubNuget({});
    answerCli(
      listJson([
        { id: 'Newtonsoft.Json', resolvedVersion: '13.0.1' },
        { id: 'Serilog', resolvedVersion: '3.1.1' },
      ]),
      outdatedJson([]),
    );

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toBeNull();
  });

  it('does not call a project with no packages at all degraded', async () => {
    writeTree(root, { 'Empty.csproj': '<Project><ItemGroup /></Project>' });
    stubNuget({});
    answerCli('', '');

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toBeNull();
    expect(section.packages).toEqual([]);
  });
});

describe('updatePackages', () => {
  function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
    return {
      ecosystem: 'dotnet',
      name: 'Newtonsoft.Json',
      targetVersion: '13.0.3',
      manifestPath: join(root, 'src', 'App', 'App.csproj'),
      ...overrides,
    };
  }

  it('runs dotnet add package with an explicit version, from the project folder', async () => {
    await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(cliState.calls).toEqual([
      {
        command: 'dotnet',
        args: [
          'add',
          join(root, 'src', 'App', 'App.csproj'),
          'package',
          'Newtonsoft.Json',
          '--version',
          '13.0.3',
        ],
        cwd: join(root, 'src', 'App'),
        timeoutMs: 2 * 60 * 1000,
      },
    ]);
  });

  it('runs one package at a time so parallel restores cannot race on the nuget cache', async () => {
    let concurrent = 0;
    let peak = 0;
    cliState.handler = () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      concurrent--;
      return {};
    };

    await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog', targetVersion: '4.0.0' })],
      () => undefined,
    );

    expect(peak).toBe(1);
    expect(cliState.calls).toHaveLength(2);
  });

  it('reports progress around each package', async () => {
    const ticks: UpdateProgressTick[] = [];

    const result = await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog' })],
      (tick) => ticks.push(tick),
    );

    expect(result).toEqual({
      ok: true,
      results: [
        { name: 'Newtonsoft.Json', ok: true, message: 'Updated' },
        { name: 'Serilog', ok: true, message: 'Updated' },
      ],
    });
    expect(ticks).toEqual([
      { packageName: 'Newtonsoft.Json', status: 'running', completed: 0, total: 2 },
      {
        packageName: 'Newtonsoft.Json',
        status: 'done',
        message: undefined,
        completed: 1,
        total: 2,
      },
      { packageName: 'Serilog', status: 'running', completed: 1, total: 2 },
      { packageName: 'Serilog', status: 'done', message: undefined, completed: 2, total: 2 },
    ]);
  });

  it('surfaces the tail of the CLI output when an update fails', async () => {
    cliState.handler = () => ({
      code: 1,
      stderr: 'error NU1102: Unable to find package Newtonsoft.Json with version (>= 99.0.0)',
    });

    const result = await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('NU1102');
  });

  it('falls back to a generic message when the failing CLI printed nothing', async () => {
    cliState.handler = () => ({ code: 3 });

    const result = await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.results[0].message).toBe('dotnet exited with code 3');
  });

  it('keeps going after one package fails', async () => {
    let call = 0;
    cliState.handler = () => {
      call++;
      return call === 1 ? { code: 1, stderr: 'nope' } : {};
    };

    const result = await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog' })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results.map((r) => r.ok)).toEqual([false, true]);
  });

  it('handles an empty batch', async () => {
    await expect(dotnetAdapter.updatePackages(root, [], () => undefined)).resolves.toEqual({
      ok: true,
      results: [],
    });
  });
});
