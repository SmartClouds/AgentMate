import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../test/main/fixtures';

/**
 * The dashboard's GPU card said "No supported GPU detected." on a MacBook with an M4, because the
 * only probes were `nvidia-smi` and a Windows-only one. These tests pin down that a Mac's GPU is
 * read from the IORegistry, what shape of `ioreg` output that relies on, and that the other
 * platforms keep behaving the way they did.
 */

type Answer = { stdout: string } | { error: Error };

const calls = vi.hoisted(() => [] as { command: string; args: string[] }[]);
const answers = vi.hoisted(() => ({ byCommand: {} as Record<string, Answer> }));

vi.mock('node:child_process', () => ({
  // Some probes pass an options object and some do not, so the callback is whatever comes last.
  execFile: (command: string, args: string[], ...rest: unknown[]) => {
    calls.push({ command, args });
    const callback = rest.at(-1) as (
      error: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    const answer = answers.byCommand[command];
    if (!answer) callback(Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
    else if ('error' in answer) callback(answer.error);
    else callback(null, { stdout: answer.stdout, stderr: '' });
  },
}));

const { macAcceleratorsToGpus, parseIoregAccelerators, sampleGpus } = await import('./gpuStats');

const GIB = 1024 ** 3;

// What `ioreg -r -d 1 -w 0 -c IOAccelerator` prints on an Apple Silicon Mac.
const APPLE_M4_IOREG = `+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x1000005a1, registered, matched, active, busy 0 (0 ms), retain 35>
  {
    "IOClass" = "AGXAcceleratorG16G"
    "CFBundleIdentifier" = "com.apple.AGX"
    "gpu-core-count" = 10
    "model" = "Apple M4"
    "PerformanceStatistics" = {"Alloc system memory"=393363456,"Tiler Utilization %"=12,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=11,"TiledSceneBytes"=0,"Device Utilization %"=14,"In use system memory"=270172160,"SplitSceneCount"=0,"Allocated PB Size"=100663296}
    "IOUserClientCreator" = "pid 1, launchd"
  }

`;

// An Intel MacBook Pro with integrated and discrete graphics lists both, the discrete one with VRAM.
const INTEL_DUAL_GPU_IOREG = `+-o IntelAccelerator  <class IGAccelerator, id 0x100000432, registered, matched, active, busy 0 (0 ms), retain 20>
  {
    "model" = "Intel UHD Graphics 630"
    "PerformanceStatistics" = {"Device Utilization %"=3,"In use system memory"=150994944}
  }

+-o AMDRadeonX5000_AMDPolarisGraphicsAccelerator  <class AMDRadeonX5000_AMDPolarisGraphicsAccelerator, id 0x100000480, registered, matched, active, busy 0 (0 ms), retain 24>
  {
    "model" = "AMD Radeon Pro 555X"
    "PerformanceStatistics" = {"Device Utilization %"=47,"vramUsedBytes"=536870912,"vramFreeBytes"=1610612736}
  }
`;

beforeEach(() => {
  calls.length = 0;
  answers.byCommand = {};
});

describe('parseIoregAccelerators', () => {
  it('reads the model and the numeric counters of an Apple Silicon GPU', () => {
    const [m4, ...rest] = parseIoregAccelerators(APPLE_M4_IOREG);

    expect(rest).toEqual([]);
    expect(m4.ioClass).toBe('AGXAcceleratorG16G');
    expect(m4.model).toBe('Apple M4');
    expect(m4.stats['Device Utilization %']).toBe(14);
    expect(m4.stats['In use system memory']).toBe(270172160);
  });

  it('returns one accelerator per registry entry', () => {
    const found = parseIoregAccelerators(INTEL_DUAL_GPU_IOREG);

    expect(found.map((one) => one.model)).toEqual([
      'Intel UHD Graphics 630',
      'AMD Radeon Pro 555X',
    ]);
  });

  it('finds the counters when ioreg indents entries behind tree guides', () => {
    const nested = `| +-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x1>\n|   {\n|     "PerformanceStatistics" = {"Device Utilization %"=9}\n|   }\n`;

    expect(parseIoregAccelerators(nested)[0]?.stats['Device Utilization %']).toBe(9);
  });

  it('ignores entries that publish no performance statistics', () => {
    const bare = `+-o IOAccelerator  <class IOAccelerator, id 0x1>\n  {\n    "IOClass" = "IOAccelerator"\n  }\n`;

    expect(parseIoregAccelerators(bare)).toEqual([]);
  });

  it('returns nothing for empty or unrelated output', () => {
    expect(parseIoregAccelerators('')).toEqual([]);
    expect(parseIoregAccelerators('ioreg: no matching entries\n')).toEqual([]);
  });
});

describe('macAcceleratorsToGpus', () => {
  it('shows an Apple Silicon GPU against the unified memory it shares with the CPU', () => {
    const gpus = macAcceleratorsToGpus(parseIoregAccelerators(APPLE_M4_IOREG), 16 * GIB);

    expect(gpus).toEqual([
      {
        id: 'mac-gpu-0',
        label: 'Apple M4 GPU',
        percent: 14,
        memUsedBytes: 270172160,
        memTotalBytes: 16 * GIB,
        // ioreg has no temperature, and powermetrics needs sudo.
        tempC: null,
      },
    ]);
  });

  it('keeps integrated and discrete GPUs apart and uses the discrete card own VRAM', () => {
    const gpus = macAcceleratorsToGpus(parseIoregAccelerators(INTEL_DUAL_GPU_IOREG), 16 * GIB);

    expect(gpus.map((g) => [g.id, g.label, g.percent])).toEqual([
      ['mac-gpu-0', 'Intel UHD Graphics 630', 3],
      ['mac-gpu-1', 'AMD Radeon Pro 555X', 47],
    ]);
    expect(gpus[1]).toMatchObject({ memUsedBytes: 536870912, memTotalBytes: 2 * GIB });
  });

  it('falls back to the older "GPU Activity(%)" counter', () => {
    const gpus = macAcceleratorsToGpus(
      [{ ioClass: 'IGAccelerator', model: 'Intel HD Graphics', stats: { 'GPU Activity(%)': 21 } }],
      8 * GIB,
    );

    expect(gpus[0]).toMatchObject({ percent: 21, memUsedBytes: 0, memTotalBytes: 8 * GIB });
  });

  it('skips a GPU that reports no utilization rather than charting it as idle', () => {
    const gpus = macAcceleratorsToGpus(
      [{ ioClass: 'AGXAcceleratorG16G', stats: { 'In use system memory': 1 } }],
      8 * GIB,
    );

    expect(gpus).toEqual([]);
  });

  it('keeps the percentage inside 0 to 100', () => {
    const [high, low] = macAcceleratorsToGpus(
      [
        { ioClass: 'A', model: 'Radeon', stats: { 'Device Utilization %': 140 } },
        { ioClass: 'B', model: 'Radeon', stats: { 'Device Utilization %': -2 } },
      ],
      8 * GIB,
    );

    expect([high.percent, low.percent]).toEqual([100, 0]);
  });

  it('never reports more memory in use than the total', () => {
    const [gpu] = macAcceleratorsToGpus(
      [
        {
          ioClass: 'AGXAcceleratorG16G',
          model: 'Apple M4',
          stats: { 'Device Utilization %': 5, 'In use system memory': 9 * GIB },
        },
      ],
      8 * GIB,
    );

    expect(gpu.memTotalBytes).toBeGreaterThanOrEqual(gpu.memUsedBytes);
  });

  it('names an Apple GPU even when the registry has no model string', () => {
    const [gpu] = macAcceleratorsToGpus(
      [{ ioClass: 'AGXAcceleratorG16G', stats: { 'Device Utilization %': 1 } }],
      8 * GIB,
    );

    expect(gpu.label).toBe('Apple GPU');
  });
});

describe('sampleGpus', () => {
  it('reports the GPU of a Mac that has no nvidia-smi', async () => {
    answers.byCommand['/usr/sbin/ioreg'] = { stdout: APPLE_M4_IOREG };

    const gpus = await withPlatform('darwin', () => sampleGpus());

    // This is the regression: it used to be empty, which the dashboard shows as "No supported GPU".
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({ label: 'Apple M4 GPU', percent: 14 });
    expect(gpus[0].memTotalBytes).toBe(os.totalmem());
    expect(calls.find((c) => c.command === '/usr/sbin/ioreg')?.args).toEqual([
      '-r',
      '-d',
      '1',
      '-w',
      '0',
      '-c',
      'IOAccelerator',
    ]);
  });

  it('shows nothing, without throwing, when ioreg fails on a Mac', async () => {
    answers.byCommand['/usr/sbin/ioreg'] = { error: new Error('ioreg: operation not permitted') };

    await expect(withPlatform('darwin', () => sampleGpus())).resolves.toEqual([]);
  });

  it('does not ask ioreg anything on other platforms', async () => {
    answers.byCommand['/usr/sbin/ioreg'] = { stdout: APPLE_M4_IOREG };

    await withPlatform('linux', () => sampleGpus());
    await withPlatform('win32', () => sampleGpus());

    expect(calls.map((c) => c.command)).not.toContain('/usr/sbin/ioreg');
  });

  it('still reads an NVIDIA GPU through nvidia-smi', async () => {
    answers.byCommand['nvidia-smi'] = {
      stdout: '0, NVIDIA GeForce RTX 4070, 35, 2048, 12282, 61\n',
    };

    const gpus = await withPlatform('linux', () => sampleGpus());

    expect(gpus).toEqual([
      {
        id: 'nvidia-0',
        label: 'NVIDIA GeForce RTX 4070',
        percent: 35,
        memUsedBytes: 2048 * 1024 * 1024,
        memTotalBytes: 12282 * 1024 * 1024,
        tempC: 61,
      },
    ]);
  });

  it('asks nvidia-smi for the temperature as the sixth column', async () => {
    answers.byCommand['nvidia-smi'] = {
      stdout: '0, NVIDIA GeForce RTX 4070, 35, 2048, 12282, 61\n',
    };

    await withPlatform('linux', () => sampleGpus());

    expect(calls.find((c) => c.command === 'nvidia-smi')?.args[0]).toBe(
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    );
  });

  it('gives no NVIDIA temperature when the driver reports none', async () => {
    answers.byCommand['nvidia-smi'] = {
      stdout:
        '0, NVIDIA A100, 12, 1024, 40960, [N/A]\n1, NVIDIA A100, 9, 512, 40960, [Not Supported]\n',
    };

    const gpus = await withPlatform('linux', () => sampleGpus());

    expect(gpus.map((g) => [g.id, g.percent, g.tempC])).toEqual([
      ['nvidia-0', 12, null],
      ['nvidia-1', 9, null],
    ]);
  });

  it('lists a Windows integrated GPU next to the NVIDIA one', async () => {
    answers.byCommand['nvidia-smi'] = {
      stdout: '0, NVIDIA GeForce RTX 4070, 35, 2048, 12282, 58\n',
    };
    answers.byCommand.powershell = {
      stdout: JSON.stringify({
        name: 'Intel(R) UHD Graphics',
        ram: 0,
        percent: 8.5,
        memUsed: 1000,
      }),
    };

    const gpus = await withPlatform('win32', () => sampleGpus());

    expect(gpus.map((g) => g.label)).toEqual(['NVIDIA GeForce RTX 4070', 'Intel(R) UHD Graphics']);
    // AdapterRAM is 0 on some integrated chips, so the total falls back to what is in use.
    expect(gpus[1]).toMatchObject({ percent: 8.5, memUsedBytes: 1000, memTotalBytes: 1000 });
    // Only nvidia-smi reports a GPU temperature.
    expect(gpus.map((g) => g.tempC)).toEqual([58, null]);
  });
});
