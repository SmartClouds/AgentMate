import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionListener } from './sessionManager';

/**
 * A large paste into a terminal while every core is busy. On Windows this used to stall for
 * minutes (or forever, as far as the user could tell): the program reads its input from conhost
 * one record per round trip, and at 100% CPU each round trip waits for a scheduler slice. The
 * paste boost in `pasteBoost.ts` is what gets it through.
 *
 * It pegs every core for the length of the test, so it only runs when asked for:
 *   RUNOVA_STRESS_TESTS=1 pnpm vitest run src/main/ptyHost/pasteUnderLoad.int.test.ts
 */
const ptyLoads = await (async (): Promise<boolean> => {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
})();

const enabled = process.platform === 'win32' && process.env.RUNOVA_STRESS_TESTS === '1' && ptyLoads;

/** Reads raw input the way a Node CLI does and reports the bracketed paste it got. */
const READER = `
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let buffered = '';
process.stdout.write('PASTE' + '-READER-UP\\r\\n');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const end = buffered.indexOf('\\x1b[201~');
  if (end === -1) return;
  const body = buffered.slice(buffered.indexOf('\\x1b[200~') + 6, end);
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum * 31 + body.charCodeAt(i)) >>> 0;
  process.stdout.write('PASTE' + '-RESULT ' + body.length + ' ' + sum + '\\r\\n');
  setTimeout(() => process.exit(0), 100);
});
`;

/** Busy-loops every core in a separate process, the way a big build does. */
const BURNER = `
const { Worker } = require('node:worker_threads');
for (let i = 0; i < ${cpus().length}; i++) new Worker('for (;;) {}', { eval: true });
`;

function checksum(text: string): number {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return sum;
}

describe.skipIf(!enabled)('a large paste on a machine at 100% CPU', async () => {
  const { PtySessionManager } = await import('./sessionManager');
  let dir = '';
  let burner: ChildProcess | null = null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-paste-load-'));
    writeFileSync(join(dir, 'reader.cjs'), READER, 'utf-8');
    burner = spawn(process.execPath, ['-e', BURNER], { stdio: 'ignore' });
  });

  afterAll(() => {
    burner?.kill();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can hold the folder until the killed shell is reaped.
    }
  });

  it('reaches a CLI started from the shell, intact and in seconds', async () => {
    const manager = new PtySessionManager();
    let output = '';
    const listener: SessionListener = {
      onData: (_id, data) => {
        output += data;
      },
      onExit: () => undefined,
    };
    try {
      // The CLI runs under the shell, as Claude Code does, so the boost has to find it through
      // the console rather than as the pty's own process.
      await manager.createOrAttach(
        {
          sessionId: 'load',
          shell: 'cmd.exe',
          cwd: dir,
          cols: 120,
          rows: 30,
          initialInput: `"${process.execPath}" reader.cjs\r`,
        },
        listener,
      );
      await vi.waitFor(() => expect(output).toContain('PASTE-READER-UP'), { timeout: 60_000 });

      let text = '';
      for (let line = 0; text.length < 20_000; line++) {
        text += `line ${line} the quick brown fox jumps over the lazy dog 0123456789\r`;
      }
      text = text.slice(0, 20_000);
      manager.write('load', `\x1b[200~${text}\x1b[201~`);

      // Without the boost this did not arrive within a minute; with it, about a second.
      await vi.waitFor(() => expect(output).toMatch(/PASTE-RESULT \d+ \d+/), {
        timeout: 30_000,
        interval: 200,
      });
      const [, length, sum] = output.match(/PASTE-RESULT (\d+) (\d+)/) ?? [];
      expect(Number(length)).toBe(text.length);
      expect(Number(sum)).toBe(checksum(text));
    } finally {
      manager.killAll();
    }
  }, 120_000);
});
