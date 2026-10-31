import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Every app on one X server shares its clipboard and its keyboard focus. With two workers on one
 * Xvfb, a spec copying in one Electron changed what the other read back, and a main process could
 * sit blocked in clipboard.readText() while the selection belonged to the other app. So on Linux,
 * with more than one worker, every worker gets an Xvfb of its own.
 */

const DISPLAYS_ENV = 'RUNOVA_E2E_DISPLAYS';
const START_TIMEOUT_MS = 10_000;

function startXvfb(): Promise<{ display: string; server: ChildProcess }> {
  return new Promise((resolve, reject) => {
    // -displayfd picks a free display number and prints it, so two runners on one machine never
    // reach for the same one.
    const server = spawn(
      'Xvfb',
      ['-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    const fail = (reason: string) => {
      clearTimeout(timer);
      server.kill();
      reject(new Error(`Xvfb did not start: ${reason}`));
    };
    const timer = setTimeout(() => fail('no display number after 10s'), START_TIMEOUT_MS);
    server.once('error', (error) => fail(error.message));
    server.once('exit', (code) => fail(`exited with ${code}`));
    server.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.match(/^(\d+)\n/);
      if (!line) return;
      clearTimeout(timer);
      server.removeAllListeners('exit');
      server.stdout?.removeAllListeners('data');
      resolve({ display: `:${line[1]}`, server });
    });
  });
}

/**
 * Starts one display per worker and hands the list to the workers through the environment.
 * Returns what stops them again, or nothing when this run doesn't need them.
 */
export async function startWorkerDisplays(workers: number): Promise<(() => void) | undefined> {
  if (process.platform !== 'linux' || workers < 2) return undefined;
  const servers: ChildProcess[] = [];
  const displays: string[] = [];
  const stop = () => {
    for (const server of servers) server.kill();
  };
  // One after another: started together, they race for the same free number.
  for (let worker = 0; worker < workers; worker++) {
    try {
      const { display, server } = await startXvfb();
      servers.push(server);
      displays.push(display);
    } catch (error) {
      stop();
      throw error;
    }
  }
  process.env[DISPLAYS_ENV] = displays.join(',');
  return stop;
}

/** The display global setup started for this worker, if it started any. */
export function workerDisplay(): string | undefined {
  const displays = process.env[DISPLAYS_ENV]?.split(',');
  const slot = Number(process.env.TEST_PARALLEL_INDEX);
  return displays && Number.isInteger(slot) ? displays[slot] : undefined;
}
