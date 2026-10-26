import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POSIX_PROBE,
  parsePosixProbe,
  parseWindowsProbe,
  WINDOWS_PROBE,
} from './runnerMachineProbe';

// Ubuntu, Alpine and the Windows JSON are real output of the probes (the Windows CPU figure was
// edited so it is not a round 100). The macOS one is put together from real vm_stat, top, sysctl
// and df output, since no Mac was at hand.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
}

const AT = 1_761_000_000_000;

describe('POSIX_PROBE', () => {
  it('fits in one single-quoted sh -c argument', () => {
    const script = POSIX_PROBE.slice("sh -c '".length, -1);
    expect(POSIX_PROBE.startsWith("sh -c '")).toBe(true);
    expect(POSIX_PROBE.endsWith("'")).toBe(true);
    expect(script).not.toContain("'");
  });
});

describe('WINDOWS_PROBE', () => {
  it('sends the script encoded, so neither cmd nor PowerShell can rewrite it', () => {
    const encoded = WINDOWS_PROBE.split(' ').at(-1) ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(WINDOWS_PROBE).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand \S+$/);
    expect(script).toContain('Win32_LogicalDisk');
    expect(script).toContain('ConvertTo-Json -Compress');
  });
});

describe('parsePosixProbe', () => {
  it('reads a Linux machine', () => {
    const sample = parsePosixProbe(fixture('runner-probe-ubuntu.txt'), AT);

    expect(sample).toEqual({
      at: AT,
      cpuPercent: expect.any(Number),
      cpuCount: 16,
      load1: 13.83,
      // MemTotal minus MemAvailable.
      memUsedBytes: (15986324 - 13047552) * 1024,
      memTotalBytes: 15986324 * 1024,
      diskUsedBytes: 358682940 * 1024,
      diskTotalBytes: (358682940 + 643376456) * 1024,
      diskMount: '/',
    });
    expect(sample?.cpuPercent).toBeCloseTo(20.58, 2);
  });

  it('reads busybox output the same way', () => {
    const sample = parsePosixProbe(fixture('runner-probe-alpine.txt'), AT);

    expect(sample?.cpuCount).toBe(16);
    expect(sample?.diskMount).toBe('/');
    expect(sample?.memTotalBytes).toBe(15986324 * 1024);
    expect(sample?.cpuPercent).toBeGreaterThanOrEqual(0);
  });

  it('falls back to free plus cache on kernels without MemAvailable', () => {
    const old = fixture('runner-probe-ubuntu.txt').replace(/^MemAvailable:.*\n/m, '');
    const sample = parsePosixProbe(old, AT);

    // MemFree 145768 + Buffers 1214100 + Cached 10737216, all in kB.
    expect(sample?.memUsedBytes).toBe((15986324 - (145768 + 1214100 + 10737216)) * 1024);
  });

  it('reads a Mac, counting memory the way Activity Monitor does', () => {
    const sample = parsePosixProbe(fixture('runner-probe-macos.txt'), AT);

    expect(sample).toEqual({
      at: AT,
      cpuPercent: 18.75,
      cpuCount: 10,
      load1: 2.31,
      // (400000 anonymous - 5000 purgeable) + 120000 wired + 100000 compressed, 16 KiB pages.
      memUsedBytes: 615000 * 16384,
      memTotalBytes: 17179869184,
      diskUsedBytes: 301234567 * 1024,
      diskTotalBytes: (301234567 + 160000000) * 1024,
      diskMount: '/System/Volumes/Data',
    });
  });

  it('counts active, wired and compressed on a Mac without anonymous pages', () => {
    const old = fixture('runner-probe-macos.txt').replace(/^Anonymous pages:.*\n/m, '');

    expect(parsePosixProbe(old, AT)?.memUsedBytes).toBe((420000 + 120000 + 100000) * 16384);
  });

  it('leaves the CPU share out when a reading is missing rather than guessing', () => {
    const noStat = fixture('runner-probe-ubuntu.txt').replace(/^@@stat2\ncpu .*\n/m, '');

    expect(parsePosixProbe(noStat, AT)?.cpuPercent).toBeNull();
  });

  it('keeps a mount point with spaces whole', () => {
    const spaced = fixture('runner-probe-ubuntu.txt').replace(
      /^overlay .*$/m,
      'map auto_home  1000  400  600  40% /Volumes/Build Disk',
    );

    expect(parsePosixProbe(spaced, AT)).toMatchObject({
      diskMount: '/Volumes/Build Disk',
      diskUsedBytes: 400 * 1024,
      diskTotalBytes: 1000 * 1024,
    });
  });

  it.each([
    ['nothing', ''],
    ['a shell without sh', "'sh' is not recognized as an internal or external command"],
    ['Git for Windows sh', '@@os\nMINGW64_NT-10.0-26100\n'],
    ['a Linux reading without meminfo', '@@os\nLinux\n@@df\noverlay 10 4 6 40% /\n'],
    [
      'a Linux reading without df',
      '@@os\nLinux\n@@meminfo\nMemTotal: 100 kB\nMemAvailable: 50 kB\n',
    ],
  ])('gives up on %s', (_name, stdout) => {
    expect(parsePosixProbe(stdout, AT)).toBeNull();
  });
});

describe('parseWindowsProbe', () => {
  it('finds the JSON among PowerShell progress records', () => {
    expect(parseWindowsProbe(fixture('runner-probe-windows.txt'), AT)).toEqual({
      at: AT,
      cpuPercent: 37,
      cpuCount: 16,
      load1: null,
      memUsedBytes: (32764984 - 11196752) * 1024,
      memTotalBytes: 32764984 * 1024,
      diskUsedBytes: 486960074752 - 29650104320,
      diskTotalBytes: 486960074752,
      diskMount: 'C:',
    });
  });

  it('leaves the CPU share out when WMI had no load figure', () => {
    const stdout =
      '{"probe":"runova-runner","cpu":null,"cores":4,"memTotalKb":100,"memFreeKb":40,"drive":"D:","diskSize":1000,"diskFree":250}';

    expect(parseWindowsProbe(stdout, AT)).toMatchObject({
      cpuPercent: null,
      diskMount: 'D:',
      memUsedBytes: 60 * 1024,
    });
  });

  it.each([
    ['POSIX output', fixture('runner-probe-ubuntu.txt')],
    ['other JSON', '{"cpu":10}'],
    ['broken JSON', '{"probe":"runova-runner",'],
    ['a reading without the disk', '{"probe":"runova-runner","memTotalKb":100,"memFreeKb":40}'],
  ])('gives up on %s', (_name, stdout) => {
    expect(parseWindowsProbe(stdout, AT)).toBeNull();
  });
});
