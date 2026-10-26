import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

const { spawnStreaming } = await import('./spawnStreaming');

/**
 * Real child processes through the same cmd.exe or direct spawn the test runner uses. Node itself
 * plays the test tool, so these run anywhere the suite runs.
 */

let dir = '';

beforeEach(async () => {
  // A space and an ampersand, the two characters that break naive cmd.exe quoting.
  dir = await mkdtemp(join(tmpdir(), 'runova spawn & '));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, 'utf-8');
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('spawnStreaming', () => {
  it('streams raw lines with indentation from stdout and stderr, in a folder with shell characters', async () => {
    const path = await script(
      'print.js',
      [
        "process.stdout.write('first\\n    indented line\\n');",
        "process.stderr.write('\\u001b[31mred\\u001b[0m on stderr\\n');",
        "process.stdout.write('arg=' + process.argv[2] + ' cwd=' + process.cwd() + '\\n');",
        "process.stdout.write('no newline at the end');",
      ].join('\n'),
    );
    const lines: string[] = [];
    const result = await spawnStreaming({
      command: 'node',
      args: [path, 'a "quoted"? no, a & b | c'.replace(/"/g, '')],
      cwd: dir,
      timeoutMs: 20_000,
      token: { cancelled: false, child: null },
      onLine: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ code: 0, timedOut: false, cancelled: false, notFound: false });
    expect(lines).toContain('first');
    expect(lines).toContain('    indented line');
    expect(lines).toContain('red on stderr');
    expect(lines).toContain(`arg=a quoted? no, a & b | c cwd=${dir}`);
    expect(lines[lines.length - 1]).toBe('no newline at the end');
    expect(result.log).toContain('indented line');
  });

  it('keeps stdout and stderr lines apart when they arrive interleaved', async () => {
    const path = await script(
      'interleave.js',
      [
        "process.stdout.write('half a line');",
        'setTimeout(() => {',
        String.raw`  process.stderr.write('a whole stderr line\n');`,
        String.raw`  setTimeout(() => process.stdout.write(' and its other half\n'), 300);`,
        '}, 300);',
      ].join('\n'),
    );
    const lines: string[] = [];
    await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      timeoutMs: 20_000,
      token: { cancelled: false, child: null },
      onLine: (line) => lines.push(line),
    });
    expect(lines).toContain('a whole stderr line');
    expect(lines).toContain('half a line and its other half');
  });

  it('passes extra environment variables through', async () => {
    const path = await script('env.js', "console.log('value=' + process.env.RUNOVA_TEST_VALUE);");
    const lines: string[] = [];
    await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      env: { ...process.env, RUNOVA_TEST_VALUE: 'C:\\tmp\\run 1\\report.json' },
      timeoutMs: 20_000,
      token: { cancelled: false, child: null },
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['value=C:\\tmp\\run 1\\report.json']);
  });

  it('reports a non-zero exit code as a normal finish', async () => {
    const path = await script('fail.js', 'process.exit(3);');
    const result = await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      timeoutMs: 20_000,
      token: { cancelled: false, child: null },
    });
    expect(result).toMatchObject({ code: 3, notFound: false, timedOut: false });
  });

  it('says so when the command does not exist', async () => {
    const result = await spawnStreaming({
      command: 'runova-no-such-tool-xyz',
      args: [],
      cwd: dir,
      timeoutMs: 20_000,
      token: { cancelled: false, child: null },
    });
    expect(result.notFound).toBe(true);
  });

  it('kills the whole process tree on cancel, grandchildren included', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const grandchild = await script('sleep.js', 'setInterval(() => {}, 1000);');
    const parent = await script(
      'parent.js',
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "console.log('started');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const token = {
      cancelled: false,
      child: null as import('node:child_process').ChildProcess | null,
    };
    let started = false;
    const running = spawnStreaming({
      command: 'node',
      args: [parent],
      cwd: dir,
      timeoutMs: 60_000,
      token,
      onLine: (line) => {
        if (line === 'started') started = true;
      },
    });
    await waitFor(() => started);
    const grandchildPid = Number(await readFile(pidFile, 'utf-8'));
    expect(isAlive(grandchildPid)).toBe(true);

    const { cancelSpawn } = await import('./spawnStreaming');
    cancelSpawn(token);
    const result = await running;
    expect(result.cancelled).toBe(true);
    await waitFor(() => !isAlive(grandchildPid));
  }, 30_000);

  it('kills a run that goes past its timeout', async () => {
    const path = await script('hang.js', "console.log('hanging'); setInterval(() => {}, 1000);");
    const result = await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      timeoutMs: 1_500,
      token: { cancelled: false, child: null },
    });
    expect(result.timedOut).toBe(true);
    expect(result.log).toContain('hanging');
  }, 30_000);

  it('lets a run that keeps printing outlast an idle timeout', async () => {
    // Twenty lines 200 ms apart take about four seconds, longer than the three-second timeout,
    // but it is never quiet for more than a fraction of it.
    const path = await script(
      'chatty.js',
      [
        'let n = 0;',
        'const timer = setInterval(() => {',
        "  console.log('tick ' + (n += 1));",
        '  if (n === 20) clearInterval(timer);',
        '}, 200);',
      ].join('\n'),
    );
    const result = await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      timeoutMs: 3_000,
      idle: true,
      token: { cancelled: false, child: null },
    });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.log).toContain('tick 20');
  }, 30_000);

  it('kills a run that goes quiet for longer than its idle timeout', async () => {
    const path = await script('quiet.js', "console.log('hanging'); setInterval(() => {}, 1000);");
    const result = await spawnStreaming({
      command: 'node',
      args: [path],
      cwd: dir,
      timeoutMs: 1_500,
      idle: true,
      token: { cancelled: false, child: null },
    });
    expect(result.timedOut).toBe(true);
    expect(result.log).toContain('hanging');
  }, 30_000);

  it('does not start anything when cancelled before the spawn', async () => {
    const onLine = vi.fn();
    const result = await spawnStreaming({
      command: 'node',
      args: ['-e', "console.log('should not run')"],
      cwd: dir,
      timeoutMs: 20_000,
      token: { cancelled: true, child: null },
      onLine,
    });
    expect(result.cancelled).toBe(true);
    expect(onLine).not.toHaveBeenCalled();
  });

  it('refuses an argument with a double quote on Windows instead of running a mangled command', async () => {
    if (process.platform !== 'win32') return;
    await expect(
      spawnStreaming({
        command: 'node',
        args: ['-e', 'console.log("x")'],
        cwd: dir,
        timeoutMs: 20_000,
        token: { cancelled: false, child: null },
      }),
    ).rejects.toThrow(/quote/);
  });
});
