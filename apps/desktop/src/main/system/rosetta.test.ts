import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => ({ execFileSync }));

// The exact stderr from an Intel Runova running `git init` on an Apple Silicon Mac.
const XCRUN_ERROR =
  "xcrun: error: unable to load libxcrun (dlopen(/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib, 0x0005): tried: '/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib' (fat file, but missing compatible architecture (have 'arm64,arm64e', need 'x86_64')), '/System/Volumes/Preboot/Cryptexes/Rosetta/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib' (no such file)).";

const realPlatform = process.platform;
const realArch = process.arch;

function runningOn(platform: string, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
}

// The answer is cached for the life of the process, so every test gets a fresh module.
async function load() {
  vi.resetModules();
  return import('./rosetta');
}

beforeEach(() => {
  execFileSync.mockReset();
});

afterEach(() => {
  runningOn(realPlatform, realArch);
});

describe('isRunningUnderRosetta', () => {
  it('is true for the Intel build when macOS says the process is translated', async () => {
    runningOn('darwin', 'x64');
    execFileSync.mockReturnValue('1\n');
    const { isRunningUnderRosetta } = await load();
    expect(isRunningUnderRosetta()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/sbin/sysctl',
      ['-n', 'sysctl.proc_translated'],
      expect.anything(),
    );
  });

  it('is false for the Intel build on a native Intel Mac', async () => {
    runningOn('darwin', 'x64');
    execFileSync.mockReturnValue('0\n');
    const { isRunningUnderRosetta } = await load();
    expect(isRunningUnderRosetta()).toBe(false);
  });

  it('is false when sysctl has no such key, as on older Intel Macs', async () => {
    runningOn('darwin', 'x64');
    execFileSync.mockImplementation(() => {
      throw new Error('sysctl: unknown oid');
    });
    const { isRunningUnderRosetta } = await load();
    expect(isRunningUnderRosetta()).toBe(false);
  });

  it('never asks on the arm64 build or off macOS', async () => {
    runningOn('darwin', 'arm64');
    expect((await load()).isRunningUnderRosetta()).toBe(false);
    runningOn('win32', 'x64');
    expect((await load()).isRunningUnderRosetta()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('asks sysctl only once', async () => {
    runningOn('darwin', 'x64');
    execFileSync.mockReturnValue('1\n');
    const { isRunningUnderRosetta } = await load();
    isRunningUnderRosetta();
    isRunningUnderRosetta();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('isXcrunArchMismatch', () => {
  it('recognises the libxcrun architecture error', async () => {
    const { isXcrunArchMismatch } = await load();
    expect(isXcrunArchMismatch(XCRUN_ERROR)).toBe(true);
  });

  it('leaves other git failures alone', async () => {
    const { isXcrunArchMismatch } = await load();
    expect(isXcrunArchMismatch('fatal: not a git repository')).toBe(false);
    expect(isXcrunArchMismatch('xcrun: error: invalid active developer path')).toBe(false);
  });
});
