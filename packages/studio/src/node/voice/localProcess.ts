import { spawn } from 'node:child_process';

/**
 * Runs one local voice process to its end: Python forced to UTF-8 (so Persian text and paths
 * survive any Windows code page), a watchdog that ends it when it takes too long, and a stop when
 * the caller gives up. Resolves with the last lines it printed, for a failure message.
 */

export interface LocalRun {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface LocalRunResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The last few lines it printed, stdout and stderr together. */
  tail: string[];
}

export const PYTHON_UTF8 = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONNOUSERSITE: '1',
};

export function runLocal(run: LocalRun): Promise<LocalRunResult> {
  return new Promise((resolve) => {
    const tail: string[] = [];
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 8) tail.shift();
      }
    };
    let timedOut = false;
    let aborted = false;
    const child = spawn(run.command, [...run.args], {
      cwd: run.cwd,
      env: { ...process.env, ...PYTHON_UTF8 },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, run.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, aborted, tail });
    };
    child.on('error', (error) => {
      tail.push(error.message);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
