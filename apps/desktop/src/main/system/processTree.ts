import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
  type ProcessRow,
  type ProcessSample,
  type ProcessTreeUsage,
  parseProcStat,
  selectPreviousSample,
  summarizeProcessTrees,
} from '@agentmat/core';

const execFileAsync = promisify(execFile);

export function asArray<T>(parsed: T | T[] | null | undefined): T[] {
  if (parsed == null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function runPowerShellJson<T>(script: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return null;
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

// Get-Process has no parent pid, so the tree needs CIM. Kernel and user times are in 100ns.
const WIN_PROCESS_TREE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object {
  $started = 0
  if ($_.CreationDate) { $started = $_.CreationDate.ToFileTimeUtc() }
  [PSCustomObject]@{
    pid = [int64]$_.ProcessId
    ppid = [int64]$_.ParentProcessId
    name = $_.Name
    cpu = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000
    mem = [int64]$_.WorkingSetSize
    started = [int64]$started
  }
} | ConvertTo-Json -Compress
`;

async function readWindowsProcesses(): Promise<ProcessRow[]> {
  const parsed =
    await runPowerShellJson<
      { pid: number; ppid: number; name: string; cpu: number; mem: number; started: number }[]
    >(WIN_PROCESS_TREE_SCRIPT);
  return asArray(parsed)
    .filter((row) => Number.isFinite(row.pid))
    .map((row) => ({
      pid: row.pid,
      ppid: Number(row.ppid) || 0,
      name: (row.name ?? '').replace(/\.exe$/i, ''),
      cpuTimeSec: Number(row.cpu) || 0,
      memBytes: Number(row.mem) || 0,
      startedAt: row.started ? Number(row.started) : undefined,
    }));
}

async function readLinuxProcesses(): Promise<ProcessRow[]> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          return parseProcStat(await readFile(`/proc/${name}/stat`, 'utf8'));
        } catch {
          // The process exited between readdir and read.
          return null;
        }
      }),
  );
  return rows.filter((row): row is ProcessRow => row !== null);
}

async function readDarwinProcesses(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], {
      timeout: 5000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const ncpu = os.cpus().length || 1;
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        name: basename(match[5] ?? ''),
        // ps %cpu is a rate of one core; summarizeProcessTrees passes it through as-is.
        cpuTimeSec: Number(match[3]) / ncpu,
        memBytes: Number(match[4]) * 1024,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Every process on the machine, read the way this platform allows. Empty when it cannot. */
export function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return readWindowsProcesses();
  if (process.platform === 'linux') return readLinuxProcesses();
  if (process.platform === 'darwin') return readDarwinProcesses();
  return Promise.resolve([]);
}

export interface ProcessTreeSample {
  /** False when the OS process list could not be read at all. */
  available: boolean;
  /** False on the first sample (or after a long gap), when CPU has nothing to compare against. */
  cpuReady: boolean;
  trees: Map<number, ProcessTreeUsage>;
}

/** Older than this, the last sample is too stale to average CPU over. */
const DEFAULT_MAX_SAMPLE_GAP_MS = 15_000;

interface SamplePair {
  current: ProcessSample;
  /** The shared sample taken before this one, whoever asked for it. */
  last: ProcessSample | null;
}

let lastSample: ProcessSample | null = null;
let inflight: Promise<SamplePair | null> | null = null;
/** Private baselines for callers that need a longer averaging window than the shared one. */
const baselines = new Map<string, ProcessSample>();

/** Reads the process list once, sharing the read between callers that ask at the same time. */
function takeSample(): Promise<SamplePair | null> {
  inflight ??= listProcesses()
    .then((processes) => {
      if (processes.length === 0) return null;
      const current: ProcessSample = { at: Date.now(), processes };
      const last = lastSample;
      lastSample = current;
      return { current, last };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface SampleProcessTreesOptions {
  /** The longest gap to a previous sample that CPU is still averaged over. Default 15 seconds. */
  maxGapMs?: number;
  /**
   * Names a private baseline. Without it CPU is measured against whichever caller read the
   * process list last, which is only a few seconds back while the Android meters are open. With
   * it the window is the time since this same caller last asked, however busy the others are.
   */
  baseline?: string;
}

/** CPU and memory for each shell pid, counting every process it started. */
export async function sampleProcessTrees(
  rootPids: number[],
  options: SampleProcessTreesOptions = {},
): Promise<ProcessTreeSample> {
  const pair = await takeSample();
  if (!pair) return { available: false, cpuReady: false, trees: new Map() };
  const { current } = pair;
  const prior = options.baseline ? (baselines.get(options.baseline) ?? null) : pair.last;
  const previous = selectPreviousSample(
    prior,
    current.at,
    options.maxGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS,
  );
  if (options.baseline) baselines.set(options.baseline, current);
  const cpuIsRate = process.platform === 'darwin';

  return {
    available: true,
    cpuReady: cpuIsRate || previous !== null,
    trees: summarizeProcessTrees(rootPids, current, previous, {
      cpuCount: os.cpus().length || 1,
      cpuIsRate,
    }),
  };
}
