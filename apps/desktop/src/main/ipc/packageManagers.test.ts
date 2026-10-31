import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { expectChannelsCovered, invoke, loadIpc } from '../../test/main/ipcHarness';

/**
 * Everything the Packages tab sends ends up as a file write or a CLI argument in the project's
 * folder, so main checks it against what the list could have produced before any adapter sees it.
 */

const ROOT = join('C:', 'work', 'shop');

const state = vi.hoisted(() => ({
  scan: vi.fn(),
  nodeUpdate: vi.fn(),
  dartRuntime: vi.fn(),
  nodeRuntime: vi.fn(),
  detect: vi.fn(),
}));

vi.mock('../worktrees/resolve', () => ({
  findProjectScope: async (id: string) => (id === 'p1' ? { id, folderPath: ROOT } : null),
}));

vi.mock('../packageManagers', () => ({
  scanProjectPackages: state.scan,
  PACKAGE_MANAGER_ADAPTERS: [
    { ecosystem: 'node', updatePackages: state.nodeUpdate, updateRuntime: state.nodeRuntime },
    { ecosystem: 'dart', updatePackages: vi.fn(), updateRuntime: state.dartRuntime },
  ],
}));

// The real runtime probes the machine and reads the settings store.
vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({ detect: state.detect }),
}));

expectChannelsCovered(IPC.packages, [IPC.packages.onUpdateProgress]);

beforeEach(async () => {
  for (const fn of Object.values(state)) fn.mockReset();
  await loadIpc(
    () => import('./packageManagers'),
    (module) => module.registerPackageManagerHandlers(),
  );
});

function runtimeRequest(overrides: Partial<RuntimeUpdateRequest> = {}): RuntimeUpdateRequest {
  return {
    ecosystem: 'dart',
    source: 'pubspec-sdk',
    kind: 'dart',
    manifestPath: join(ROOT, 'app', 'pubspec.yaml'),
    targetVersion: '3.13.5',
    ...overrides,
  };
}

describe('packages:list', () => {
  it('scans the folder of the project', async () => {
    state.scan.mockResolvedValue([]);

    await expect(invoke(IPC.packages.list, 'p1')).resolves.toEqual({
      projectId: 'p1',
      sections: [],
    });
    expect(state.scan).toHaveBeenCalledWith(ROOT);
  });
});

describe('packages:update', () => {
  it('refuses a manifest outside the project before running anything', async () => {
    const result = await invoke(IPC.packages.update, 'p1', [
      {
        ecosystem: 'node',
        name: 'left-pad',
        targetVersion: '1.3.0',
        manifestPath: join('C:', 'elsewhere', 'package.json'),
      },
    ]);

    expect(result).toMatchObject({ ok: false });
    expect(state.nodeUpdate).not.toHaveBeenCalled();
  });
});

describe('packages:updateRuntime', () => {
  it('hands a valid request to the adapter of its ecosystem', async () => {
    state.dartRuntime.mockResolvedValue({ ok: true, message: 'Updated' });

    await expect(invoke(IPC.packages.updateRuntime, 'p1', runtimeRequest())).resolves.toEqual({
      ok: true,
      message: 'Updated',
    });
    expect(state.dartRuntime).toHaveBeenCalledWith(ROOT, runtimeRequest(), expect.any(Object));
    expect(state.nodeRuntime).not.toHaveBeenCalled();
  });

  it('reads the installed toolchain from Dev Setup, and nothing for an unknown id', async () => {
    state.detect.mockResolvedValue({ state: 'found', version: '3.47.7', path: 'x', onPath: true });
    state.dartRuntime.mockResolvedValue({ ok: true, message: 'Updated' });

    await invoke(IPC.packages.updateRuntime, 'p1', runtimeRequest());
    const deps = state.dartRuntime.mock.calls[0][2];

    await expect(deps.installedVersion('flutter')).resolves.toBe('3.47.7');
    expect(state.detect).toHaveBeenCalledWith('flutter', { force: true });
    await expect(deps.installedVersion('not-a-tool')).resolves.toBeNull();

    state.detect.mockResolvedValue({ state: 'absent' });
    await expect(deps.installedVersion('flutter')).resolves.toBeNull();
  });

  it.each([
    [
      'a file outside the project',
      { manifestPath: join('C:', 'elsewhere', 'pubspec.yaml') },
      /outside the project folder/,
    ],
    [
      'a file that does not hold that setting',
      { manifestPath: join(ROOT, 'app', 'build.gradle') },
      /is not where that setting is kept/,
    ],
    ['a version with shell characters', { targetVersion: '3.13.5 && calc' }, /not a valid version/],
    ['a source that does not exist', { source: 'dockerfile' }, /Unknown runtime setting/],
    ['a source from another ecosystem', { ecosystem: 'node' }, /Unknown runtime setting/],
    ['a runtime the source cannot name', { kind: 'bun' }, /Unknown runtime setting/],
  ] as const)('refuses %s', async (_label, overrides, message) => {
    const result = await invoke<{ ok: boolean; message: string }>(
      IPC.packages.updateRuntime,
      'p1',
      runtimeRequest(overrides as Partial<RuntimeUpdateRequest>),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(message);
    expect(state.dartRuntime).not.toHaveBeenCalled();
    expect(state.nodeRuntime).not.toHaveBeenCalled();
  });

  it('accepts each file a .NET target framework can live in', async () => {
    const { rejectUnsafeRuntimeUpdate } = await import('./packageManagers');
    const dotnet = (file: string, source: 'target-framework' | 'global-json') =>
      rejectUnsafeRuntimeUpdate(
        {
          ecosystem: 'dotnet',
          source,
          kind: 'dotnet',
          manifestPath: join(ROOT, file),
          targetVersion: '10.0',
        },
        ROOT,
      );

    expect(dotnet(join('src', 'Api.csproj'), 'target-framework')).toBeNull();
    expect(dotnet(join('src', 'Lib.fsproj'), 'target-framework')).toBeNull();
    expect(dotnet('Directory.Build.props', 'target-framework')).toBeNull();
    expect(dotnet('global.json', 'global-json')).toBeNull();
    expect(dotnet('global.json', 'target-framework')).toMatch(/is not where that setting is kept/);
  });
});
