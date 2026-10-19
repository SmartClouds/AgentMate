import { describe, expect, it } from 'vitest';
import { resolveDevSetupSandbox } from './sandbox';

/**
 * End-to-end tests of Dev Setup cannot be allowed to see the real machine's tools, or they would
 * pass or fail depending on what the developer happens to have installed. The sandbox gives them a
 * private PATH and home. It must be impossible to turn on outside a test run.
 */

const REAL_ENV = {
  Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  JAVA_HOME: 'C:\\Java\\jdk-17',
  ANDROID_HOME: 'C:\\Android\\Sdk',
  Unrelated: 'keep me',
};

const FOLDER = 'C:\\Temp\\sandbox';

describe('resolveDevSetupSandbox', () => {
  it('is off outside a test run, whatever the variable says', () => {
    expect(
      resolveDevSetupSandbox({ isE2E: false, folder: FOLDER, baseEnv: REAL_ENV, os: 'win32' }),
    ).toBeNull();
  });

  it('is off when no folder is given', () => {
    expect(
      resolveDevSetupSandbox({ isE2E: true, folder: undefined, baseEnv: REAL_ENV, os: 'win32' }),
    ).toBeNull();
    expect(
      resolveDevSetupSandbox({ isE2E: true, folder: '  ', baseEnv: REAL_ENV, os: 'win32' }),
    ).toBeNull();
  });

  it('is off for a folder that is not an absolute path, since it could resolve to anywhere', () => {
    expect(
      resolveDevSetupSandbox({ isE2E: true, folder: 'sandbox', baseEnv: REAL_ENV, os: 'win32' }),
    ).toBeNull();
  });

  it("sees only the sandbox's own bin folder and the system folders on Windows", () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: FOLDER,
      baseEnv: REAL_ENV,
      os: 'win32',
    });

    const entries = (sandbox?.env.Path ?? '').split(';');
    expect(entries[0]).toBe('C:\\Temp\\sandbox\\bin');
    expect(entries).toContain('C:\\Windows\\System32');
    // The real Git folder is gone, which is the point.
    expect(entries).not.toContain('C:\\Program Files\\Git\\cmd');
  });

  it('keeps the same variable name Windows already uses for PATH, so there is only one', () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: FOLDER,
      baseEnv: REAL_ENV,
      os: 'win32',
    });

    expect(Object.keys(sandbox?.env ?? {}).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'Path',
    ]);
  });

  it('points the places tools hide at folders that do not exist', () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: FOLDER,
      baseEnv: REAL_ENV,
      os: 'win32',
    });

    expect(sandbox?.env.ProgramFiles).toBe('C:\\Temp\\sandbox\\none\\Program Files');
    expect(sandbox?.env.LOCALAPPDATA).toBe('C:\\Temp\\sandbox\\none\\Local');
    expect(sandbox?.home).toBe('C:\\Temp\\sandbox\\home');
    expect(sandbox?.env.USERPROFILE).toBe('C:\\Temp\\sandbox\\home');
  });

  it('forgets variables that installers set, so a real JDK or SDK cannot be found through them', () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: FOLDER,
      baseEnv: REAL_ENV,
      os: 'win32',
    });

    expect(sandbox?.env.JAVA_HOME).toBeUndefined();
    expect(sandbox?.env.ANDROID_HOME).toBeUndefined();
  });

  it('leaves everything unrelated alone', () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: FOLDER,
      baseEnv: REAL_ENV,
      os: 'win32',
    });

    expect(sandbox?.env.Unrelated).toBe('keep me');
    expect(sandbox?.env.SystemRoot).toBe('C:\\Windows');
  });

  it('does not change the environment it was given', () => {
    const base = { ...REAL_ENV };

    resolveDevSetupSandbox({ isE2E: true, folder: FOLDER, baseEnv: base, os: 'win32' });

    expect(base).toEqual(REAL_ENV);
  });

  it('works the same off Windows, with nothing but its own folder on PATH', () => {
    const sandbox = resolveDevSetupSandbox({
      isE2E: true,
      folder: '/tmp/sandbox',
      baseEnv: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me' },
      os: 'darwin',
    });

    expect(sandbox?.env.PATH).toBe('/tmp/sandbox/bin');
    expect(sandbox?.home).toBe('/tmp/sandbox/home');
    expect(sandbox?.env.HOME).toBe('/tmp/sandbox/home');
  });
});
