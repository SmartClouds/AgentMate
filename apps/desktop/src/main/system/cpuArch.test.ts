import { describe, expect, it } from 'vitest';
import { normalizeArch, readCpuArch } from './cpuArch';

/**
 * The CPU card names the architecture, and the Linux temperature probe picks its sensor names by
 * it. Each OS spells the same architecture its own way, so these pin down the one spelling the
 * rest of the app sees.
 */

describe('normalizeArch', () => {
  it.each([
    ['x86_64', 'x64'],
    ['amd64', 'x64'],
    ['AMD64', 'x64'],
    ['x64', 'x64'],
    ['i386', 'x86'],
    ['i686', 'x86'],
    ['x86', 'x86'],
    ['ia32', 'x86'],
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
    ['ARM64', 'arm64'],
    ['armv6l', 'arm'],
    ['armv7l', 'arm'],
    ['armv8l', 'arm'],
    ['arm', 'arm'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeArch(raw)).toBe(expected);
  });

  it('passes an architecture it does not know through unchanged', () => {
    expect(normalizeArch('riscv64')).toBe('riscv64');
    expect(normalizeArch('ppc64le')).toBe('ppc64le');
  });

  it('ignores surrounding whitespace', () => {
    expect(normalizeArch(' x86_64\n')).toBe('x64');
  });
});

describe('readCpuArch', () => {
  it('reads an ARM64 Windows machine', () => {
    expect(readCpuArch({ machine: 'arm64', platform: 'win32', env: {} })).toBe('arm64');
  });

  it('reports the real OS architecture when a 32-bit process runs on 64-bit Windows', () => {
    // A WOW64 process sees x86 everywhere except this one variable.
    expect(
      readCpuArch({ machine: 'i686', platform: 'win32', env: { PROCESSOR_ARCHITEW6432: 'AMD64' } }),
    ).toBe('x64');
  });

  it('ignores PROCESSOR_ARCHITEW6432 outside Windows', () => {
    expect(
      readCpuArch({
        machine: 'aarch64',
        platform: 'linux',
        env: { PROCESSOR_ARCHITEW6432: 'AMD64' },
      }),
    ).toBe('arm64');
  });

  it('reads a 64-bit ARM Linux board', () => {
    expect(readCpuArch({ machine: 'aarch64', platform: 'linux', env: {} })).toBe('arm64');
  });

  it('reads a Raspberry Pi running a 32-bit OS', () => {
    expect(readCpuArch({ machine: 'armv7l', platform: 'linux', env: {} })).toBe('arm');
  });

  it('reads an Apple Silicon Mac', () => {
    expect(readCpuArch({ machine: 'arm64', platform: 'darwin', env: {} })).toBe('arm64');
  });

  it('passes an unknown machine through', () => {
    expect(readCpuArch({ machine: 'riscv64', platform: 'linux', env: {} })).toBe('riscv64');
  });

  it('reads the running machine when given nothing', () => {
    expect(readCpuArch()).toBeTruthy();
  });
});
