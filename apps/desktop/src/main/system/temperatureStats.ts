import { readdir, readFile } from 'node:fs/promises';
import { powerMonitor } from 'electron';
import type { CpuArch, CpuThermalState, SystemStatsSample } from '../../shared/apiTypes';
import { readCpuArch } from './cpuArch';
import { asArray, runPowerShellJson } from './processTree';

export type CpuTemperature = Pick<SystemStatsSample, 'cpuTempC' | 'cpuThermalState'>;

const NO_TEMPERATURE: CpuTemperature = { cpuTempC: null, cpuThermalState: null };

// Sensors report 0, -273 or a raw register value when they are not wired up. Anything outside this
// range is not a CPU temperature, and the chart hides the line rather than drawing it.
const MIN_PLAUSIBLE_C = 1;
const MAX_PLAUSIBLE_C = 125;

function plausible(celsius: number): number | null {
  return Number.isFinite(celsius) && celsius >= MIN_PLAUSIBLE_C && celsius <= MAX_PLAUSIBLE_C
    ? celsius
    : null;
}

function hottest(values: (number | null)[]): number | null {
  const readings = values.filter((value): value is number => value != null);
  return readings.length > 0 ? Math.max(...readings) : null;
}

/** One `/sys/class/hwmon/hwmonN` chip: its driver name and the `tempN_*` sensors it exposes. */
export interface HwmonChip {
  name: string;
  sensors: { label?: string; milliC: number }[];
}

/** One `/sys/class/thermal/thermal_zoneN`. */
export interface ThermalZone {
  type: string;
  milliC: number;
}

type LinuxSource = { hwmon: RegExp; labels: RegExp[] } | { zone: RegExp };

// ARM boards name their CPU sensors after the CPU or the SoC: cpu_thermal on a Raspberry Pi,
// cpuss-0-usr on a Snapdragon, mtktscpu on MediaTek, tsens_tz_sensorN on older Qualcomm parts.
// Anchored at the start so it can never match acpitz or pch_* (board and chipset sensors).
const ARM_CPU_NAME = /^(cpu|soc|mtktscpu|tsens)/i;

// A laptop exposes a dozen chips (acpitz, pch_*, nvme, iwlwifi, amdgpu), so only the CPU drivers
// count. coretemp is Intel and k10temp/zenpower are AMD. On older Ryzen parts Tctl carries a fan
// control offset, so Tdie, when there is one, is the real die temperature.
const X86_SOURCES: LinuxSource[] = [
  { hwmon: /^coretemp$/, labels: [/^Package id \d+$/, /^Core \d+$/] },
  { hwmon: /^(k10temp|zenpower)$/, labels: [/^Tdie$/, /^Tctl$/] },
  { zone: /^x86_pkg_temp$/ },
];

// Graviton and Ampere servers usually expose no CPU sensor at all, which ends up as null.
const ARM_SOURCES: LinuxSource[] = [{ hwmon: ARM_CPU_NAME, labels: [] }, { zone: ARM_CPU_NAME }];

function sourcesFor(arch: CpuArch): LinuxSource[] {
  if (arch === 'x64' || arch === 'x86') return X86_SOURCES;
  if (arch === 'arm64' || arch === 'arm') return ARM_SOURCES;
  return [...X86_SOURCES, ...ARM_SOURCES];
}

// The first label pattern with a plausible reading wins (the hottest of its matches, so a two
// socket machine shows its hotter package). A chip whose labels match none uses its hottest sensor.
function readChip(chip: HwmonChip, labels: RegExp[]): number | null {
  const readings = chip.sensors.map((sensor) => ({
    label: sensor.label ?? '',
    celsius: plausible(sensor.milliC / 1000),
  }));
  for (const pattern of labels) {
    const matched = hottest(readings.filter((r) => pattern.test(r.label)).map((r) => r.celsius));
    if (matched != null) return matched;
  }
  return hottest(readings.map((r) => r.celsius));
}

function readSource(source: LinuxSource, chips: HwmonChip[], zones: ThermalZone[]): number | null {
  if ('hwmon' in source) {
    const { hwmon, labels } = source;
    return hottest(chips.filter((c) => hwmon.test(c.name)).map((c) => readChip(c, labels)));
  }
  return hottest(
    zones.filter((z) => source.zone.test(z.type)).map((z) => plausible(z.milliC / 1000)),
  );
}

/**
 * The CPU temperature in whole °C out of everything Linux reports, or null when none of the
 * sensors is the CPU. The architecture decides which driver names count and in what order.
 */
export function pickLinuxCpuTemp(
  chips: HwmonChip[],
  zones: ThermalZone[],
  arch: CpuArch,
): number | null {
  for (const source of sourcesFor(arch)) {
    const celsius = readSource(source, chips, zones);
    if (celsius != null) return Math.round(celsius);
  }
  return null;
}

/** One row of the ThermalZoneInformation counter set. */
export interface WindowsThermalZone {
  /** e.g. `\_TZ.TZ00` or `\_TZ.CPUZ`, the ACPI name the firmware gave the zone. */
  Name?: string;
  /** Tenths of a kelvin. */
  HighPrecisionTemperature?: number | null;
  /** Whole kelvin. */
  Temperature?: number | null;
}

function zoneCelsius(zone: WindowsThermalZone): number | null {
  return (
    plausible(Number(zone.HighPrecisionTemperature) / 10 - 273.15) ??
    plausible(Number(zone.Temperature) - 273.15)
  );
}

/**
 * The CPU temperature in whole °C out of Windows' ACPI thermal zones. A zone named for the CPU
 * wins. Otherwise the hottest one stands in, which on many machines is a board sensor near the CPU
 * rather than the package itself.
 */
export function parseWindowsThermalZones(
  parsed: WindowsThermalZone | WindowsThermalZone[] | null | undefined,
): number | null {
  const readings = asArray(parsed)
    .filter((zone) => zone != null && typeof zone === 'object')
    .map((zone) => ({ name: String(zone.Name ?? ''), celsius: zoneCelsius(zone) }))
    .filter((reading) => reading.celsius != null);
  const named = readings.filter((reading) => /cpu/i.test(reading.name));
  const celsius = hottest((named.length > 0 ? named : readings).map((r) => r.celsius));
  return celsius == null ? null : Math.round(celsius);
}

const THERMAL_STATES: readonly CpuThermalState[] = ['nominal', 'fair', 'serious', 'critical'];

/** Electron's thermal state, with `'unknown'` (every OS but macOS) as null. */
export function toThermalState(value: string | undefined): CpuThermalState | null {
  return THERMAL_STATES.find((state) => state === value) ?? null;
}

// Perf counters rather than MSAcpi_ThermalZoneTemperature, which needs admin rights.
const WIN_THERMAL_ZONE_SCRIPT =
  'Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Select-Object Name, HighPrecisionTemperature, Temperature | ConvertTo-Json -Compress';

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf-8')).trim();
  } catch {
    return null;
  }
}

async function listDir(path: string, pattern: RegExp): Promise<string[]> {
  try {
    return (await readdir(path)).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

const HWMON_ROOT = '/sys/class/hwmon';
const THERMAL_ROOT = '/sys/class/thermal';

// Each sensor is read on its own: some temp*_input files fail with EIO or ENODATA, and one bad
// sensor must not drop the rest of its chip.
async function readHwmonChips(): Promise<HwmonChip[]> {
  const dirs = await listDir(HWMON_ROOT, /^hwmon\d+$/);
  return Promise.all(
    dirs.map(async (dir) => {
      const base = `${HWMON_ROOT}/${dir}`;
      const [name, inputs] = await Promise.all([
        readText(`${base}/name`),
        listDir(base, /^temp\d+_input$/),
      ]);
      const sensors = await Promise.all(
        inputs.map(async (input) => {
          const prefix = input.slice(0, -'_input'.length);
          const [raw, label] = await Promise.all([
            readText(`${base}/${input}`),
            readText(`${base}/${prefix}_label`),
          ]);
          return { label: label ?? undefined, milliC: raw == null ? Number.NaN : Number(raw) };
        }),
      );
      return { name: name ?? '', sensors };
    }),
  );
}

async function readThermalZones(): Promise<ThermalZone[]> {
  const dirs = await listDir(THERMAL_ROOT, /^thermal_zone\d+$/);
  return Promise.all(
    dirs.map(async (dir) => {
      const base = `${THERMAL_ROOT}/${dir}`;
      const [type, raw] = await Promise.all([readText(`${base}/type`), readText(`${base}/temp`)]);
      return { type: type ?? '', milliC: raw == null ? Number.NaN : Number(raw) };
    }),
  );
}

// Memory modules only carry a sensor on DDR5 and on some (mostly server and ECC) DDR4 sticks.
// jc42 is the DDR4 thermal sensor driver and spd5118 the DDR5 one.
const MEMORY_CHIP = /^(jc42|spd5118)$/;

/** The hottest memory module in whole °C, or null when no module has a sensor. */
export function pickLinuxMemoryTemp(chips: HwmonChip[]): number | null {
  const celsius = hottest(
    chips.filter((c) => MEMORY_CHIP.test(c.name)).map((c) => readChip(c, [])),
  );
  return celsius == null ? null : Math.round(celsius);
}

/** One drive's reading as the Windows drive script prints it. */
export interface WindowsDiskTemp {
  /** The physical disk number, the same one PerfDisk puts at the start of its instance names. */
  Disk: number;
  Celsius: number | null;
}

/** Drive temperatures in whole °C keyed by physical disk number. Implausible readings are dropped. */
export function parseWindowsDiskTemps(
  parsed: WindowsDiskTemp | WindowsDiskTemp[] | null | undefined,
): Record<string, number> {
  const temps: Record<string, number> = {};
  for (const reading of asArray(parsed)) {
    const celsius = plausible(Number(reading?.Celsius));
    if (celsius != null) temps[String(reading.Disk)] = Math.round(celsius);
  }
  return temps;
}

// Get-StorageReliabilityCounter has the drive temperature too but needs admin rights. The storage
// driver answers IOCTL_STORAGE_QUERY_PROPERTY (0x2D1400) for StorageDeviceTemperatureProperty (52)
// on a handle opened with no access rights at all, which any user may do. The reply is a
// STORAGE_TEMPERATURE_DATA_DESCRIPTOR: InfoCount at byte 12, and the first sensor (the drive's
// composite temperature) as a signed °C at byte 26. Disk numbers past the last drive fail to open
// and are skipped. Raw, so the C# backslashes reach PowerShell as written.
const WIN_DISK_TEMP_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RunovaDiskTemp {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
  public static int Read(int disk) {
    using (var device = CreateFile(@"\\.\PhysicalDrive" + disk, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (device.IsInvalid) return int.MinValue;
      var query = new byte[12];
      BitConverter.GetBytes(52).CopyTo(query, 0);
      var output = new byte[512];
      int returned;
      if (!DeviceIoControl(device, 0x2D1400, query, query.Length, output, output.Length, out returned, IntPtr.Zero)) return int.MinValue;
      if (BitConverter.ToUInt16(output, 12) == 0) return int.MinValue;
      return BitConverter.ToInt16(output, 26);
    }
  }
}
'@
$readings = foreach ($disk in 0..31) { $c = [RunovaDiskTemp]::Read($disk); if ($c -ne [int]::MinValue) { [PSCustomObject]@{ Disk = $disk; Celsius = $c } } }
if ($readings) { @($readings) | ConvertTo-Json -Compress }
`;

/** Whole disks (sda, nvme0n1, vda and so on), the same names /proc/diskstats charts. */
export const WHOLE_DISK_NAME = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/;

const BLOCK_ROOT = '/sys/block';

// An NVMe controller holds its hwmonN folder directly. A SATA disk has one under hwmon/, and only
// when the drivetemp module is loaded. temp1 is the drive's own (composite) temperature.
async function readLinuxDiskTemp(disk: string): Promise<number | null> {
  const device = `${BLOCK_ROOT}/${disk}/device`;
  const [direct, nested] = await Promise.all([
    listDir(device, /^hwmon\d+$/),
    listDir(`${device}/hwmon`, /^hwmon\d+$/),
  ]);
  const dirs = [
    ...direct.map((d) => `${device}/${d}`),
    ...nested.map((d) => `${device}/hwmon/${d}`),
  ];
  for (const dir of dirs) {
    const celsius = plausible(Number(await readText(`${dir}/temp1_input`)) / 1000);
    if (celsius != null) return Math.round(celsius);
  }
  return null;
}

/**
 * Drive temperatures in whole °C, keyed the way the disk chart names drives: the physical disk
 * number on Windows, the block device name on Linux. A drive without a reading is left out, and
 * macOS has none.
 */
export async function sampleDiskTemperatures(): Promise<Record<string, number>> {
  try {
    if (process.platform === 'win32') {
      return parseWindowsDiskTemps(
        await runPowerShellJson<WindowsDiskTemp | WindowsDiskTemp[]>(WIN_DISK_TEMP_SCRIPT),
      );
    }
    if (process.platform === 'linux') {
      const disks = await listDir(BLOCK_ROOT, WHOLE_DISK_NAME);
      const temps: Record<string, number> = {};
      const readings = await Promise.all(disks.map(readLinuxDiskTemp));
      disks.forEach((disk, i) => {
        const celsius = readings[i];
        if (celsius != null) temps[disk] = celsius;
      });
      return temps;
    }
  } catch {
    // Falls through to no readings.
  }
  return {};
}

/** The hottest memory module in °C. Linux only: Windows and macOS give apps no way to read it. */
export async function sampleMemoryTemperature(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    return pickLinuxMemoryTemp(await readHwmonChips());
  } catch {
    return null;
  }
}

const cpuArch = readCpuArch();

/**
 * The CPU temperature where the OS gives one without admin rights. Linux reads sysfs (no process),
 * Windows asks PowerShell for the ACPI thermal zones, and macOS only reports thermal pressure, so
 * cpuTempC is null there. Never throws: anything that goes wrong is a null reading.
 */
export async function sampleCpuTemperature(): Promise<CpuTemperature> {
  try {
    if (process.platform === 'darwin') {
      return {
        cpuTempC: null,
        cpuThermalState: toThermalState(powerMonitor.getCurrentThermalState()),
      };
    }
    if (process.platform === 'win32') {
      const zones = await runPowerShellJson<WindowsThermalZone | WindowsThermalZone[]>(
        WIN_THERMAL_ZONE_SCRIPT,
      );
      return { cpuTempC: parseWindowsThermalZones(zones), cpuThermalState: null };
    }
    if (process.platform === 'linux') {
      const [chips, zones] = await Promise.all([readHwmonChips(), readThermalZones()]);
      return { cpuTempC: pickLinuxCpuTemp(chips, zones, cpuArch), cpuThermalState: null };
    }
  } catch {
    // Falls through to no reading.
  }
  return NO_TEMPERATURE;
}
