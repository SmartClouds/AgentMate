import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';

// Reading the registry would pull the real machine's PATH back in and make these results depend on
// what is installed here. The pieces under test are the wiring, not the registry refresh.
vi.mock('../windowsPath', () => ({
  refreshWindowsPath: vi.fn(async () => undefined),
  pathKey: (env: NodeJS.ProcessEnv) =>
    Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH',
}));

// The folders native installers use (Homebrew's on macOS, ~/.local/bin and the like) are added to
// every probe's PATH; on a machine with pnpm in one of them the "absent" test would find it.
vi.mock('../toolPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolPaths')>();
  return {
    ...actual,
    getExtraToolPathDirs: async () => [],
    withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
  };
});

// Whatever these tests do, nothing may reach the real registry or a real shell startup file.
const userPath = vi.hoisted(() => ({
  readRegistryPath: vi.fn(async () => null),
  writeRegistryPath: vi.fn(async () => undefined),
  broadcastEnvironmentChange: vi.fn(async () => undefined),
  addToProcessPath: vi.fn(),
  readFile: vi.fn(async () => null),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock('./userPathSystem', () => ({
  createSystemUserPathDeps: (home: string) => ({ os: 'win32', home, ...userPath }),
}));

// The real thing unless a test says otherwise, so the refusals below run the real checks.
vi.mock('./addToPath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./addToPath')>();
  return { addToolToPath: vi.fn(actual.addToolToPath) };
});

import { addToolToPath } from './addToPath';
import { getDevSetupService } from './runtime';

/**
 * The glue that points the detectors at the real machine. The logic is covered where it lives; this
 * proves the pieces are connected, using a fake tool on a temp PATH so the result does not depend
 * on what happens to be installed on the machine running the tests.
 */

const onWindows = process.platform === 'win32';
let binDir = '';

function writeFakeNode(version: string): void {
  if (onWindows) {
    writeFileSync(join(binDir, 'node.cmd'), ['@echo off', `echo v${version}`, ''].join('\r\n'));
    return;
  }
  const file = join(binDir, 'node');
  writeFileSync(file, ['#!/bin/sh', `echo "v${version}"`, ''].join('\n'));
  chmodSync(file, 0o755);
}

beforeEach(() => {
  binDir = join(tempDir('runova-devsetup-'), 'bin');
  mkdirSync(binDir, { recursive: true });
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  const system = onWindows
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  vi.stubEnv(key, [binDir, ...system].join(delimiter));
  // Fallback locations are read from these, so they have to point somewhere empty.
  vi.stubEnv('ProgramFiles', join(binDir, 'no-program-files'));
  vi.stubEnv('LOCALAPPDATA', join(binDir, 'no-local-app-data'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Dev Setup service', () => {
  it('finds a tool that is on PATH and reads its version', async () => {
    writeFakeNode('22.12.0');

    const result = await getDevSetupService().detect('node', { force: true });

    expect(result).toMatchObject({ state: 'found', version: '22.12.0', onPath: true });
  });

  it('reports a tool that is nowhere as absent', async () => {
    const result = await getDevSetupService().detect('pnpm', { force: true });

    expect(result).toEqual({ state: 'absent' });
  });

  it('remembers what it found, so the nav badge can read it without probing', async () => {
    writeFakeNode('22.12.0');
    const service = getDevSetupService();
    await service.detect('node', { force: true });

    // `gh` is never checked in this file, and the service (and its memory) is shared by every test.
    expect(service.peek(['node', 'gh'])).toMatchObject({
      node: { state: 'found' },
      gh: undefined,
    });
  });

  it('describes the machine: its OS, CPU and package managers', async () => {
    const environment = await getDevSetupService().environment({ force: true });

    expect(environment.os).toBe(
      process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    );
    expect(['x64', 'arm64', 'other']).toContain(environment.arch);
    expect(Array.isArray(environment.packageManagers)).toBe(true);
  });

  it('hands every caller the same service', () => {
    expect(getDevSetupService()).toBe(getDevSetupService());
  });
});

describe('the Dev Setup service: installs', () => {
  it('has nothing running to begin with', () => {
    expect(getDevSetupService().jobState()).toMatchObject({ running: false, items: {}, order: [] });
  });

  it('refuses to install something that is not in the catalog, before running anything', async () => {
    await expect(getDevSetupService().install({ ids: ['definitely-not-real'] })).rejects.toThrow(
      'Unknown dev setup item.',
    );
  });

  it('does nothing when asked to cancel with nothing running', () => {
    expect(() => getDevSetupService().cancel()).not.toThrow();
    expect(() => getDevSetupService().cancel('git')).not.toThrow();
  });

  it('stops cleanly on dispose when nothing is running', () => {
    expect(() => getDevSetupService().dispose()).not.toThrow();
  });
});

describe('the Dev Setup service: adding a tool to PATH', () => {
  const REFUSED = 'That tool is already on your PATH, or was not found.';

  function expectNothingWritten(): void {
    expect(userPath.writeRegistryPath).not.toHaveBeenCalled();
    expect(userPath.broadcastEnvironmentChange).not.toHaveBeenCalled();
    expect(userPath.addToProcessPath).not.toHaveBeenCalled();
    expect(userPath.writeFile).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    for (const fn of Object.values(userPath)) fn.mockClear();
  });

  it('refuses a tool that is nowhere, and writes nothing', async () => {
    await expect(getDevSetupService().addToPath('pnpm')).rejects.toThrow(REFUSED);

    expectNothingWritten();
  });

  it('refuses an item that is not in the catalog, and writes nothing', async () => {
    await expect(getDevSetupService().addToPath('definitely-not-real')).rejects.toThrow(REFUSED);

    expectNothingWritten();
  });

  it('refuses a tool that is already on PATH, and writes nothing', async () => {
    writeFakeNode('22.12.0');

    await expect(getDevSetupService().addToPath('node')).rejects.toThrow(REFUSED);

    expectNothingWritten();
  });

  it('adds the folder through the real PATH editing and then looks at the tool again', async () => {
    const service = getDevSetupService();
    // `jdk17` is never checked in this file, so anything remembered about it is from this call.
    expect(service.peek(['jdk17'])).toEqual({ jdk17: undefined });
    vi.mocked(addToolToPath).mockResolvedValueOnce({ changed: true, where: 'your user PATH' });

    await expect(service.addToPath('jdk17')).resolves.toEqual({
      changed: true,
      where: 'your user PATH',
    });

    const call = vi.mocked(addToolToPath).mock.calls.at(-1);
    const deps = call?.[1];
    expect(call?.[0]).toBe('jdk17');
    expect(deps?.os).toBe(
      process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    );
    // The edit is the real one: it turns an unsafe folder away before it touches anything.
    await expect(deps?.addToUserPath('relative\\folder')).rejects.toThrow(
      'That folder cannot go on the PATH.',
    );
    expectNothingWritten();
    expect(service.peek(['jdk17']).jdk17).toBeDefined();
  });

  it('does not look again when the edit was refused', async () => {
    const service = getDevSetupService();
    // `dart` is never checked in this file either.
    vi.mocked(addToolToPath).mockRejectedValueOnce(new Error('That folder cannot go on the PATH.'));

    await expect(service.addToPath('dart')).rejects.toThrow('That folder cannot go on the PATH.');

    expect(service.peek(['dart'])).toEqual({ dart: undefined });
  });
});
