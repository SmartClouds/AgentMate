import { spawn } from 'node:child_process';
import { toolSpawn } from '../../android/spawnTool';
import { type CancelToken, killProcessTree } from '../../process/spawnStreaming';
import type { CommandResult } from './managed';

/**
 * Runs one command from an absolute path and streams what it prints. Used for Flutter's first
 * run, which lives under the person's home folder.
 *
 * `spawnStreaming` is not used for this because it leaves the command itself unquoted on Windows
 * (so `.cmd` shims can find their own folder), and a home folder with a space in it ("John
 * Smith") then breaks. `toolSpawn` quotes the path properly. Cancelling goes through the token,
 * the same as every other install step.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    token: CancelToken;
    onLine: (line: string) => void;
    idleMs: number;
    /** Added to the app's own environment. */
    env?: Record<string, string>;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const { file, argv, verbatim } = toolSpawn(command, [...args]);
      child = spawn(file, argv, {
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // Its own process group off Windows, so stopping it takes down what it started too.
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve({ code: null, cancelled: false, timedOut: false, notFound: true });
      return;
    }
    options.token.child = child;

    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, options.idleMs);
    };
    arm();

    let pending = '';
    const read = (chunk: Buffer | string): void => {
      arm();
      // A progress bar repaints with a carriage return, so both ends of a line count.
      const parts = (pending + chunk.toString()).split(/\r\n|\r|\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) options.onLine(line);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);

    const finish = (result: Omit<CommandResult, 'cancelled' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.token.child = null;
      if (pending.trim()) options.onLine(pending);
      resolve({ ...result, cancelled: options.token.cancelled, timedOut });
    };
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ code: null, notFound: error.code === 'ENOENT' }),
    );
    child.on('close', (code) => finish({ code, notFound: false }));
  });
}
