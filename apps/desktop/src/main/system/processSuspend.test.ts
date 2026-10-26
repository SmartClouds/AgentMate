import type { ProcessRow } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { createProcessSuspender, type ProcessSuspenderDeps } from './processSuspend';

/**
 * Pausing a run freezes its shell and everything the shell started; resuming thaws them. What
 * matters is the order (shell first on pause, shell last on resume, so an interactive bash never
 * sees a stopped job and takes the terminal back), that a process which is already gone is not
 * a failure, and that the Windows path never runs the C# compiler more than once.
 */

function row(pid: number, ppid: number, name = `p${pid}`): ProcessRow {
  return { pid, ppid, name, cpuTimeSec: 0, memBytes: 0, startedAt: pid };
}

// shell 100 -> pnpm 200 -> node 300, and an unrelated process 900.
const TREE = [
  row(1, 0),
  row(100, 1, 'bash'),
  row(200, 100, 'pnpm'),
  row(300, 200, 'node'),
  row(900, 1),
];

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function posix(overrides: Partial<ProcessSuspenderDeps> = {}) {
  const signals: [number, string][] = [];
  const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
    signals.push([pid, signal]);
  });
  const listProcesses = vi.fn(async () => TREE);
  const suspender = createProcessSuspender({
    platform: 'linux',
    listProcesses,
    kill,
    ...overrides,
  });
  return { suspender, signals, kill, listProcesses };
}

describe('pausing on Linux and macOS', () => {
  it('stops the shell first and then every process below it, parents before children', async () => {
    const { suspender, signals } = posix();

    const result = await suspender.suspendTree(100);

    expect(signals).toEqual([
      [100, 'SIGSTOP'],
      [200, 'SIGSTOP'],
      [300, 'SIGSTOP'],
    ]);
    expect(result).toEqual({ pids: [100, 200, 300], names: ['bash', 'pnpm', 'node'], failed: [] });
  });

  it('continues them in reverse, so the shell is the last to wake', async () => {
    const { suspender, signals } = posix();

    await suspender.resumePids([100, 200, 300]);

    expect(signals).toEqual([
      [300, 'SIGCONT'],
      [200, 'SIGCONT'],
      [100, 'SIGCONT'],
    ]);
  });

  it('also stops a child that was started while the tree was being stopped', async () => {
    const late = [...TREE, row(400, 300, 'esbuild')];
    const listProcesses = vi.fn().mockResolvedValueOnce(TREE).mockResolvedValue(late);
    const { suspender, signals } = posix({ listProcesses });

    const result = await suspender.suspendTree(100);

    expect(signals.map(([pid]) => pid)).toEqual([100, 200, 300, 400]);
    expect(result.pids).toEqual([100, 200, 300, 400]);
  });

  it('skips a process that exited on the way without calling it a failure', async () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 300) throw errno('ESRCH');
    });
    const { suspender } = posix({ kill });

    const result = await suspender.suspendTree(100);

    expect(result.pids).toEqual([100, 200]);
    expect(result.failed).toEqual([]);
  });

  it('reports a process it may not stop', async () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 200) throw errno('EPERM');
    });
    const { suspender } = posix({ kill });

    const result = await suspender.suspendTree(100);

    expect(result.pids).toEqual([100, 300]);
    expect(result.failed).toEqual([{ pid: 200, reason: 'access denied' }]);
  });

  it('reports the shell as failed when it is not running', async () => {
    const { suspender, kill } = posix({ listProcesses: vi.fn(async () => [row(1, 0)]) });

    const result = await suspender.suspendTree(100);

    expect(kill).not.toHaveBeenCalled();
    expect(result).toEqual({ pids: [], names: [], failed: [{ pid: 100, reason: 'not running' }] });
  });

  it('refuses a pid that is not a real process id', async () => {
    const { suspender, kill } = posix();

    for (const pid of [0, -5, 1.5, Number.NaN]) {
      const result = await suspender.suspendTree(pid);
      expect(result.failed).toEqual([{ pid, reason: 'not running' }]);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('pausing on Windows', () => {
  function windows(options: { compiled?: boolean; stdout?: string; fails?: boolean } = {}) {
    const scripts: string[] = [];
    let compiled = options.compiled ?? false;
    const powershell = vi.fn(async (script: string) => {
      scripts.push(script);
      if (options.fails) throw new Error('powershell exited with code 1');
      if (script.includes('-OutputAssembly')) {
        compiled = true;
        return '';
      }
      return (
        options.stdout ??
        JSON.stringify({ pids: [100, 200], names: ['pwsh.exe', 'node.exe'], failed: [] })
      );
    });
    const suspender = createProcessSuspender({
      platform: 'win32',
      powershell,
      helperDir: 'C:\\Users\\me\\AppData\\Roaming\\Runova\\bin',
      fileExists: () => compiled,
    });
    return { suspender, scripts, powershell };
  }

  it('builds the helper once, then loads it without compiling', async () => {
    const { suspender, scripts } = windows();

    await suspender.suspendTree(100);
    await suspender.resumePids([100, 200]);

    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toContain('-OutputAssembly');
    expect(scripts[0]).toContain('NtSuspendProcess');
    expect(scripts[1]).toContain('Add-Type -Path');
    expect(scripts[1]).not.toContain('-TypeDefinition');
    expect(scripts[1]).toContain('[RunovaProcessTree]::Suspend(100)');
    expect(scripts[2]).toContain('[RunovaProcessTree]::Resume(@(200,100))');
  });

  it('compiles only once when two pauses start together', async () => {
    const { suspender, scripts } = windows();

    await Promise.all([suspender.suspendTree(100), suspender.suspendTree(500)]);

    expect(scripts.filter((script) => script.includes('-OutputAssembly'))).toHaveLength(1);
  });

  it('keeps the helper next to the app data, named after its source', async () => {
    const { suspender, scripts } = windows();

    await suspender.warm();

    expect(scripts[0]).toMatch(
      /-OutputAssembly 'C:\\Users\\me\\AppData\\Roaming\\Runova\\bin\\runova-proc-[0-9a-f]{12}\.dll'/,
    );
  });

  it('reads what the helper reports, names without .exe', async () => {
    const { suspender } = windows({
      compiled: true,
      stdout: JSON.stringify({
        pids: [100, 200],
        names: ['powershell.exe', 'node.exe'],
        failed: [{ pid: 300, reason: 'access denied' }],
      }),
    });

    const result = await suspender.suspendTree(100);

    expect(result).toEqual({
      pids: [100, 200],
      names: ['powershell', 'node'],
      failed: [{ pid: 300, reason: 'access denied' }],
    });
  });

  it('reports the whole tree as failed when PowerShell does not run', async () => {
    const { suspender } = windows({ compiled: true, fails: true });

    const result = await suspender.suspendTree(100);

    expect(result.pids).toEqual([]);
    expect(result.failed).toEqual([{ pid: 100, reason: 'powershell exited with code 1' }]);
  });

  it('reports the whole tree as failed when the helper prints something unexpected', async () => {
    const { suspender } = windows({ compiled: true, stdout: 'Add-Type : something broke' });

    const result = await suspender.suspendTree(100);

    expect(result.failed).toEqual([{ pid: 100, reason: 'unexpected helper output' }]);
  });

  it('never puts anything but whole numbers into the script', async () => {
    const { suspender, powershell } = windows({ compiled: true });

    await suspender.resumePids([100, Number.NaN, -1, 2.5, 200]);

    expect(powershell).toHaveBeenCalledTimes(1);
    expect(powershell.mock.calls[0][0]).toContain('Resume(@(200,100))');
  });

  it('does not start PowerShell to resume nothing', async () => {
    const { suspender, powershell } = windows({ compiled: true });

    const result = await suspender.resumePids([]);

    expect(powershell).not.toHaveBeenCalled();
    expect(result).toEqual({ pids: [], names: [], failed: [] });
  });
});
