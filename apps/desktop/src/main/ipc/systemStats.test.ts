import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuUsage, SystemStatsSample } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { withPlatform } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * The sample the dashboard charts every few seconds. The probes are replaced: what matters here is
 * that the CPU architecture and the CPU and GPU temperatures reach the sample, and that the
 * temperature probe (a PowerShell process on Windows) never holds a sample up.
 */

type CpuTemperature = Pick<SystemStatsSample, 'cpuTempC' | 'cpuThermalState'>;

const probes = vi.hoisted(() => ({
  sampleCpuTemperature: vi.fn(
    async (): Promise<CpuTemperature> => ({ cpuTempC: null, cpuThermalState: null }),
  ),
  sampleGpus: vi.fn(async (): Promise<GpuUsage[]> => []),
  sampleMemory: vi.fn(async () => ({ memPercent: 50, memUsedBytes: 4, memTotalBytes: 8 })),
  readCpuArch: vi.fn(() => 'arm64'),
  probeAll: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../system/temperatureStats', () => ({
  sampleCpuTemperature: probes.sampleCpuTemperature,
}));
vi.mock('../system/gpuStats', () => ({ sampleGpus: probes.sampleGpus }));
vi.mock('../system/memoryStats', () => ({ sampleMemory: probes.sampleMemory }));
vi.mock('../system/cpuArch', () => ({ readCpuArch: probes.readCpuArch }));
vi.mock('../network/pingProbe', () => ({ probeAll: probes.probeAll }));
vi.mock('../store', () => ({ store: { getSettings: probes.getSettings } }));
// Only the top-apps channel uses it, and the real one pulls in all of @agentmat/core.
vi.mock('../system/processTree', () => ({
  asArray: <T>(value: T | T[] | null | undefined): T[] =>
    value == null ? [] : Array.isArray(value) ? value : [value],
  runPowerShellJson: async () => null,
}));

// Disk and network rates are read inside the module. On Windows they ask netstat and PowerShell,
// which these answer so the sample stays offline and fast on any machine.
vi.mock('node:child_process', () => ({
  execFile: (command: string, _args: string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as (
      error: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    const stdout = command === 'netstat' ? 'Bytes    1000    2000\n' : '[]';
    callback(null, { stdout, stderr: '' });
  },
}));

useTempUserData({ home: false });

beforeEach(async () => {
  probes.sampleCpuTemperature.mockReset();
  probes.sampleCpuTemperature.mockResolvedValue({ cpuTempC: null, cpuThermalState: null });
  probes.sampleGpus.mockReset();
  probes.sampleGpus.mockResolvedValue([]);
  await loadIpc(
    () => import('./systemStats'),
    (module) => module.registerSystemStatsHandlers(),
  );
});

function sample(): Promise<SystemStatsSample> {
  return withPlatform('win32', () => invoke<SystemStatsSample>(IPC.system.sample));
}

/** Lets the background temperature probe land in the cache. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const RTX: GpuUsage = {
  id: 'nvidia-0',
  label: 'NVIDIA GeForce RTX 4070',
  percent: 35,
  memUsedBytes: 2048,
  memTotalBytes: 12282,
  tempC: 61,
};

describe('system:sample', () => {
  it('names the CPU architecture', async () => {
    expect((await sample()).cpuArch).toBe('arm64');
  });

  it('carries each GPU temperature', async () => {
    probes.sampleGpus.mockResolvedValue([RTX, { ...RTX, id: 'other-gpu', tempC: null }]);

    const { gpus } = await sample();

    expect(gpus.map((g) => [g.id, g.tempC])).toEqual([
      ['nvidia-0', 61],
      ['other-gpu', null],
    ]);
  });

  it('answers before the first temperature reading and shows it on a later sample', async () => {
    probes.sampleCpuTemperature.mockResolvedValue({ cpuTempC: 52, cpuThermalState: null });

    const first = await sample();
    expect(first).toMatchObject({ cpuTempC: null, cpuThermalState: null });

    await settle();
    const later = await sample();
    expect(later).toMatchObject({ cpuTempC: 52, cpuThermalState: null });
  });

  it('carries the thermal state a Mac reports', async () => {
    probes.sampleCpuTemperature.mockResolvedValue({ cpuTempC: null, cpuThermalState: 'serious' });

    await sample();
    await settle();

    expect((await sample()).cpuThermalState).toBe('serious');
  });

  it('does not wait for a temperature probe that is still running', async () => {
    // A PowerShell call that never comes back must not stall the dashboard.
    probes.sampleCpuTemperature.mockReturnValue(new Promise<CpuTemperature>(() => undefined));

    const result = await sample();

    expect(result).toMatchObject({ cpuTempC: null, cpuThermalState: null, cpuArch: 'arm64' });
    await sample();
    // Still the one call: the probe never runs twice at once.
    expect(probes.sampleCpuTemperature).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh temperature reading instead of probing on every sample', async () => {
    probes.sampleCpuTemperature.mockResolvedValue({ cpuTempC: 47, cpuThermalState: null });

    await sample();
    await settle();
    await sample();
    await sample();

    expect(probes.sampleCpuTemperature).toHaveBeenCalledTimes(1);
  });

  it('keeps sampling when the temperature probe fails', async () => {
    probes.sampleCpuTemperature.mockRejectedValue(new Error('powershell went away'));

    await sample();
    await settle();

    expect(await sample()).toMatchObject({ cpuTempC: null, cpuThermalState: null });
  });
});
