import { beforeEach, describe, expect, it, vi } from 'vitest';
import { powerMonitor } from '../../test/main/electronMock';
import { withPlatform } from '../../test/main/fixtures';
import type { HwmonChip, ThermalZone } from './temperatureStats';

/**
 * The dashboard draws CPU temperature on the CPU chart. Every OS hides it somewhere else: Linux in
 * sysfs (next to a dozen other sensors that are not the CPU), Windows in ACPI thermal zones, and
 * macOS not at all without sudo, so a Mac shows its thermal pressure instead. These pin down which
 * sensor wins, that a wrong or missing one gives null rather than a made-up number, and that each
 * OS only touches its own source.
 */

type Answer = { stdout: string } | { error: Error };

const calls = vi.hoisted(() => [] as { command: string; args: string[] }[]);
const answers = vi.hoisted(() => ({ byCommand: {} as Record<string, Answer> }));
// A fake sysfs: file path to its contents, or an error to throw when it is read.
const sysfs = vi.hoisted(() => ({
  files: {} as Record<string, string | Error>,
  reads: [] as string[],
}));

vi.mock('node:child_process', () => ({
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

function notFound(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  });
}

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    sysfs.reads.push(path);
    const content = sysfs.files[path];
    if (content === undefined) throw notFound(path);
    if (content instanceof Error) throw content;
    return content;
  },
  readdir: async (path: string) => {
    sysfs.reads.push(path);
    const prefix = `${path}/`;
    const children = new Set<string>();
    for (const file of Object.keys(sysfs.files)) {
      if (file.startsWith(prefix)) children.add(file.slice(prefix.length).split('/')[0]);
    }
    if (children.size === 0) throw notFound(path);
    return [...children];
  },
}));

// The Linux sensor order depends on the architecture. Pinned, so an ARM runner reads the same.
vi.mock('./cpuArch', () => ({ readCpuArch: () => 'x64', normalizeArch: (raw: string) => raw }));

const { parseWindowsThermalZones, pickLinuxCpuTemp, sampleCpuTemperature, toThermalState } =
  await import('./temperatureStats');

beforeEach(() => {
  calls.length = 0;
  answers.byCommand = {};
  sysfs.files = {};
  sysfs.reads = [];
});

function chip(name: string, sensors: [label: string | undefined, milliC: number][]): HwmonChip {
  return { name, sensors: sensors.map(([label, milliC]) => ({ label, milliC })) };
}

function zone(type: string, milliC: number): ThermalZone {
  return { type, milliC };
}

const INTEL_DESKTOP = [
  chip('coretemp', [
    ['Package id 0', 52000],
    ['Core 0', 48000],
    ['Core 1', 55000],
    ['Core 2', 50000],
    ['Core 3', 49000],
  ]),
];

// A typical Intel laptop. Every one of these chips reports a temperature, and only coretemp is the CPU.
const INTEL_LAPTOP_HWMON = [
  chip('acpitz', [[undefined, 27800]]),
  chip('pch_cannonlake', [[undefined, 45000]]),
  chip('nvme', [
    ['Composite', 38850],
    ['Sensor 1', 38850],
  ]),
  chip('iwlwifi_1', [[undefined, 40000]]),
  chip('amdgpu', [['edge', 49000]]),
  chip('coretemp', [
    ['Package id 0', 58000],
    ['Core 0', 55000],
    ['Core 1', 60000],
  ]),
];
const INTEL_LAPTOP_ZONES = [
  zone('acpitz', 27800),
  zone('pch_cannonlake', 45000),
  zone('INT3400 Thermal', 20000),
  zone('x86_pkg_temp', 58000),
];

describe('pickLinuxCpuTemp', () => {
  it('reads the package sensor of an Intel CPU', () => {
    expect(pickLinuxCpuTemp(INTEL_DESKTOP, [], 'x64')).toBe(52);
  });

  it('picks coretemp out of the other sensors on a laptop', () => {
    expect(pickLinuxCpuTemp(INTEL_LAPTOP_HWMON, INTEL_LAPTOP_ZONES, 'x64')).toBe(58);
  });

  it('falls back to the hottest core when there is no package sensor', () => {
    const cores = [
      chip('coretemp', [
        ['Core 0', 48000],
        ['Core 1', 61000],
      ]),
    ];

    expect(pickLinuxCpuTemp(cores, [], 'x64')).toBe(61);
  });

  it('skips a package sensor with a bogus reading and uses the cores', () => {
    const broken = [
      chip('coretemp', [
        ['Package id 0', 0],
        ['Core 0', 47000],
      ]),
    ];

    expect(pickLinuxCpuTemp(broken, [], 'x64')).toBe(47);
  });

  it('reads Tctl on an AMD CPU', () => {
    const amd = [
      chip('nvme', [['Composite', 35850]]),
      chip('k10temp', [
        ['Tctl', 63125],
        ['Tccd1', 58000],
      ]),
    ];

    expect(pickLinuxCpuTemp(amd, [], 'x64')).toBe(63);
  });

  it('prefers Tdie over the offset Tctl when the chip reports both', () => {
    const offset = [
      chip('zenpower', [
        ['Tctl', 85000],
        ['Tdie', 65000],
      ]),
    ];

    expect(pickLinuxCpuTemp(offset, [], 'x64')).toBe(65);
  });

  it('uses the x86_pkg_temp zone when no CPU hwmon chip is there', () => {
    expect(pickLinuxCpuTemp([], INTEL_LAPTOP_ZONES, 'x64')).toBe(58);
  });

  it('reads the 32-bit x86 table the same way', () => {
    expect(pickLinuxCpuTemp(INTEL_DESKTOP, [], 'x86')).toBe(52);
  });

  it('gives null when only board and drive sensors are there', () => {
    const boardOnly = [chip('acpitz', [[undefined, 27800]]), chip('nvme', [['Composite', 38850]])];
    const zones = [zone('acpitz', 27800), zone('pch_skylake', 44000)];

    expect(pickLinuxCpuTemp(boardOnly, zones, 'x64')).toBeNull();
    // The ARM name match must not catch acpitz or the PCH either.
    expect(pickLinuxCpuTemp(boardOnly, zones, 'arm64')).toBeNull();
    expect(pickLinuxCpuTemp(boardOnly, zones, 'riscv64')).toBeNull();
  });

  it('reads cpu_thermal on a Raspberry Pi', () => {
    const pi = [chip('cpu_thermal', [[undefined, 48312]]), chip('rpi_volt', [])];

    expect(pickLinuxCpuTemp(pi, [zone('cpu-thermal', 48312)], 'arm')).toBe(48);
  });

  it('reads the hottest CPU zone on a Snapdragon', () => {
    const zones = [
      zone('xo-therm', 33000),
      zone('battery', 30000),
      zone('gpuss-0', 39000),
      zone('cpuss-0-usr', 41000),
      zone('cpuss-1-usr', 44500),
      zone('cpu-1-0-usr', 46000),
    ];

    expect(pickLinuxCpuTemp([], zones, 'arm64')).toBe(46);
  });

  it('reads MediaTek, Qualcomm tsens and SoC zones', () => {
    expect(pickLinuxCpuTemp([], [zone('mtktscpu', 52000)], 'arm64')).toBe(52);
    expect(pickLinuxCpuTemp([], [zone('tsens_tz_sensor1', 43000)], 'arm')).toBe(43);
    expect(pickLinuxCpuTemp([], [zone('soc_thermal', 50000)], 'arm64')).toBe(50);
  });

  it('gives null on an ARM server that exposes no CPU sensor', () => {
    expect(pickLinuxCpuTemp([chip('nvme', [['Composite', 36850]])], [], 'arm64')).toBeNull();
    expect(pickLinuxCpuTemp([], [], 'arm64')).toBeNull();
  });

  it('does not read an x86 chip on ARM or an ARM zone on x86', () => {
    expect(pickLinuxCpuTemp(INTEL_DESKTOP, [], 'arm64')).toBeNull();
    expect(pickLinuxCpuTemp([], [zone('cpu-thermal', 45000)], 'x64')).toBeNull();
  });

  it('tries both tables for an architecture it does not know', () => {
    expect(pickLinuxCpuTemp(INTEL_DESKTOP, [], 'riscv64')).toBe(52);
    expect(pickLinuxCpuTemp([], [zone('cpu0-thermal', 44000)], 'riscv64')).toBe(44);
  });

  it('filters readings outside 1 to 125 degrees', () => {
    const bogus = [
      chip('coretemp', [
        ['Package id 0', 0],
        ['Core 0', -273000],
        ['Core 1', 200000],
        ['Core 2', Number.NaN],
      ]),
    ];

    expect(pickLinuxCpuTemp(bogus, [zone('x86_pkg_temp', 200000)], 'x64')).toBeNull();
    expect(pickLinuxCpuTemp([], [zone('cpu-thermal', 0)], 'arm64')).toBeNull();
  });

  it('keeps a reading at the edges of the range', () => {
    expect(pickLinuxCpuTemp([chip('coretemp', [['Package id 0', 125000]])], [], 'x64')).toBe(125);
    expect(pickLinuxCpuTemp([chip('coretemp', [['Package id 0', 1000]])], [], 'x64')).toBe(1);
  });
});

describe('parseWindowsThermalZones', () => {
  it('prefers a zone whose name says CPU', () => {
    const zones = [
      { Name: '\\_TZ.TZ00', HighPrecisionTemperature: 3352, Temperature: 335 },
      { Name: '\\_TZ.CPUZ', HighPrecisionTemperature: 3282, Temperature: 328 },
    ];

    expect(parseWindowsThermalZones(zones)).toBe(55);
  });

  it('takes the hottest plausible zone when none is named for the CPU', () => {
    const zones = [
      { Name: '\\_TZ.TZ00', HighPrecisionTemperature: 3012, Temperature: 301 },
      { Name: '\\_TZ.TZ01', HighPrecisionTemperature: 3352, Temperature: 335 },
    ];

    expect(parseWindowsThermalZones(zones)).toBe(62);
  });

  it('reads a single zone, which ConvertTo-Json prints as an object', () => {
    expect(
      parseWindowsThermalZones({
        Name: '\\_TZ.THM0',
        HighPrecisionTemperature: 3232,
        Temperature: 323,
      }),
    ).toBe(50);
  });

  it('falls back to the whole-kelvin Temperature when there is no high-precision one', () => {
    expect(
      parseWindowsThermalZones([
        { Name: '\\_TZ.THM0', HighPrecisionTemperature: 0, Temperature: 318 },
      ]),
    ).toBe(45);
    expect(parseWindowsThermalZones([{ Name: '\\_TZ.THM0', Temperature: 318 }])).toBe(45);
  });

  it('ignores inactive zones, even one named for the CPU', () => {
    const zones = [
      { Name: '\\_TZ.CPUZ', HighPrecisionTemperature: 0, Temperature: 0 },
      // 273.2 K is 0 °C, what an unpopulated zone often reports.
      { Name: '\\_TZ.TZ01', HighPrecisionTemperature: 2732, Temperature: 273 },
      { Name: '\\_TZ.TZ00', HighPrecisionTemperature: 3132, Temperature: 313 },
    ];

    expect(parseWindowsThermalZones(zones)).toBe(40);
  });

  it('gives null when there is nothing plausible to read', () => {
    expect(parseWindowsThermalZones(null)).toBeNull();
    expect(parseWindowsThermalZones([])).toBeNull();
    expect(
      parseWindowsThermalZones([{ Name: '\\_TZ.TZ00', HighPrecisionTemperature: 5000 }]),
    ).toBeNull();
  });
});

describe('toThermalState', () => {
  it.each(['nominal', 'fair', 'serious', 'critical'] as const)('keeps %s', (state) => {
    expect(toThermalState(state)).toBe(state);
  });

  it('turns unknown and anything else into null', () => {
    expect(toThermalState('unknown')).toBeNull();
    expect(toThermalState('')).toBeNull();
    expect(toThermalState(undefined)).toBeNull();
  });
});

const NONE = { cpuTempC: null, cpuThermalState: null };

/** Lays out a laptop's /sys/class/hwmon and /sys/class/thermal in the fake sysfs. */
function writeLaptopSysfs(): void {
  INTEL_LAPTOP_HWMON.forEach((one, index) => {
    const dir = `/sys/class/hwmon/hwmon${index}`;
    sysfs.files[`${dir}/name`] = `${one.name}\n`;
    one.sensors.forEach((sensor, n) => {
      sysfs.files[`${dir}/temp${n + 1}_input`] = `${sensor.milliC}\n`;
      if (sensor.label) sysfs.files[`${dir}/temp${n + 1}_label`] = `${sensor.label}\n`;
    });
  });
  INTEL_LAPTOP_ZONES.forEach((one, index) => {
    const dir = `/sys/class/thermal/thermal_zone${index}`;
    sysfs.files[`${dir}/type`] = `${one.type}\n`;
    sysfs.files[`${dir}/temp`] = `${one.milliC}\n`;
  });
  // Not a chip or a zone, so never read as one.
  sysfs.files['/sys/class/thermal/cooling_device0/type'] = 'Processor\n';
}

describe('sampleCpuTemperature', () => {
  it('reads the thermal state on a Mac and starts no process', async () => {
    powerMonitor.getCurrentThermalState.mockReturnValue('serious');

    const result = await withPlatform('darwin', () => sampleCpuTemperature());

    expect(result).toEqual({ cpuTempC: null, cpuThermalState: 'serious' });
    expect(calls).toEqual([]);
    expect(sysfs.reads).toEqual([]);
  });

  it('gives no thermal state when a Mac reports unknown', async () => {
    await expect(withPlatform('darwin', () => sampleCpuTemperature())).resolves.toEqual(NONE);
  });

  it('reads ACPI thermal zones with one PowerShell call on Windows', async () => {
    answers.byCommand.powershell = {
      stdout: JSON.stringify([
        { Name: '\\_TZ.TZ00', HighPrecisionTemperature: 3012, Temperature: 301 },
        { Name: '\\_TZ.CPUZ', HighPrecisionTemperature: 3282, Temperature: 328 },
      ]),
    };

    const result = await withPlatform('win32', () => sampleCpuTemperature());

    expect(result).toEqual({ cpuTempC: 55, cpuThermalState: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell');
    const script = calls[0].args.join(' ');
    expect(script).toContain('Win32_PerfFormattedData_Counters_ThermalZoneInformation');
    expect(script).toContain('ConvertTo-Json -Compress');
    expect(powerMonitor.getCurrentThermalState).not.toHaveBeenCalled();
  });

  it('gives nulls when PowerShell fails or prints nothing', async () => {
    answers.byCommand.powershell = { error: new Error('Invalid class') };
    await expect(withPlatform('win32', () => sampleCpuTemperature())).resolves.toEqual(NONE);

    answers.byCommand.powershell = { stdout: '' };
    await expect(withPlatform('win32', () => sampleCpuTemperature())).resolves.toEqual(NONE);
  });

  it('reads sysfs on Linux and starts no process', async () => {
    writeLaptopSysfs();

    const result = await withPlatform('linux', () => sampleCpuTemperature());

    expect(result).toEqual({ cpuTempC: 58, cpuThermalState: null });
    expect(calls).toEqual([]);
    expect(powerMonitor.getCurrentThermalState).not.toHaveBeenCalled();
    expect(sysfs.reads).not.toContain('/sys/class/thermal/cooling_device0/type');
  });

  it('keeps the rest of a chip when one of its sensors cannot be read', async () => {
    writeLaptopSysfs();
    const coretemp = `/sys/class/hwmon/hwmon${INTEL_LAPTOP_HWMON.length - 1}`;
    sysfs.files[`${coretemp}/temp1_input`] = Object.assign(new Error('EIO'), { code: 'EIO' });

    const result = await withPlatform('linux', () => sampleCpuTemperature());

    // Package id 0 is gone, so the hottest core stands in.
    expect(result.cpuTempC).toBe(60);
  });

  it('falls back to the thermal zones when there is no hwmon folder', async () => {
    sysfs.files['/sys/class/thermal/thermal_zone0/type'] = 'x86_pkg_temp\n';
    sysfs.files['/sys/class/thermal/thermal_zone0/temp'] = '51000\n';

    await expect(withPlatform('linux', () => sampleCpuTemperature())).resolves.toEqual({
      cpuTempC: 51,
      cpuThermalState: null,
    });
  });

  it('gives nulls on Linux when sysfs has nothing', async () => {
    await expect(withPlatform('linux', () => sampleCpuTemperature())).resolves.toEqual(NONE);
  });

  it('gives nulls on any other OS without reading anything', async () => {
    const result = await withPlatform('freebsd', () => sampleCpuTemperature());

    expect(result).toEqual(NONE);
    expect(calls).toEqual([]);
    expect(sysfs.reads).toEqual([]);
    expect(powerMonitor.getCurrentThermalState).not.toHaveBeenCalled();
  });

  it('gives nulls when the thermal state call throws', async () => {
    powerMonitor.getCurrentThermalState.mockImplementation(() => {
      throw new Error('not ready');
    });

    await expect(withPlatform('darwin', () => sampleCpuTemperature())).resolves.toEqual(NONE);
  });
});
