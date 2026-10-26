import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';

// Reading the registry would pull the machine's real PATH back in and defeat the point.
vi.mock('../windowsPath', () => ({
  refreshWindowsPath: vi.fn(async () => undefined),
  refreshWindowsEnvVars: vi.fn(async () => undefined),
  pathKey: (env: NodeJS.ProcessEnv) =>
    Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH',
}));

/**
 * The end-to-end tests of Dev Setup rely on the sandbox hiding the machine's real tools. That is
 * proven here with two different `node`s, one on the real PATH and one in the sandbox, and the
 * sandbox is shown to do nothing at all outside a test run.
 */

const onWindows = process.platform === 'win32';

function writeNode(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  if (onWindows) {
    writeFileSync(join(dir, 'node.cmd'), ['@echo off', `echo v${version}`, ''].join('\r\n'));
    return;
  }
  const file = join(dir, 'node');
  writeFileSync(file, ['#!/bin/sh', `echo "v${version}"`, ''].join('\n'));
  chmodSync(file, 0o755);
}

let realBin = '';
let sandbox = '';

beforeEach(() => {
  vi.resetModules();
  realBin = join(tempDir('runova-real-'), 'bin');
  sandbox = tempDir('runova-sandbox-');
  writeNode(realBin, '1.0.0');
  writeNode(join(sandbox, 'bin'), '22.12.0');

  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  const system = onWindows
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  vi.stubEnv(key, [realBin, ...system].join(delimiter));
  vi.stubEnv('RUNOVA_DEVSETUP_SANDBOX', sandbox);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('./userPathSystem');
});

describe('the Dev Setup sandbox, under a test run', () => {
  beforeEach(() => {
    vi.stubEnv('RUNOVA_E2E', '1');
  });

  it("sees the sandbox's tools and not the machine's", async () => {
    const { getDevSetupService } = await import('./runtime');

    const result = await getDevSetupService().detect('node', { force: true });

    expect(result).toMatchObject({ state: 'found', version: '22.12.0' });
  });

  it('sees nothing for a tool only the real machine has', async () => {
    const { getDevSetupService } = await import('./runtime');

    expect(await getDevSetupService().detect('pnpm', { force: true })).toEqual({ state: 'absent' });
  });

  it('never edits the real PATH: it refuses before looking at anything', async () => {
    // The user PATH is the registry or a shell startup file of the person running the tests, which
    // is exactly what the sandbox exists to keep out of reach.
    const createDeps = vi.fn();
    vi.doMock('./userPathSystem', () => ({ createSystemUserPathDeps: createDeps }));
    const { getDevSetupService } = await import('./runtime');

    await expect(getDevSetupService().addToPath('node')).rejects.toThrow(
      'Not available in a test run.',
    );
    expect(createDeps).not.toHaveBeenCalled();
  });
});

describe('the Dev Setup sandbox, outside a test run', () => {
  it('does nothing even if the variable is set, and the real PATH is used', async () => {
    const { getDevSetupService } = await import('./runtime');

    const result = await getDevSetupService().detect('node', { force: true });

    expect(result).toMatchObject({ state: 'found', version: '1.0.0' });
  });
});

describe('the Dev Setup sandbox home folder', () => {
  it('exists once the service is up, since a process cannot start in a folder that is missing', async () => {
    vi.stubEnv('RUNOVA_E2E', '1');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(sandbox, 'home'))).toBe(false);
    const { getDevSetupService } = await import('./runtime');

    getDevSetupService();

    expect(existsSync(join(sandbox, 'home'))).toBe(true);
  });
});
