import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type {
  RunnerMachineLink,
  RunnerMachineSample,
  RunnerMachineStatsResult,
} from '../../shared/apiTypes';
import type { SshLease } from '../ssh/pool';
import { findSavedServer } from '../ssh/savedServers';
import { getSshPool } from '../ssh/sharedPool';
import { sampleMemory } from '../system/memoryStats';
import {
  POSIX_PROBE,
  parsePosixProbe,
  parseWindowsProbe,
  WINDOWS_PROBE,
} from './runnerMachineProbe';

/**
 * CPU, memory and disk of the machine a self-hosted runner runs on, for its tile on the Pipelines
 * page. GitHub says nothing about a runner's load, so this asks the machine itself: over the saved
 * server's pooled SSH connection, or straight from this computer. The page polls every 15 s, well
 * inside the pool's idle window, so the connection stays open between readings.
 */

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

type ProbeKind = 'posix' | 'windows';

export interface RunnerMachineStatsDeps {
  /** Throws when the saved server is gone. */
  findServer: (serverId: string) => Promise<unknown>;
  acquire: (serverId: string) => Promise<Pick<SshLease, 'connection' | 'release'>>;
  readLocal: () => Promise<RunnerMachineSample>;
  now: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVaultLocked(error: unknown): boolean {
  return (error as Error | null)?.name === 'VaultLockedError';
}

export function createRunnerMachineStats(deps: RunnerMachineStatsDeps) {
  /** Which probe worked last time per server, so a Windows runner does not try `sh` every poll. */
  const probeKinds = new Map<string, ProbeKind>();
  /** One reading in flight per machine: a second panel or a quick refresh shares it. */
  const inFlight = new Map<string, Promise<RunnerMachineStatsResult>>();

  async function probe(
    lease: Pick<SshLease, 'connection'>,
    kind: ProbeKind,
  ): Promise<RunnerMachineSample | null> {
    const command = kind === 'posix' ? POSIX_PROBE : WINDOWS_PROBE;
    const result = await lease.connection.exec(command, {
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.timedOut) throw new Error('The machine took too long to answer.');
    const at = deps.now();
    return kind === 'posix'
      ? parsePosixProbe(result.stdout, at)
      : parseWindowsProbe(result.stdout, at);
  }

  async function readSsh(serverId: string): Promise<RunnerMachineStatsResult> {
    try {
      await deps.findServer(serverId);
    } catch {
      return { ok: false, reason: 'missing', error: 'This saved server no longer exists.' };
    }
    let lease: Pick<SshLease, 'connection' | 'release'>;
    try {
      lease = await deps.acquire(serverId);
    } catch (error) {
      if (isVaultLocked(error)) return { ok: false, reason: 'locked', error: errorMessage(error) };
      return { ok: false, reason: 'unreachable', error: errorMessage(error) };
    }
    try {
      // A Windows machine without `sh` (or with Git's `sh`, which says MINGW) fails the POSIX
      // probe, so whichever answered last time goes first.
      const known = probeKinds.get(serverId);
      const order: ProbeKind[] = known === 'windows' ? ['windows', 'posix'] : ['posix', 'windows'];
      for (const kind of order) {
        const sample = await probe(lease, kind);
        if (sample) {
          probeKinds.set(serverId, kind);
          return { ok: true, sample };
        }
      }
      return {
        ok: false,
        reason: 'unsupported',
        error: 'The machine did not answer like Linux, macOS or Windows.',
      };
    } catch (error) {
      return { ok: false, reason: 'unreachable', error: errorMessage(error) };
    } finally {
      lease.release();
    }
  }

  async function readLocal(): Promise<RunnerMachineStatsResult> {
    try {
      return { ok: true, sample: await deps.readLocal() };
    } catch (error) {
      return { ok: false, reason: 'unsupported', error: errorMessage(error) };
    }
  }

  return function read(link: RunnerMachineLink): Promise<RunnerMachineStatsResult> {
    const key = link.kind === 'local' ? 'local' : `ssh:${link.serverId}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const next = (link.kind === 'local' ? readLocal() : readSsh(link.serverId)).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, next);
    return next;
  };
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

let lastLocalCpu: { busy: number; total: number } | null = null;

/**
 * The share of CPU used since the previous local reading. The first reading has nothing to compare
 * with, so it takes its own baseline half a second earlier instead of showing nothing for a poll.
 */
async function localCpuPercent(): Promise<number | null> {
  if (!lastLocalCpu) {
    lastLocalCpu = cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const current = cpuTimes();
  const previous = lastLocalCpu;
  lastLocalCpu = current;
  const total = current.total - previous.total;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, ((current.busy - previous.busy) / total) * 100));
}

function systemRoot(): string {
  if (process.platform !== 'win32') return '/';
  return `${process.env.SystemDrive ?? 'C:'}\\`;
}

async function readLocalSample(): Promise<RunnerMachineSample> {
  const root = systemRoot();
  const [cpuPercent, memory, disk] = await Promise.all([
    localCpuPercent(),
    sampleMemory(),
    statfs(root),
  ]);
  const usedBytes = (disk.blocks - disk.bfree) * disk.bsize;
  const [load1] = os.loadavg();
  return {
    at: Date.now(),
    cpuPercent,
    cpuCount: os.cpus().length || null,
    // Windows reports zeros here rather than nothing.
    load1: process.platform === 'win32' ? null : load1,
    memUsedBytes: memory.memUsedBytes,
    memTotalBytes: memory.memTotalBytes,
    diskUsedBytes: usedBytes,
    diskTotalBytes: usedBytes + disk.bavail * disk.bsize,
    diskMount: process.platform === 'win32' ? root.slice(0, -1) : root,
  };
}

export const readRunnerMachineStats = createRunnerMachineStats({
  findServer: findSavedServer,
  acquire: (serverId) => getSshPool().acquire(serverId),
  readLocal: readLocalSample,
  now: Date.now,
});
