import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerMachineSample } from '../../shared/apiTypes';
import type { ExecResult } from '../ssh/connection';
import { VaultLockedError } from '../ssh/vaultErrors';
import { POSIX_PROBE, WINDOWS_PROBE } from './runnerMachineProbe';
import { createRunnerMachineStats, type RunnerMachineStatsDeps } from './runnerMachineStats';

vi.mock('../ssh/savedServers', () => ({ findSavedServer: vi.fn() }));
vi.mock('../ssh/sharedPool', () => ({ getSshPool: vi.fn() }));

const UBUNTU = readFileSync(join(__dirname, '__fixtures__', 'runner-probe-ubuntu.txt'), 'utf8');
const WINDOWS = readFileSync(join(__dirname, '__fixtures__', 'runner-probe-windows.txt'), 'utf8');
const NO_SH = "'sh' is not recognized as an internal or external command,\r\n";

function reply(stdout: string, extra: Partial<ExecResult> = {}): ExecResult {
  return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, ...extra };
}

function setup(
  answer: (command: string) => ExecResult | Promise<ExecResult>,
  overrides: Partial<RunnerMachineStatsDeps> = {},
) {
  const exec = vi.fn(async (command: string) => answer(command));
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ connection: { exec }, release }) as never);
  const read = createRunnerMachineStats({
    findServer: async () => ({}),
    acquire,
    readLocal: async () => {
      throw new Error('not used');
    },
    now: () => 42,
    ...overrides,
  });
  return { read, exec, acquire, release };
}

describe('readRunnerMachineStats over SSH', () => {
  it('reads a Linux machine with one command and hands the connection back', async () => {
    const { read, exec, release } = setup(() => reply(UBUNTU));

    const result = await read({ kind: 'ssh', serverId: 'srv-1' });

    expect(result).toMatchObject({ ok: true, sample: { at: 42, cpuCount: 16, diskMount: '/' } });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(POSIX_PROBE, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('falls back to PowerShell on Windows and starts there next time', async () => {
    const { read, exec } = setup((command) => reply(command === POSIX_PROBE ? NO_SH : WINDOWS));

    const first = await read({ kind: 'ssh', serverId: 'win' });
    const second = await read({ kind: 'ssh', serverId: 'win' });

    expect(first).toMatchObject({ ok: true, sample: { diskMount: 'C:', load1: null } });
    expect(second.ok).toBe(true);
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      POSIX_PROBE,
      WINDOWS_PROBE,
      WINDOWS_PROBE,
    ]);
  });

  it('shares one reading between callers that ask at the same time', async () => {
    let finish: (value: ExecResult) => void = () => undefined;
    const { read, exec } = setup(
      () =>
        new Promise<ExecResult>((resolve) => {
          finish = resolve;
        }),
    );

    const a = read({ kind: 'ssh', serverId: 'srv-1' });
    const b = read({ kind: 'ssh', serverId: 'srv-1' });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    finish(reply(UBUNTU));

    expect(await a).toBe(await b);
    // Once it is done, the next poll asks again.
    void read({ kind: 'ssh', serverId: 'srv-1' });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
  });

  it('says the server is gone without trying to connect', async () => {
    const { read, acquire } = setup(() => reply(UBUNTU), {
      findServer: async () => {
        throw new Error('This saved server no longer exists.');
      },
    });

    expect(await read({ kind: 'ssh', serverId: 'gone' })).toEqual({
      ok: false,
      reason: 'missing',
      error: 'This saved server no longer exists.',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('says the vault is locked when the login is sealed in it', async () => {
    const { read } = setup(() => reply(UBUNTU), {
      acquire: async () => {
        throw new VaultLockedError();
      },
    });

    expect(await read({ kind: 'ssh', serverId: 'srv-1' })).toMatchObject({
      ok: false,
      reason: 'locked',
    });
  });

  it('passes the login error on when the machine cannot be reached', async () => {
    const { read } = setup(() => reply(UBUNTU), {
      acquire: async () => {
        throw new Error('Could not connect to smartvpn:22 (connection refused).');
      },
    });

    expect(await read({ kind: 'ssh', serverId: 'srv-1' })).toEqual({
      ok: false,
      reason: 'unreachable',
      error: 'Could not connect to smartvpn:22 (connection refused).',
    });
  });

  it('gives up on a machine that does not answer in time', async () => {
    const { read, release } = setup(() => reply('', { timedOut: true, exitCode: null }));

    expect(await read({ kind: 'ssh', serverId: 'srv-1' })).toEqual({
      ok: false,
      reason: 'unreachable',
      error: 'The machine took too long to answer.',
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('says so when neither probe understands the machine', async () => {
    const { read, exec } = setup(() => reply('@@os\nFreeBSD\n'));

    expect(await read({ kind: 'ssh', serverId: 'bsd' })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('readRunnerMachineStats for this computer', () => {
  it('reads locally without SSH', async () => {
    const sample: RunnerMachineSample = {
      at: 1,
      cpuPercent: null,
      cpuCount: 8,
      load1: null,
      memUsedBytes: 1,
      memTotalBytes: 2,
      diskUsedBytes: 3,
      diskTotalBytes: 4,
      diskMount: 'C:',
    };
    const { read, acquire } = setup(() => reply(''), { readLocal: async () => sample });

    expect(await read({ kind: 'local' })).toEqual({ ok: true, sample });
    expect(acquire).not.toHaveBeenCalled();
  });
});
