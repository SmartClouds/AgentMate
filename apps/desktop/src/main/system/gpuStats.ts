import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { GpuUsage } from '../../shared/apiTypes';

const execFileAsync = promisify(execFile);

async function sampleNvidiaGpus(): Promise<GpuUsage[]> {
  try {
    // NVIDIA is the only vendor that exposes live utilization through a
    // standard CLI; other vendors are covered separately by sampleOtherGpu
    // (Windows) and sampleMacGpus (macOS).
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ]);
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [index, name, util, memUsed, memTotal, temp] = line.split(',').map((v) => v.trim());
        // Data center and some laptop GPUs answer "[N/A]" or "[Not Supported]" here.
        const tempC = temp ? Number(temp) : Number.NaN;
        return {
          id: `nvidia-${index}`,
          label: name,
          percent: Number(util),
          memUsedBytes: Number(memUsed) * 1024 * 1024,
          memTotalBytes: Number(memTotal) * 1024 * 1024,
          tempC: Number.isFinite(tempC) ? tempC : null,
        };
      })
      .filter((g) => Number.isFinite(g.percent));
  } catch {
    return [];
  }
}

// Best-effort coverage for the non-NVIDIA GPU (typically a laptop's
// integrated Intel/AMD chip) using Windows' GPU performance counters.
// Windows has no safe/simple way to attribute a specific "GPU Engine"
// counter instance to a specific physical adapter (that requires DXGI's
// IDXGIAdapter::GetDesc via native COM interop), so this reports the
// busiest engine across the whole system as this GPU's usage. It's
// usually accurate, but can occasionally reflect the NVIDIA GPU's load
// instead when that GPU is the one actually busy (e.g. during gaming).
const OTHER_GPU_SCRIPT = `
$others = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterCompatibility -notmatch 'NVIDIA' -and $_.Name -notmatch 'NVIDIA' }
if (-not $others) { Write-Output '[]'; exit }
$engine = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
$busiest = 0
if ($engine) {
  $groups = $engine | Group-Object { $_.Name -replace '^pid_\\d+_', '' }
  foreach ($g in $groups) {
    $sum = ($g.Group | Measure-Object -Property UtilizationPercentage -Sum).Sum
    if ($sum -gt $busiest) { $busiest = $sum }
  }
}
$mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue
$memUsed = 0
if ($mem) { $memUsed = ($mem | Measure-Object -Property SharedUsage -Maximum).Maximum }
$c = $others | Select-Object -First 1
[PSCustomObject]@{ name = $c.Name; ram = [int64]$c.AdapterRAM; percent = [math]::Round($busiest, 1); memUsed = [int64]$memUsed } | ConvertTo-Json -Compress
`;

async function sampleOtherGpu(): Promise<GpuUsage[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      OTHER_GPU_SCRIPT,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return [];
    const parsed = JSON.parse(trimmed) as {
      name: string;
      ram: number;
      percent: number;
      memUsed: number;
    };
    return [
      {
        id: 'other-gpu',
        label: parsed.name,
        percent: Math.max(0, Math.min(100, parsed.percent)),
        memUsedBytes: parsed.memUsed,
        memTotalBytes: parsed.ram > 0 ? parsed.ram : parsed.memUsed,
        // Windows has no vendor-neutral GPU temperature counter.
        tempC: null,
      },
    ];
  } catch {
    return [];
  }
}

/** One GPU as macOS describes it in the IORegistry, before it is turned into a dashboard row. */
export interface MacAccelerator {
  /** IOKit class, e.g. `AGXAcceleratorG16G` on Apple Silicon. */
  ioClass: string;
  /** Marketing name when the registry has one, e.g. `Apple M4`. */
  model?: string;
  /** The numeric entries of the `PerformanceStatistics` dictionary. */
  stats: Record<string, number>;
}

// Every GPU on a Mac, Apple Silicon included, registers an IOAccelerator service that publishes
// live counters in a `PerformanceStatistics` dictionary. `ioreg` prints it without sudo, unlike
// `powermetrics`, and its keys are the ones Activity Monitor's GPU History reads:
//
//   +-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x1000004f2, registered, ...>
//     {
//       "model" = "Apple M4"
//       "PerformanceStatistics" = {"Device Utilization %"=12,"In use system memory"=482344960,...}
//     }
const IOREG_ACCELERATOR_ARGS = ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'];

/** Pulls every accelerator that has a PerformanceStatistics dictionary out of `ioreg` output. */
export function parseIoregAccelerators(stdout: string): MacAccelerator[] {
  const accelerators: MacAccelerator[] = [];
  // Each registry entry starts at a "+-o ClassName" line, nested ones behind "| " guides.
  for (const block of stdout.split(/^[ |]*\+-o /m).slice(1)) {
    const dict = block.match(/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/);
    if (!dict) continue;
    const stats: Record<string, number> = {};
    for (const [, key, value] of dict[1].matchAll(/"([^"]+)"\s*=\s*(-?\d+(?:\.\d+)?)/g)) {
      stats[key] = Number(value);
    }
    accelerators.push({
      ioClass: block.match(/^\S+/)?.[0] ?? 'IOAccelerator',
      model: block.match(/"model"\s*=\s*"([^"]+)"/)?.[1],
      stats,
    });
  }
  return accelerators;
}

// Older GPU drivers publish the busy figure as "GPU Activity(%)" instead.
const UTILIZATION_KEYS = ['Device Utilization %', 'GPU Activity(%)'];

function macGpuLabel(accelerator: MacAccelerator): string {
  const { model, ioClass } = accelerator;
  if (!model) return ioClass.startsWith('AGX') ? 'Apple GPU' : ioClass;
  // "Apple M4" alone reads like the CPU in the legend, so name the GPU part of the chip.
  return /^Apple /.test(model) && !/gpu/i.test(model) ? `${model} GPU` : model;
}

/**
 * Turns parsed accelerators into dashboard rows. `unifiedMemoryBytes` is what the GPU shares with
 * the CPU (all of RAM on Apple Silicon and on Intel integrated graphics). A discrete card reports
 * its own VRAM instead.
 */
export function macAcceleratorsToGpus(
  accelerators: MacAccelerator[],
  unifiedMemoryBytes: number,
): GpuUsage[] {
  const gpus: GpuUsage[] = [];
  for (const accelerator of accelerators) {
    const utilKey = UTILIZATION_KEYS.find((key) => Number.isFinite(accelerator.stats[key]));
    if (!utilKey) continue;
    const { stats } = accelerator;
    const vramUsed = stats.vramUsedBytes;
    const vramFree = stats.vramFreeBytes;
    const hasVram = Number.isFinite(vramUsed) && Number.isFinite(vramFree);
    const memUsedBytes = hasVram ? vramUsed : (stats['In use system memory'] ?? 0);
    gpus.push({
      id: `mac-gpu-${gpus.length}`,
      label: macGpuLabel(accelerator),
      percent: Math.max(0, Math.min(100, stats[utilKey])),
      memUsedBytes,
      memTotalBytes: hasVram ? vramUsed + vramFree : Math.max(unifiedMemoryBytes, memUsedBytes),
      // The IORegistry has no GPU temperature, and powermetrics needs sudo.
      tempC: null,
    });
  }
  return gpus;
}

async function sampleMacGpus(): Promise<GpuUsage[]> {
  if (process.platform !== 'darwin') return [];
  try {
    // Absolute path: a GUI app's PATH is not guaranteed to include /usr/sbin.
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', IOREG_ACCELERATOR_ARGS, {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return macAcceleratorsToGpus(parseIoregAccelerators(stdout), os.totalmem());
  } catch {
    return [];
  }
}

export async function sampleGpus(): Promise<GpuUsage[]> {
  const [nvidia, other, mac] = await Promise.all([
    sampleNvidiaGpus(),
    sampleOtherGpu(),
    sampleMacGpus(),
  ]);
  return [...nvidia, ...other, ...mac];
}
