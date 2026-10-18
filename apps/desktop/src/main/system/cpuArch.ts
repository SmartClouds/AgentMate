import os from 'node:os';
import type { CpuArch } from '../../shared/apiTypes';

// Linux and macOS report uname spellings (x86_64, aarch64, armv7l), Windows reports its own
// (AMD64, ARM64) and Node has a third set (x64, ia32). All of them land on Node's names.
const ARCH_ALIASES: Record<string, CpuArch> = {
  x86_64: 'x64',
  amd64: 'x64',
  x64: 'x64',
  i386: 'x86',
  i686: 'x86',
  x86: 'x86',
  ia32: 'x86',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv6l: 'arm',
  armv7l: 'arm',
  // A 32-bit userland on a 64-bit ARM kernel.
  armv8l: 'arm',
  arm: 'arm',
};

/** One spelling per architecture. An architecture this does not know passes through as given. */
export function normalizeArch(raw: string): CpuArch {
  const trimmed = raw.trim();
  return ARCH_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export interface CpuArchInputs {
  machine?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * The machine's architecture, not the process's. On Windows a 32-bit process on a 64-bit OS sees
 * x86 everywhere except PROCESSOR_ARCHITEW6432, so that wins when it is set. Under Rosetta, and
 * sometimes under x64 emulation on ARM64 Windows, `os.machine()` reports the emulated architecture,
 * so treat the result as a hint.
 */
export function readCpuArch({
  machine = os.machine(),
  platform = process.platform,
  env = process.env,
}: CpuArchInputs = {}): CpuArch {
  const wow64 = platform === 'win32' ? env.PROCESSOR_ARCHITEW6432?.trim() : undefined;
  return normalizeArch(wow64 || machine);
}
