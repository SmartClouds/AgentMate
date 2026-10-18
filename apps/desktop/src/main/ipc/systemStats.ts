import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import os from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { app, ipcMain } from 'electron';
import type {
  DiskUsage,
  KillProcessResult,
  SystemStatsSample,
  TopResourceApp,
  TopResourceAppsResult,
  TopResourceKind,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { probeAll } from '../network/pingProbe';
import { store } from '../store';
import { readCpuArch } from '../system/cpuArch';
import { sampleGpus } from '../system/gpuStats';
import { sampleMemory } from '../system/memoryStats';
import { asArray, runPowerShellJson } from '../system/processTree';
import { type CpuTemperature, sampleCpuTemperature } from '../system/temperatureStats';

const execFileAsync = promisify(execFile);

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface CpuSample {
  cpuPercent: number;
  cpuCorePercents: number[];
}

// os.cpus()[n].model is padded/repeats vendor boilerplate on some platforms
// (e.g. trailing whitespace on Windows), so it's normalized once here.
function readCpuModel(): string {
  return os.cpus()[0]?.model.trim().replace(/\s+/g, ' ') ?? 'Unknown CPU';
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function averagePercents(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, p) => sum + p, 0) / values.length;
}

function readCpuSnapshots(): CpuSnapshot[] {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    // On Windows, libuv's `sys` is KernelTime - IdleTime, and KernelTime
    // already includes interrupt time. Adding `irq` would double-count it
    // and inflate usage. On Unix, irq is a separate slice of /proc/stat.
    const irq = process.platform === 'win32' ? 0 : t.irq;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + irq };
  });
}

let lastCpuSnapshots: CpuSnapshot[] | null = null;

function percentFromDelta(previous: CpuSnapshot, snapshot: CpuSnapshot): number {
  const idleDelta = snapshot.idle - previous.idle;
  const totalDelta = snapshot.total - previous.total;
  if (totalDelta <= 0) return 0;
  return clampPercent(100 * (1 - idleDelta / totalDelta));
}

// Instantaneous CPU load isn't exposed by Node, only cumulative per-core
// tick counters, so usage is derived from the delta between consecutive
// samples (same technique top/htop use). Returns per-core percentages; the
// aggregate total is the average of all cores.
function sampleCpuCorePercentsFromOs(): number[] {
  const snapshots = readCpuSnapshots();
  const previous = lastCpuSnapshots;
  lastCpuSnapshots = snapshots;
  if (!previous || previous.length !== snapshots.length) return snapshots.map(() => 0);
  return snapshots.map((snapshot, i) => percentFromDelta(previous[i], snapshot));
}

// Read from the kernel's tick counters and averaged over the time since the last sample. This used
// to start PowerShell and query WMI on every sample on Windows: that process burst counted as load
// on its own, it read a one second window (so a short spike showed as 100%), and under real load
// the query itself came back late. os.cpus() costs nothing and matches the Task Manager average.
async function sampleCpu(): Promise<CpuSample> {
  const cpuCorePercents = sampleCpuCorePercentsFromOs();
  return { cpuPercent: averagePercents(cpuCorePercents), cpuCorePercents };
}

interface DiskIoSnapshot {
  readBytes: number;
  writeBytes: number;
  timestamp: number;
}

let lastDiskIoSnapshots = new Map<string, DiskIoSnapshot>();

// Enumerates every physical disk's live read/write throughput (not capacity)
// so the dashboard can chart I/O activity for all of them at once.
async function sampleDisks(): Promise<DiskUsage[]> {
  try {
    if (process.platform === 'win32') {
      // PhysicalDisk (not LogicalDisk): a single physical disk can host
      // several drive letters, and I/O activity happens on the physical
      // spindle/SSD, not the logical volume. This WMI class already reports
      // a rolling per-second rate, no manual delta needed.
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json',
      ]);
      const parsed = JSON.parse(stdout) as
        | { Name: string; DiskReadBytesPersec: number | null; DiskWriteBytesPersec: number | null }
        | {
            Name: string;
            DiskReadBytesPersec: number | null;
            DiskWriteBytesPersec: number | null;
          }[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return (
        rows
          // "_Total" is the aggregate row across all disks; each disk is already listed on its own.
          .filter((r) => r.Name !== '_Total')
          .map((r) => {
            // Instance names look like "0 C:" or "1 D: E:": index followed by
            // the drive letter(s) that live on that physical disk.
            const index = r.Name.match(/^\d+/)?.[0];
            return {
              id: r.Name,
              label: index ? `Disk ${index}` : r.Name,
              readBytesPerSec: r.DiskReadBytesPersec ?? 0,
              writeBytesPerSec: r.DiskWriteBytesPersec ?? 0,
            };
          })
      );
    }

    if (process.platform === 'linux') {
      const data = await readFile('/proc/diskstats', 'utf-8');
      const timestamp = Date.now();
      const previous = lastDiskIoSnapshots;
      const next = new Map<string, DiskIoSnapshot>();
      const results: DiskUsage[] = [];
      for (const line of data.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 14) continue;
        const name = cols[2];
        // Whole disks only (sda, nvme0n1, vda, etc), skips partitions, loop and ram devices.
        if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/.test(name)) continue;
        const readBytes = Number(cols[5]) * 512;
        const writeBytes = Number(cols[9]) * 512;
        next.set(name, { readBytes, writeBytes, timestamp });
        const prev = previous.get(name);
        if (!prev) continue;
        const elapsedSec = (timestamp - prev.timestamp) / 1000;
        if (elapsedSec <= 0) continue;
        results.push({
          id: name,
          label: name,
          readBytesPerSec: Math.max(0, (readBytes - prev.readBytes) / elapsedSec),
          writeBytesPerSec: Math.max(0, (writeBytes - prev.writeBytes) / elapsedSec),
        });
      }
      lastDiskIoSnapshots = next;
      return results;
    }

    if (process.platform === 'darwin') {
      // `-w 1` waits 1s between the two samples so the second one reflects a
      // real interval; macOS iostat only reports combined throughput per
      // disk, not a read/write split.
      const { stdout } = await execFileAsync('iostat', ['-d', '-c', '2', '-w', '1']);
      const lines = stdout.trim().split('\n');
      if (lines.length < 4) return [];
      const diskNames = lines[0].trim().split(/\s+/);
      const lastRow = (lines.at(-1) ?? '').trim().split(/\s+/).map(Number);
      const results: DiskUsage[] = [];
      diskNames.forEach((name, i) => {
        const mbPerSec = lastRow[i * 3 + 2];
        if (!Number.isFinite(mbPerSec)) return;
        results.push({
          id: name,
          label: name,
          readBytesPerSec: mbPerSec * 1024 * 1024,
          writeBytesPerSec: 0,
        });
      });
      return results;
    }

    return [];
  } catch {
    return [];
  }
}

interface NetTotals {
  rxBytes: number;
  txBytes: number;
}

// Node has no cross-platform network byte-counter API, so totals are read
// from the same OS-native sources the platform's own tools use.
async function readNetTotals(): Promise<NetTotals> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-e']);
    const match = stdout.match(/Bytes\s+(\d+)\s+(\d+)/);
    if (!match) return { rxBytes: 0, txBytes: 0 };
    return { rxBytes: Number(match[1]), txBytes: Number(match[2]) };
  }

  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('netstat', ['-ib']);
    let rxBytes = 0;
    let txBytes = 0;
    const seen = new Set<string>();
    for (const line of stdout.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const name = cols[0];
      if (name === 'lo0' || seen.has(name)) continue;
      seen.add(name);
      const ibytes = Number(cols[6]);
      const obytes = Number(cols[9]);
      if (Number.isFinite(ibytes)) rxBytes += ibytes;
      if (Number.isFinite(obytes)) txBytes += obytes;
    }
    return { rxBytes, txBytes };
  }

  const data = await readFile('/proc/net/dev', 'utf-8');
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of data.split('\n').slice(2)) {
    const [ifacePart, rest] = line.split(':');
    if (!ifacePart || !rest) continue;
    if (ifacePart.trim() === 'lo') continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    rxBytes += fields[0] ?? 0;
    txBytes += fields[8] ?? 0;
  }
  return { rxBytes, txBytes };
}

interface NetSnapshot extends NetTotals {
  timestamp: number;
}

let lastNetSnapshot: NetSnapshot | null = null;

async function sampleNetworkRates(): Promise<
  Pick<SystemStatsSample, 'netRxBytesPerSec' | 'netTxBytesPerSec'>
> {
  const totals = await readNetTotals();
  const timestamp = Date.now();
  const previous = lastNetSnapshot;
  lastNetSnapshot = { ...totals, timestamp };
  if (!previous) return { netRxBytesPerSec: 0, netTxBytesPerSec: 0 };

  const elapsedSec = (timestamp - previous.timestamp) / 1000;
  if (elapsedSec <= 0) return { netRxBytesPerSec: 0, netTxBytesPerSec: 0 };

  return {
    // Counters can dip on interface resets; clamp instead of showing a
    // negative rate.
    netRxBytesPerSec: Math.max(0, (totals.rxBytes - previous.rxBytes) / elapsedSec),
    netTxBytesPerSec: Math.max(0, (totals.txBytes - previous.txBytes) / elapsedSec),
  };
}

const cpuModel = readCpuModel();
const cpuArch = readCpuArch();

const TOP_APPS_LIMIT = 10;
const IGNORED_PROCESS_NAMES = new Set(['idle', '_total', 'system idle process', '(idle)']);

interface ProcessCpuSnapshot {
  pid: number;
  name: string;
  cpuTimeSec: number;
  memBytes: number;
}

interface CpuProcessSampleState {
  at: number;
  processes: ProcessCpuSnapshot[];
}

let lastCpuProcessSample: CpuProcessSampleState | null = null;

function cleanProcessName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const noPath = basename(trimmed.replace(/\\/g, '/'));
  return noPath.replace(/#\d+$/, '').replace(/\.exe$/i, '');
}

function aggregateTopApps(
  rows: {
    pid: number;
    name: string;
    percent: number;
    memBytes?: number;
    rateBytesPerSec?: number;
  }[],
  sortBy: 'percent' | 'mem' | 'rate' = 'percent',
): TopResourceApp[] {
  const byName = new Map<
    string,
    {
      name: string;
      pid: number;
      percent: number;
      processCount: number;
      memBytes?: number;
      rateBytesPerSec?: number;
      maxWeight: number;
    }
  >();
  for (const row of rows) {
    const name = cleanProcessName(row.name);
    if (!name || IGNORED_PROCESS_NAMES.has(name.toLowerCase())) continue;
    if (!Number.isFinite(row.percent) && row.memBytes == null && row.rateBytesPerSec == null) {
      continue;
    }
    const key = name.toLowerCase();
    const percent = Number.isFinite(row.percent) ? Math.max(0, row.percent) : 0;
    const weight =
      sortBy === 'mem'
        ? (row.memBytes ?? 0)
        : sortBy === 'rate'
          ? (row.rateBytesPerSec ?? 0)
          : percent;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        name,
        pid: row.pid,
        percent,
        processCount: 1,
        memBytes: row.memBytes,
        rateBytesPerSec: row.rateBytesPerSec,
        maxWeight: weight,
      });
      continue;
    }
    existing.percent += percent;
    existing.processCount += 1;
    if (row.memBytes != null) existing.memBytes = (existing.memBytes ?? 0) + row.memBytes;
    if (row.rateBytesPerSec != null) {
      existing.rateBytesPerSec = (existing.rateBytesPerSec ?? 0) + row.rateBytesPerSec;
    }
    if (weight >= existing.maxWeight) {
      existing.pid = row.pid;
      existing.maxWeight = weight;
    }
  }
  const list = [...byName.values()].filter((a) => {
    if (sortBy === 'mem') return (a.memBytes ?? 0) > 1024 * 1024;
    if (sortBy === 'rate') return (a.rateBytesPerSec ?? 0) > 1024;
    return a.percent >= 0.05 || (a.memBytes ?? 0) > 1024 * 1024;
  });
  list.sort((a, b) => {
    if (sortBy === 'mem') return (b.memBytes ?? 0) - (a.memBytes ?? 0);
    if (sortBy === 'rate') return (b.rateBytesPerSec ?? 0) - (a.rateBytesPerSec ?? 0);
    return b.percent - a.percent || (b.memBytes ?? 0) - (a.memBytes ?? 0);
  });
  return list.slice(0, TOP_APPS_LIMIT).map(({ maxWeight: _maxWeight, ...app }) => app);
}

const iconCache = new Map<string, string>();

function isSafePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid < 2 ** 32;
}

async function exePathForPid(pid: number): Promise<string | undefined> {
  if (!isSafePid(pid)) return undefined;
  try {
    if (process.platform === 'win32') {
      const parsed = await runPowerShellJson<{ path?: string | null }>(
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.Path) { @{ path = $p.Path } | ConvertTo-Json -Compress } else { '{}' }`,
      );
      return parsed?.path || undefined;
    }
    if (process.platform === 'linux') {
      return await readlink(`/proc/${pid}/exe`);
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
      timeout: 2000,
    });
    const comm = stdout.trim();
    return comm.startsWith('/') ? comm : undefined;
  } catch {
    return undefined;
  }
}

async function iconForPath(exePath: string): Promise<string | undefined> {
  const key = exePath.toLowerCase();
  const cached = iconCache.get(key);
  if (cached) return cached;
  try {
    const image = await app.getFileIcon(exePath, { size: 'small' });
    const url = image.toDataURL();
    iconCache.set(key, url);
    return url;
  } catch {
    return undefined;
  }
}

async function withAppIcons(apps: TopResourceApp[]): Promise<TopResourceApp[]> {
  return Promise.all(
    apps.map(async (app) => {
      const exePath = await exePathForPid(app.pid);
      const iconDataUrl = exePath ? await iconForPath(exePath) : undefined;
      return iconDataUrl ? { ...app, iconDataUrl } : app;
    }),
  );
}

const WIN_CPU_PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Process | ForEach-Object {
  $cpuTime = 0
  try { if ($null -ne $_.CPU) { $cpuTime = [double]$_.CPU } } catch {}
  [PSCustomObject]@{
    pid = $_.Id
    name = $_.ProcessName
    cpuTime = $cpuTime
    memBytes = [int64]$_.WorkingSet64
  }
} | ConvertTo-Json -Compress
`;

async function readWindowsCpuProcesses(): Promise<ProcessCpuSnapshot[]> {
  const parsed =
    await runPowerShellJson<{ pid: number; name: string; cpuTime: number; memBytes: number }[]>(
      WIN_CPU_PROCESS_SCRIPT,
    );
  return asArray(parsed)
    .filter((row) => Number.isFinite(row.pid) && row.name)
    .map((row) => ({
      pid: row.pid,
      name: row.name,
      cpuTimeSec: Number(row.cpuTime) || 0,
      memBytes: Number(row.memBytes) || 0,
    }));
}

async function readLinuxCpuProcesses(): Promise<ProcessCpuSnapshot[]> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return [];
  }
  const results: ProcessCpuSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, 'utf8');
      const open = raw.indexOf('(');
      const close = raw.lastIndexOf(')');
      if (open < 0 || close < 0) continue;
      const rest = raw.slice(close + 2).split(' ');
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      const rssPages = Number(rest[21]);
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;
      results.push({
        pid: Number(name),
        name: raw.slice(open + 1, close),
        // /proc clock ticks are 100 Hz on every distro we care about.
        cpuTimeSec: (utime + stime) / 100,
        memBytes: Number.isFinite(rssPages) ? rssPages * 4096 : 0,
      });
    } catch {
      // Process exited between readdir and read.
    }
  }
  return results;
}

async function readDarwinCpuProcesses(): Promise<ProcessCpuSnapshot[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pcpu=,rss=,comm='], {
      timeout: 5000,
    });
    const ncpu = os.cpus().length || 1;
    const rows: ProcessCpuSnapshot[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      rows.push({
        pid: Number(match[1]),
        name: match[4],
        // ps %cpu is already a rate, not a cumulative time. Stash it in
        // cpuTimeSec so percentsFromCpuDelta can pass it through as-is.
        cpuTimeSec: Number(match[2]) / ncpu,
        memBytes: Number(match[3]) * 1024,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function percentsFromCpuDelta(
  previous: CpuProcessSampleState,
  current: CpuProcessSampleState,
): { pid: number; name: string; percent: number; memBytes: number }[] {
  // macOS ps already reports a rate; we store that rate in cpuTimeSec and
  // skip the delta (elapsed is unused, previous is ignored).
  if (process.platform === 'darwin') {
    return current.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      percent: p.cpuTimeSec,
      memBytes: p.memBytes,
    }));
  }

  const elapsedSec = (current.at - previous.at) / 1000;
  if (elapsedSec <= 0) return [];
  const ncpu = os.cpus().length || 1;
  const prevByPid = new Map(previous.processes.map((p) => [p.pid, p]));
  const rows: { pid: number; name: string; percent: number; memBytes: number }[] = [];
  for (const proc of current.processes) {
    const prev = prevByPid.get(proc.pid);
    if (!prev) continue;
    const deltaSec = proc.cpuTimeSec - prev.cpuTimeSec;
    if (deltaSec < 0) continue;
    rows.push({
      pid: proc.pid,
      name: proc.name,
      percent: (deltaSec / elapsedSec / ncpu) * 100,
      memBytes: proc.memBytes,
    });
  }
  return rows;
}

async function readCpuProcessSnapshot(): Promise<ProcessCpuSnapshot[]> {
  if (process.platform === 'win32') return readWindowsCpuProcesses();
  if (process.platform === 'linux') return readLinuxCpuProcesses();
  if (process.platform === 'darwin') return readDarwinCpuProcesses();
  return [];
}

async function sampleTopCpuApps(): Promise<TopResourceAppsResult> {
  const processes = await readCpuProcessSnapshot();
  if (processes.length === 0) return { apps: [], available: false };

  const current: CpuProcessSampleState = { at: Date.now(), processes };
  let previous = lastCpuProcessSample;
  lastCpuProcessSample = current;

  // First open has no delta yet. Wait a beat and sample again so the dialog
  // isn't empty on the first paint.
  if (!previous || (process.platform !== 'darwin' && current.at - previous.at > 15_000)) {
    if (process.platform !== 'darwin') {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const second = await readCpuProcessSnapshot();
      const next: CpuProcessSampleState = { at: Date.now(), processes: second };
      previous = current;
      lastCpuProcessSample = next;
      return {
        apps: await withAppIcons(aggregateTopApps(percentsFromCpuDelta(previous, next))),
        available: true,
      };
    }
  }

  if (!previous) {
    return {
      apps: await withAppIcons(aggregateTopApps(percentsFromCpuDelta(current, current))),
      available: true,
    };
  }
  return {
    apps: await withAppIcons(aggregateTopApps(percentsFromCpuDelta(previous, current))),
    available: true,
  };
}

const WIN_GPU_PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$byPid = @{}
$engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
foreach ($e in $engines) {
  if ($e.Name -match 'pid_(\\d+)_') {
    $procId = [int]$Matches[1]
    $util = [double]$e.UtilizationPercentage
    if (-not $byPid.ContainsKey($procId) -or $util -gt $byPid[$procId]) {
      $byPid[$procId] = $util
    }
  }
}
$memByPid = @{}
$mems = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory
foreach ($m in $mems) {
  if ($m.Name -match 'pid_(\\d+)_') {
    $procId = [int]$Matches[1]
    $used = [int64]$m.DedicatedUsage
    if ($used -le 0) { $used = [int64]$m.SharedUsage }
    if (-not $memByPid.ContainsKey($procId) -or $used -gt $memByPid[$procId]) {
      $memByPid[$procId] = $used
    }
  }
}
$ids = @($byPid.Keys) + @($memByPid.Keys) | Select-Object -Unique
$rows = @()
foreach ($procId in $ids) {
  if ($procId -le 0) { continue }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { "pid $procId" }
  $percent = 0
  if ($byPid.ContainsKey($procId)) { $percent = [math]::Round($byPid[$procId], 1) }
  $memBytes = 0
  if ($memByPid.ContainsKey($procId)) { $memBytes = [int64]$memByPid[$procId] }
  $rows += [PSCustomObject]@{ pid = $procId; name = $name; percent = $percent; memBytes = $memBytes }
}
if ($rows.Count -eq 0) { Write-Output '[]'; exit }
@($rows) | ConvertTo-Json -Compress
`;

async function sampleWindowsGpuApps(): Promise<{
  rows: { pid: number; name: string; percent: number; memBytes?: number }[];
  queried: boolean;
}> {
  if (process.platform !== 'win32') return { rows: [], queried: false };
  const parsed =
    await runPowerShellJson<{ pid: number; name: string; percent: number; memBytes: number }[]>(
      WIN_GPU_PROCESS_SCRIPT,
    );
  if (parsed == null) return { rows: [], queried: false };
  return {
    rows: asArray(parsed).filter((row) => Number.isFinite(row.pid)),
    queried: true,
  };
}

async function sampleNvidiaGpuApps(): Promise<{
  rows: { pid: number; name: string; percent: number; memBytes?: number }[];
  queried: boolean;
}> {
  const byPid = new Map<
    number,
    { pid: number; name: string; percent: number; memBytes?: number }
  >();
  let queried = false;

  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
    );
    queried = true;
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [pidRaw, name, memRaw] = line.split(',').map((v) => v.trim());
      const pid = Number(pidRaw);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const memMb = Number(memRaw);
      byPid.set(pid, {
        pid,
        name: name || `pid ${pid}`,
        percent: 0,
        memBytes: Number.isFinite(memMb) ? memMb * 1024 * 1024 : undefined,
      });
    }
  } catch {
    // No NVIDIA driver, or no compute apps.
  }

  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['pmon', '-c', '1'], {
      timeout: 5000,
      windowsHide: true,
    });
    queried = true;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cols = trimmed.split(/\s+/);
      if (cols.length < 8) continue;
      const pid = Number(cols[1]);
      const sm = cols[3] === '-' ? 0 : Number(cols[3]);
      const command = cols.slice(7).join(' ');
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const existing = byPid.get(pid);
      const percent = Number.isFinite(sm) ? sm : 0;
      if (existing) {
        existing.percent = Math.max(existing.percent, percent);
        if (command && existing.name.startsWith('pid ')) existing.name = command;
      } else {
        byPid.set(pid, { pid, name: command || `pid ${pid}`, percent });
      }
    }
  } catch {
    // pmon isn't available on every driver build.
  }

  return { rows: [...byPid.values()], queried };
}

function mergeGpuAppRows(
  groups: { pid: number; name: string; percent: number; memBytes?: number }[][],
): { pid: number; name: string; percent: number; memBytes?: number }[] {
  const byPid = new Map<
    number,
    { pid: number; name: string; percent: number; memBytes?: number }
  >();
  for (const group of groups) {
    for (const row of group) {
      const existing = byPid.get(row.pid);
      if (!existing) {
        byPid.set(row.pid, { ...row });
        continue;
      }
      existing.percent = Math.max(existing.percent, row.percent);
      if (row.memBytes != null) {
        existing.memBytes = Math.max(existing.memBytes ?? 0, row.memBytes);
      }
      if (existing.name.startsWith('pid ') && row.name && !row.name.startsWith('pid ')) {
        existing.name = row.name;
      }
    }
  }
  return [...byPid.values()];
}

async function sampleTopGpuApps(): Promise<TopResourceAppsResult> {
  const [nvidia, windows] = await Promise.all([sampleNvidiaGpuApps(), sampleWindowsGpuApps()]);
  const merged = mergeGpuAppRows([nvidia.rows, windows.rows]);
  return {
    apps: await withAppIcons(aggregateTopApps(merged)),
    available: nvidia.queried || windows.queried,
  };
}

async function sampleTopMemoryApps(): Promise<TopResourceAppsResult> {
  const processes = await readCpuProcessSnapshot();
  if (processes.length === 0) return { apps: [], available: false };
  const total = os.totalmem();
  const rows = processes.map((p) => ({
    pid: p.pid,
    name: p.name,
    percent: total > 0 ? (p.memBytes / total) * 100 : 0,
    memBytes: p.memBytes,
  }));
  return { apps: await withAppIcons(aggregateTopApps(rows, 'mem')), available: true };
}

const WIN_DISK_PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' -and $_.IDProcess -gt 0 } |
  ForEach-Object {
    [PSCustomObject]@{
      pid = $_.IDProcess
      name = $_.Name
      rate = [int64]$_.IODataBytesPersec
    }
  } | ConvertTo-Json -Compress
`;

interface DiskProcessSnapshot {
  pid: number;
  name: string;
  ioBytes: number;
}

interface DiskProcessSampleState {
  at: number;
  processes: DiskProcessSnapshot[];
}

let lastDiskProcessSample: DiskProcessSampleState | null = null;

async function readLinuxDiskProcesses(): Promise<DiskProcessSnapshot[]> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return [];
  }
  const results: DiskProcessSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const [statRaw, ioRaw] = await Promise.all([
        readFile(`/proc/${name}/stat`, 'utf8'),
        readFile(`/proc/${name}/io`, 'utf8'),
      ]);
      const open = statRaw.indexOf('(');
      const close = statRaw.lastIndexOf(')');
      if (open < 0 || close < 0) continue;
      let readBytes = 0;
      let writeBytes = 0;
      for (const line of ioRaw.split('\n')) {
        if (line.startsWith('read_bytes:')) readBytes = Number(line.slice(11).trim());
        if (line.startsWith('write_bytes:')) writeBytes = Number(line.slice(12).trim());
      }
      results.push({
        pid: Number(name),
        name: statRaw.slice(open + 1, close),
        ioBytes:
          (Number.isFinite(readBytes) ? readBytes : 0) +
          (Number.isFinite(writeBytes) ? writeBytes : 0),
      });
    } catch {
      // Process exited between readdir and read.
    }
  }
  return results;
}

async function sampleTopDiskApps(): Promise<TopResourceAppsResult> {
  if (process.platform === 'win32') {
    const parsed =
      await runPowerShellJson<{ pid: number; name: string; rate: number }[]>(
        WIN_DISK_PROCESS_SCRIPT,
      );
    if (parsed == null) return { apps: [], available: false };
    const rows = asArray(parsed)
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0)
      .map((row) => ({
        pid: row.pid,
        name: row.name,
        percent: 0,
        rateBytesPerSec: Number(row.rate) || 0,
      }));
    return { apps: await withAppIcons(aggregateTopApps(rows, 'rate')), available: true };
  }

  if (process.platform === 'linux') {
    const processes = await readLinuxDiskProcesses();
    if (processes.length === 0) return { apps: [], available: false };
    const current: DiskProcessSampleState = { at: Date.now(), processes };
    let previous = lastDiskProcessSample;
    lastDiskProcessSample = current;
    if (!previous || current.at - previous.at > 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const second = await readLinuxDiskProcesses();
      const next: DiskProcessSampleState = { at: Date.now(), processes: second };
      previous = current;
      lastDiskProcessSample = next;
    }
    if (!previous) return { apps: [], available: true };
    const elapsedSec = (lastDiskProcessSample.at - previous.at) / 1000;
    if (elapsedSec <= 0) return { apps: [], available: true };
    const prevByPid = new Map(previous.processes.map((p) => [p.pid, p]));
    const currentSample = lastDiskProcessSample;
    const rows = currentSample.processes.flatMap((proc) => {
      const prev = prevByPid.get(proc.pid);
      if (!prev) return [];
      const delta = proc.ioBytes - prev.ioBytes;
      if (delta < 0) return [];
      return [
        {
          pid: proc.pid,
          name: proc.name,
          percent: 0,
          rateBytesPerSec: delta / elapsedSec,
        },
      ];
    });
    return { apps: await withAppIcons(aggregateTopApps(rows, 'rate')), available: true };
  }

  return { apps: [], available: false };
}

async function killProcess(pid: number): Promise<KillProcessResult> {
  if (!isSafePid(pid)) return { ok: false, error: 'That process id is not valid.' };
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 8000,
        windowsHide: true,
      });
      return { ok: true };
    }
    process.kill(pid, 'SIGTERM');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not end that process.';
    return { ok: false, error: message };
  }
}

/**
 * Disk, GPU and temperature readings each start a PowerShell process on Windows, which costs real CPU and time.
 * The bar samples every few seconds, so these are reused for a while and never run twice at once.
 */
const SLOW_PROBE_TTL_MS = 10_000;

function cachedProbe<T>(probe: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (value !== undefined && Date.now() - at < SLOW_PROBE_TTL_MS) return Promise.resolve(value);
    inFlight ??= probe()
      .then((fresh) => {
        value = fresh;
        at = Date.now();
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/**
 * Like cachedProbe, but the caller never waits: it gets the last reading (or `fallback` before the
 * first one lands) while a stale or missing one is fetched in the background.
 */
function backgroundProbe<T>(probe: () => Promise<T>, fallback: T): () => T {
  const cached = cachedProbe(probe);
  let latest = fallback;
  return () => {
    cached().then(
      (fresh) => {
        latest = fresh;
      },
      // A failed reading keeps the last one. The next call tries again.
      () => undefined,
    );
    return latest;
  };
}

const sampleDisksCached = cachedProbe(sampleDisks);
const sampleGpusCached = cachedProbe(sampleGpus);
// The third PowerShell process on Windows. Its first run must not hold up the first sample.
const sampleCpuTemperatureCached = backgroundProbe<CpuTemperature>(sampleCpuTemperature, {
  cpuTempC: null,
  cpuThermalState: null,
});

export function registerSystemStatsHandlers(): void {
  ipcMain.handle(IPC.system.topApps, async (_event, resource: TopResourceKind) => {
    if (resource === 'gpu') return sampleTopGpuApps();
    if (resource === 'cpu') return sampleTopCpuApps();
    if (resource === 'memory') return sampleTopMemoryApps();
    if (resource === 'disk') return sampleTopDiskApps();
    return { apps: [], available: false };
  });

  ipcMain.handle(IPC.system.killProcess, async (_event, pid: number) => killProcess(pid));

  ipcMain.handle(IPC.system.sample, async (): Promise<SystemStatsSample> => {
    const settings = await store.getSettings();
    const temperature = sampleCpuTemperatureCached();
    const [net, pings, disks, gpus, cpu, memory] = await Promise.all([
      sampleNetworkRates(),
      probeAll(settings),
      sampleDisksCached(),
      sampleGpusCached(),
      sampleCpu(),
      sampleMemory(),
    ]);
    return {
      timestamp: Date.now(),
      cpuModel,
      cpuCoreCount: cpu.cpuCorePercents.length,
      cpuArch,
      ...temperature,
      cpuPercent: cpu.cpuPercent,
      cpuCorePercents: cpu.cpuCorePercents,
      ...memory,
      disks,
      gpus,
      ...net,
      pings,
    };
  });
}
