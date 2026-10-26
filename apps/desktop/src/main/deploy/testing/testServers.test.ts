import { describe, expect, it, vi } from 'vitest';
import { requestedImages, systemTestsEnabled, testServerImages } from './testServers';

describe('choosing the test servers a system test runs on', () => {
  it('keeps each test on its own defaults when nothing is asked for', () => {
    expect(requestedImages(undefined)).toBeNull();
    expect(requestedImages('  ')).toBeNull();
    expect(
      testServerImages(['ubuntu-24.04', 'debian-13', 'rocky-9'], ['ubuntu-24.04'], undefined),
    ).toEqual(['ubuntu-24.04']);
  });

  it('runs only the asked-for images a test supports, in the test order', () => {
    const asked = 'rocky-9, debian-13,ubuntu-24.04-ufw';
    expect(requestedImages(asked)).toEqual(['rocky-9', 'debian-13', 'ubuntu-24.04-ufw']);
    expect(
      testServerImages(['ubuntu-24.04', 'debian-13', 'rocky-9'], ['ubuntu-24.04'], asked),
    ).toEqual(['debian-13', 'rocky-9']);
    expect(testServerImages(['rocky-9-firewalld'], ['rocky-9-firewalld'], asked)).toEqual([]);
  });

  it('refuses an image name it does not know, so a typo in a workflow cannot skip everything', () => {
    expect(() => requestedImages('ubuntu-22.04')).toThrow(/ubuntu-22\.04/);
  });
});

describe('deciding whether system tests run', () => {
  it('stays off unless RUNOVA_SYSTEM_TESTS is 1, without asking Docker', () => {
    const osType = vi.fn(() => 'linux');

    expect(systemTestsEnabled(undefined, osType)).toBe(false);
    expect(systemTestsEnabled('0', osType)).toBe(false);
    expect(osType).not.toHaveBeenCalled();
  });

  it('runs on a Docker with Linux containers', () => {
    expect(systemTestsEnabled('1', () => 'linux')).toBe(true);
    expect(systemTestsEnabled('1', () => 'windows')).toBe(false);
  });

  it('asks a busy Docker again rather than skipping every system test on one slow answer', () => {
    const osType = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error('spawnSync docker ETIMEDOUT');
      })
      .mockImplementationOnce(() => 'linux');

    expect(systemTestsEnabled('1', osType, () => undefined)).toBe(true);
    expect(osType).toHaveBeenCalledTimes(2);
  });

  it('gives up and says so when Docker never answers', () => {
    const warn = vi.fn();
    const osType = vi.fn<() => string>(() => {
      throw new Error('spawnSync docker ETIMEDOUT');
    });

    expect(systemTestsEnabled('1', osType, warn)).toBe(false);
    expect(osType).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ETIMEDOUT/));
  });
});
