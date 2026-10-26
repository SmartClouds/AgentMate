import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessSuspender } from './processSuspend';

/**
 * Pausing real processes: a node parent and the child it started each append to a file every
 * 50 ms, and a frozen tree must stop writing until it is thawed. The second part runs a ticker
 * inside a real interactive shell on a pty, which is where the shell-first order matters: bash
 * must not notice its job stopping, print "Stopped" and take the terminal back.
 *
 * Set RUNOVA_STRESS_TESTS=1 to also time a pause with every core busy.
 */

const TICKER = `
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const [file, role] = process.argv.slice(2);
if (role === 'parent') {
  spawn(process.execPath, [__filename, file + '.child', 'child'], { stdio: 'ignore' });
}
setInterval(() => appendFileSync(file, '.'), 50);
`;

const BURNER = `
const { Worker } = require('node:worker_threads');
for (let i = 0; i < ${cpus().length}; i++) new Worker('for (;;) {}', { eval: true });
`;

const ptyLoads = await (async (): Promise<boolean> => {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(50);
  }
}

describe('pausing a real process tree', () => {
  let dir = '';
  let ticker: ChildProcess | null = null;
  const suspender = () => createProcessSuspender({ helperDir: join(dir, 'bin') });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-suspend-'));
    writeFileSync(join(dir, 'ticker.cjs'), TICKER, 'utf-8');
  });

  afterAll(async () => {
    if (ticker?.pid) {
      // Thaw first: a frozen process ignores everything but SIGKILL on posix.
      await suspender().resumePids([ticker.pid]);
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(ticker.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(ticker.pid, 'SIGKILL');
      }
    }
    await sleep(300);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('stops the parent and its child from doing anything until resumed', async () => {
    const file = join(dir, 'ticks');
    ticker = spawn(process.execPath, [join(dir, 'ticker.cjs'), file, 'parent'], {
      stdio: 'ignore',
    });
    await until(() => size(file) > 3 && size(`${file}.child`) > 3);

    const control = suspender();
    await control.warm();
    const started = Date.now();
    const paused = await control.suspendTree(ticker.pid as number);
    // biome-ignore lint/suspicious/noConsole: the pause time is the number worth watching in the CI log
    console.info(`paused ${paused.pids.length} processes in ${Date.now() - started} ms`);

    expect(paused.failed).toEqual([]);
    expect(paused.pids[0]).toBe(ticker.pid);
    expect(paused.pids).toHaveLength(2);
    expect(paused.names.every((name) => /node|electron/i.test(name))).toBe(true);

    await sleep(150);
    const before = [size(file), size(`${file}.child`)];
    await sleep(1000);
    expect([size(file), size(`${file}.child`)]).toEqual(before);

    const resumed = await control.resumePids(paused.pids);
    expect(resumed.failed).toEqual([]);
    expect(resumed.pids).toEqual([...paused.pids].reverse());
    await until(() => size(file) > before[0] + 3 && size(`${file}.child`) > before[1] + 3);
  }, 60_000);

  it.skipIf(process.env.RUNOVA_STRESS_TESTS !== '1')(
    'pauses in reasonable time with every core busy',
    async () => {
      const file = join(dir, 'busy-ticks');
      const busy = spawn(process.execPath, [join(dir, 'ticker.cjs'), file, 'parent'], {
        stdio: 'ignore',
      });
      let burner: ChildProcess | null = null;
      try {
        await until(() => size(file) > 3 && size(`${file}.child`) > 3);
        burner = spawn(process.execPath, ['-e', BURNER], { stdio: 'ignore' });
        await sleep(3000);
        const control = suspender();
        await control.warm();
        const started = Date.now();
        const paused = await control.suspendTree(busy.pid as number);
        const elapsed = Date.now() - started;
        // biome-ignore lint/suspicious/noConsole: the pause time under load is the point of this test
        console.info(`under load: paused ${paused.pids.length} processes in ${elapsed} ms`);
        expect(paused.pids).toHaveLength(2);
        await control.resumePids(paused.pids);
        expect(elapsed).toBeLessThan(5000);
      } finally {
        burner?.kill();
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(busy.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          busy.kill('SIGKILL');
        }
      }
    },
    90_000,
  );
});

describe.skipIf(!ptyLoads)('pausing a ticker inside an interactive shell', () => {
  it('keeps the ticker in front and the shell quiet', async () => {
    const pty = await import('node-pty');
    const dir = mkdtempSync(join(tmpdir(), 'runova-suspend-pty-'));
    const script = join(dir, 'tick.cjs');
    writeFileSync(
      script,
      "let n = 0; setInterval(() => process.stdout.write('tick ' + ++n + '\\n'), 100);",
      'utf-8',
    );
    const windows = process.platform === 'win32';
    const shell = windows
      ? pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { cols: 120, rows: 30, cwd: dir })
      : pty.spawn('bash', ['--norc', '--noprofile', '-i'], {
          cols: 120,
          rows: 30,
          cwd: dir,
          env: { ...process.env, PS1: 'PROMPT> ' } as Record<string, string>,
        });
    let output = '';
    shell.onData((data) => {
      output += data;
    });
    const control = createProcessSuspender({ helperDir: join(dir, 'bin') });
    try {
      await sleep(windows ? 1500 : 500);
      const command = windows
        ? `& '${process.execPath}' '${script}'\r`
        : `'${process.execPath}' '${script}'\r`;
      shell.write(command);
      await until(() => /tick 3/.test(output), 15_000);

      const paused = await control.suspendTree(shell.pid);
      expect(paused.failed).toEqual([]);
      expect(paused.pids[0]).toBe(shell.pid);
      expect(paused.pids.length).toBeGreaterThanOrEqual(2);
      await sleep(200);
      const frozenAt = output.length;
      await sleep(1000);
      expect(output.length).toBe(frozenAt);

      await control.resumePids(paused.pids);
      const lastTick = (): number => {
        const all = [...output.matchAll(/tick (\d+)/g)];
        return Number(all.at(-1)?.[1] ?? 0);
      };
      const resumedFrom = lastTick();
      await until(() => lastTick() >= resumedFrom + 5, 10_000);

      const afterResume = output.slice(frozenAt);
      expect(afterResume).not.toMatch(/Stopped|Continued|suspended/i);
      // The shell never got the terminal back while the ticker was frozen.
      if (!windows) expect(afterResume).not.toContain('PROMPT> ');
    } finally {
      await control.resumePids([shell.pid]);
      shell.kill();
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can hold the folder until the killed shell is reaped.
      }
    }
  }, 60_000);
});
