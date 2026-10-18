import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { descendantPids, type ProcessRow } from '@agentmat/core';
import { listProcesses } from './processTree';
import { callScript, compileScript, helperAssemblyPath } from './processSuspendWindows';

/**
 * Freezes a run's shell and everything it started, and thaws them again. Frozen processes use
 * no CPU and keep all their state, so a dev server picks up where it was, file changes included.
 *
 * Order matters on Linux and macOS: the shell is stopped first and continued last. An
 * interactive bash that sees its foreground job stop takes the terminal back and prints
 * "Stopped"; a stopped shell sees nothing, and by the time it wakes the job runs again.
 */

export interface TreeSignalFailure {
  pid: number;
  reason: string;
}

export interface TreeSignalResult {
  /** The processes it froze (or thawed), in the order it did them. */
  pids: number[];
  /** Their names, without `.exe`, in the same order. */
  names: string[];
  failed: TreeSignalFailure[];
}

export interface ProcessSuspender {
  /** Freezes `rootPid` and every process below it, parents first. */
  suspendTree(rootPid: number): Promise<TreeSignalResult>;
  /** Thaws processes frozen by `suspendTree`, given in the order it returned; goes in reverse. */
  resumePids(pids: readonly number[]): Promise<TreeSignalResult>;
  /** Gets ready for a first pause in the background (builds the Windows helper). */
  warm(): Promise<void>;
}

export interface ProcessSuspenderDeps {
  platform: NodeJS.Platform;
  listProcesses: () => Promise<ProcessRow[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs a script in Windows PowerShell and resolves with what it printed. */
  powershell: (script: string) => Promise<string>;
  /** Where the built Windows helper is kept. Without one it is compiled on every call. */
  helperDir: string | null;
  fileExists: (path: string) => boolean;
}

/** A frozen tree cannot start anything, so a few looks always settle; this only bounds a race. */
const SUSPEND_ROUNDS = 3;
const POWERSHELL_TIMEOUT_MS = 30_000;

function runPowerShell(script: string): Promise<string> {
  // Encoded, so the quotes and backslashes in the C# survive Windows argument quoting.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim().split(/\r?\n/)[0];
          reject(new Error(detail || error.message));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

function isPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function empty(): TreeSignalResult {
  return { pids: [], names: [], failed: [] };
}

function signalReason(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ESRCH') return null;
  if (code === 'EPERM') return 'access denied';
  return error instanceof Error ? error.message : String(error);
}

function parseHelperOutput(stdout: string): TreeSignalResult | null {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? '';
  try {
    const parsed = JSON.parse(line) as Partial<TreeSignalResult>;
    if (!Array.isArray(parsed.pids) || !Array.isArray(parsed.failed)) return null;
    const names = Array.isArray(parsed.names) ? parsed.names : [];
    return {
      pids: parsed.pids.filter(isPid),
      names: parsed.pids.map((_, i) => String(names[i] ?? '').replace(/\.exe$/i, '')),
      failed: parsed.failed
        .filter((f) => f && isPid(Number(f.pid)))
        .map((f) => ({ pid: Number(f.pid), reason: String(f.reason) })),
    };
  } catch {
    return null;
  }
}

export function createProcessSuspender(overrides: Partial<ProcessSuspenderDeps> = {}): ProcessSuspender {
  const deps: ProcessSuspenderDeps = {
    platform: process.platform,
    listProcesses,
    kill: (pid, signal) => process.kill(pid, signal),
    powershell: runPowerShell,
    helperDir: null,
    fileExists: existsSync,
    ...overrides,
  };

  // ---- Linux and macOS ----

  async function suspendPosix(rootPid: number): Promise<TreeSignalResult> {
    const result = empty();
    const handled = new Set<number>();
    for (let round = 0; round < SUSPEND_ROUNDS; round++) {
      const rows = await deps.listProcesses();
      const names = new Map(rows.map((row) => [row.pid, row.name]));
      const tree = descendantPids(rootPid, rows);
      if (round === 0 && tree.length === 0) {
        result.failed.push({ pid: rootPid, reason: 'not running' });
        break;
      }
      const fresh = tree.filter((pid) => !handled.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        handled.add(pid);
        try {
          deps.kill(pid, 'SIGSTOP');
          result.pids.push(pid);
          result.names.push(names.get(pid) ?? '');
        } catch (error) {
          const reason = signalReason(error);
          if (reason) result.failed.push({ pid, reason });
        }
      }
    }
    return result;
  }

  async function resumePosix(pids: number[]): Promise<TreeSignalResult> {
    const result = empty();
    for (const pid of pids) {
      try {
        deps.kill(pid, 'SIGCONT');
        result.pids.push(pid);
        result.names.push('');
      } catch (error) {
        const reason = signalReason(error);
        if (reason) result.failed.push({ pid, reason });
      }
    }
    return result;
  }

  // ---- Windows ----

  let building: Promise<string | null> | null = null;

  /** The built helper's path, building it first if needed; null when building failed. */
  function helperAssembly(): Promise<string | null> {
    const dir = deps.helperDir;
    if (!dir) return Promise.resolve(null);
    const path = helperAssemblyPath(dir);
    if (deps.fileExists(path)) return Promise.resolve(path);
    building ??= deps
      .powershell(compileScript(path, dir))
      .then(() => (deps.fileExists(path) ? path : null))
      .catch(() => null)
      .finally(() => {
        building = null;
      });
    return building;
  }

  async function callHelper(call: string, subject: number): Promise<TreeSignalResult> {
    const assembly = await helperAssembly();
    try {
      const parsed = parseHelperOutput(await deps.powershell(callScript(call, assembly)));
      return parsed ?? { ...empty(), failed: [{ pid: subject, reason: 'unexpected helper output' }] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...empty(), failed: [{ pid: subject, reason }] };
    }
  }

  return {
    async suspendTree(rootPid) {
      if (!isPid(rootPid)) return { ...empty(), failed: [{ pid: rootPid, reason: 'not running' }] };
      if (deps.platform === 'win32') return callHelper(`Suspend(${rootPid})`, rootPid);
      return suspendPosix(rootPid);
    },

    async resumePids(pids) {
      const order = pids.filter(isPid).reverse();
      if (order.length === 0) return empty();
      if (deps.platform === 'win32') {
        return callHelper(`Resume(@(${order.join(',')}))`, order.at(-1) as number);
      }
      return resumePosix(order);
    },

    async warm() {
      if (deps.platform === 'win32') await helperAssembly();
    },
  };
}
