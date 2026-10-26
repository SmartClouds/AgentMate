import type { RunnerMachineSample } from '../../shared/apiTypes';
import { macUsedBytesFromVmStat, parseVmStat } from '../system/memoryStats';

/**
 * What the Pipelines page runs on a runner machine over SSH to show its CPU, memory and disk, and
 * the parsers for what comes back. Nothing here does I/O, so the parsing is tested on real output.
 *
 * The POSIX probe goes through `sh -c` so a login shell like fish cannot trip over its syntax. On
 * Windows, OpenSSH lands in cmd or PowerShell where `sh` does not exist, and the caller falls back
 * to the PowerShell probe.
 */

/** Each section of the POSIX probe's output starts with one of these on a line of its own. */
const SECTION = /^@@(\w+)$/;

// No single quotes inside: the whole script is passed to `sh -c '...'`.
const POSIX_SCRIPT = [
  'echo @@os; uname -s',
  'case "$(uname -s)" in',
  'Linux)',
  // Two readings a second apart, so one call gives a CPU share without keeping state.
  '  echo @@stat1; head -n 1 /proc/stat; sleep 1; echo @@stat2; head -n 1 /proc/stat',
  '  echo @@meminfo; cat /proc/meminfo',
  '  echo @@loadavg; cat /proc/loadavg',
  '  echo @@ncpu; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN',
  '  echo @@df; df -Pk /;;',
  'Darwin)',
  '  echo @@sysctl; sysctl -n hw.memsize hw.ncpu vm.loadavg',
  '  echo @@vmstat; vm_stat',
  // The first of top's samples counts from boot, so take the second.
  '  echo @@top; top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -n 1',
  // The root of an APFS Mac is the small sealed system volume; the user's data lives here.
  '  echo @@df; if [ -d /System/Volumes/Data ]; then df -Pk /System/Volumes/Data; else df -Pk /; fi;;',
  'esac',
].join('\n');

export const POSIX_PROBE = `sh -c '${POSIX_SCRIPT}'`;

const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$cpu = Get-CimInstance Win32_Processor',
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$drive = $env:SystemDrive',
  '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$drive\'"',
  '[pscustomobject]@{',
  '  probe = "runova-runner"',
  '  cpu = ($cpu | Measure-Object LoadPercentage -Average).Average',
  '  cores = ($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum',
  '  memTotalKb = $os.TotalVisibleMemorySize',
  '  memFreeKb = $os.FreePhysicalMemory',
  '  drive = $drive',
  '  diskSize = $disk.Size',
  '  diskFree = $disk.FreeSpace',
  '} | ConvertTo-Json -Compress',
].join('\n');

/**
 * Encoded, so it reaches PowerShell intact whether the server's OpenSSH shell is cmd (which would
 * mangle quotes) or PowerShell (which would expand `$` inside a double-quoted argument).
 */
export const WINDOWS_PROBE = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
  WINDOWS_SCRIPT,
  'utf16le',
).toString('base64')}`;

function sections(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const marker = SECTION.exec(line);
    if (marker) {
      current = [];
      found.set(marker[1], current);
    } else if (current && line !== '') {
      current.push(line);
    }
  }
  return found;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice` as busy and total ticks. */
function cpuTicks(line: string | undefined): { busy: number; total: number } | null {
  if (!line?.startsWith('cpu ')) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  // Guest time is already counted in user and nice, so only the first eight columns add up.
  const counted = values.slice(0, 8);
  const total = counted.reduce((sum, value) => sum + value, 0);
  const idle = counted[3] + (counted[4] ?? 0);
  return { busy: total - idle, total };
}

function cpuShare(
  before: { busy: number; total: number } | null,
  after: { busy: number; total: number } | null,
): number | null {
  if (!before || !after) return null;
  const total = after.total - before.total;
  if (total <= 0) return null;
  return clampPercent(((after.busy - before.busy) / total) * 100);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** `/proc/meminfo` as kB values by key. */
function meminfo(lines: string[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of lines) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  return values;
}

/**
 * The data line of `df -Pk`: filesystem, 1024-blocks, used, available, capacity, mount point.
 * Read with a pattern rather than split on spaces, since a filesystem or mount can contain them.
 */
function parseDf(
  lines: string[] | undefined,
): { usedBytes: number; totalBytes: number; mount: string } | null {
  for (const line of lines ?? []) {
    const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(line);
    if (!match) continue;
    const used = Number(match[3]) * 1024;
    const available = Number(match[4]) * 1024;
    return { usedBytes: used, totalBytes: used + available, mount: match[6] };
  }
  return null;
}

function parseLinux(found: Map<string, string[]>, at: number): RunnerMachineSample | null {
  const memory = meminfo(found.get('meminfo') ?? []);
  const total = memory.get('MemTotal');
  // MemAvailable came with Linux 3.14. Older kernels get free plus what the page cache can give back.
  const available =
    memory.get('MemAvailable') ??
    (memory.has('MemFree')
      ? (memory.get('MemFree') ?? 0) + (memory.get('Buffers') ?? 0) + (memory.get('Cached') ?? 0)
      : undefined);
  const disk = parseDf(found.get('df'));
  if (total === undefined || available === undefined || !disk) return null;
  const totalBytes = total * 1024;
  return {
    at,
    cpuPercent: cpuShare(cpuTicks(found.get('stat1')?.[0]), cpuTicks(found.get('stat2')?.[0])),
    cpuCount: finite(Number.parseInt(found.get('ncpu')?.[0] ?? '', 10)),
    load1: finite(Number.parseFloat(found.get('loadavg')?.[0] ?? '')),
    memUsedBytes: Math.max(0, Math.min(totalBytes, totalBytes - available * 1024)),
    memTotalBytes: totalBytes,
    diskUsedBytes: disk.usedBytes,
    diskTotalBytes: disk.totalBytes,
    diskMount: disk.mount,
  };
}

function parseMac(found: Map<string, string[]>, at: number): RunnerMachineSample | null {
  // `sysctl -n` prints one value per line: bytes, cores, then `{ 1.20 1.10 1.00 }`.
  const [memsize, ncpu, loadavg] = found.get('sysctl') ?? [];
  const totalBytes = Number(memsize);
  const vmStat = (found.get('vmstat') ?? []).join('\n');
  const disk = parseDf(found.get('df'));
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !disk) return null;
  let used = macUsedBytesFromVmStat(vmStat);
  if (used == null) {
    // Older macOS without "Anonymous pages": active plus wired plus compressed.
    const { pageSize, pages } = parseVmStat(vmStat);
    const counted = ['Pages active', 'Pages wired down', 'Pages occupied by compressor'].map(
      (key) => pages[key],
    );
    if (!counted.every(Number.isFinite)) return null;
    used = counted.reduce((sum, value) => sum + value, 0) * pageSize;
  }
  const idle = /([\d.]+)%\s+idle/.exec(found.get('top')?.[0] ?? '');
  return {
    at,
    cpuPercent: idle ? clampPercent(100 - Number(idle[1])) : null,
    cpuCount: finite(Number.parseInt(ncpu ?? '', 10)),
    load1: finite(Number.parseFloat(/[\d.]+/.exec(loadavg ?? '')?.[0] ?? '')),
    memUsedBytes: Math.max(0, Math.min(totalBytes, used)),
    memTotalBytes: totalBytes,
    diskUsedBytes: disk.usedBytes,
    diskTotalBytes: disk.totalBytes,
    diskMount: disk.mount,
  };
}

/** Null when the output is not a Linux or macOS reading this parser understands. */
export function parsePosixProbe(stdout: string, at = Date.now()): RunnerMachineSample | null {
  const found = sections(stdout);
  const os = found.get('os')?.[0];
  if (os === 'Linux') return parseLinux(found, at);
  if (os === 'Darwin') return parseMac(found, at);
  return null;
}

interface WindowsProbeJson {
  probe?: unknown;
  cpu?: unknown;
  cores?: unknown;
  memTotalKb?: unknown;
  memFreeKb?: unknown;
  drive?: unknown;
  diskSize?: unknown;
  diskFree?: unknown;
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/** Null unless the output holds the PowerShell probe's JSON. */
export function parseWindowsProbe(stdout: string, at = Date.now()): RunnerMachineSample | null {
  const line = stdout
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text.startsWith('{') && text.includes('runova-runner'));
  if (!line) return null;
  let data: WindowsProbeJson;
  try {
    data = JSON.parse(line) as WindowsProbeJson;
  } catch {
    return null;
  }
  const memTotalKb = numberOf(data.memTotalKb);
  const memFreeKb = numberOf(data.memFreeKb);
  const diskSize = numberOf(data.diskSize);
  const diskFree = numberOf(data.diskFree);
  if (memTotalKb === null || memFreeKb === null || diskSize === null || diskFree === null) {
    return null;
  }
  const cpu = numberOf(data.cpu);
  return {
    at,
    cpuPercent: cpu === null ? null : clampPercent(cpu),
    cpuCount: numberOf(data.cores),
    load1: null,
    memUsedBytes: Math.max(0, (memTotalKb - memFreeKb) * 1024),
    memTotalBytes: memTotalKb * 1024,
    diskUsedBytes: Math.max(0, diskSize - diskFree),
    diskTotalBytes: diskSize,
    diskMount: typeof data.drive === 'string' && data.drive !== '' ? data.drive : 'C:',
  };
}
