import type {
  AlertInfo,
  MetricsSample,
  ServiceInfo,
  SystemInfo,
  UpdatesInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { diskPercent, memoryPercent, swapPercent } from './metrics';

/**
 * A server's health score: 100 for a server with nothing to worry about, minus points for each
 * thing worth a look. Busy hardware (processor, memory, swap, disk, load) costs the most, then
 * open alerts and failed services, then housekeeping (security updates, a reboot waiting, the
 * clock not in sync). Each finding names what it cost, so the tooltip can explain the number.
 */

export interface HealthInput {
  /** The newest live sample; without one there is no score yet. */
  sample?: MetricsSample;
  /** The last minute or so of samples, so one busy second does not move the score. */
  recent?: readonly MetricsSample[];
  info?: SystemInfo;
  updates?: UpdatesInfo;
  alerts?: readonly AlertInfo[];
  services?: readonly ServiceInfo[];
}

export interface HealthFinding {
  label: string;
  points: number;
}

export type HealthBand = 'good' | 'fair' | 'poor';

export interface Health {
  score: number;
  band: HealthBand;
  label: string;
  findings: HealthFinding[];
}

export const BAND_LABEL: Record<HealthBand, string> = {
  good: 'Healthy',
  fair: 'Needs a look',
  poor: 'In trouble',
};

/** How the score is made, for the tooltip under the findings. */
export const HEALTH_RULES =
  'Starts at 100. Processor or memory above 75% (90%), a disk above 80% (90%), load above one (two) per core, swap over half used, open alerts, failed services, security updates, a reboot waiting and a clock out of sync each take points off.';

function average(samples: readonly MetricsSample[], pick: (sample: MetricsSample) => number) {
  return samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
}

function tiered(value: number, warn: number, bad: number, small: number, big: number): number {
  if (value > bad) return big;
  if (value > warn) return small;
  return 0;
}

function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

export function healthScore(input: HealthInput): Health | null {
  const { sample } = input;
  if (!sample) return null;
  const recent = input.recent && input.recent.length > 0 ? input.recent : [sample];
  const findings: HealthFinding[] = [];
  const add = (label: string, points: number) => {
    if (points > 0) findings.push({ label, points });
  };

  const cpu = average(recent, (item) => item.cpuPercent);
  add(`Processor at ${percentText(cpu)}`, tiered(cpu, 75, 90, 10, 20));

  const memory = average(recent, memoryPercent);
  add(`Memory at ${percentText(memory)}`, tiered(memory, 80, 90, 10, 20));

  if (sample.swapTotalBytes > 0) {
    const swap = swapPercent(sample);
    add(`Swap at ${percentText(swap)}`, swap > 50 ? 5 : 0);
  }

  const disks = input.info?.disks.filter((disk) => disk.totalBytes > 0) ?? [];
  const fullest = disks
    .map((disk) => ({ name: disk.mountPoint, percent: (disk.usedBytes / disk.totalBytes) * 100 }))
    .sort((a, b) => b.percent - a.percent)[0] ?? { name: '/', percent: diskPercent(sample) };
  add(
    `Disk ${fullest.name} at ${percentText(fullest.percent)}`,
    tiered(fullest.percent, 80, 90, 10, 25),
  );

  const cores = input.info?.cpu.logicalCores ?? 0;
  if (cores > 0) {
    const perCore = sample.load1 / cores;
    add(`Load ${sample.load1.toFixed(2)} on ${cores} cores`, tiered(perCore, 1, 2, 5, 10));
  }

  const open = (input.alerts ?? []).filter((alert) => alert.resolvedAtUnixMs === undefined);
  const critical = open.filter((alert) => alert.severity === 'critical').length;
  const warning = open.filter((alert) => alert.severity === 'warning').length;
  if (critical > 0) {
    add(`${critical} critical ${critical === 1 ? 'alert' : 'alerts'}`, Math.min(30, critical * 20));
  }
  if (warning > 0) {
    add(`${warning} ${warning === 1 ? 'warning' : 'warnings'}`, Math.min(20, warning * 10));
  }

  const failed = (input.services ?? []).filter((service) => service.state === 'failed');
  if (failed.length > 0) {
    add(
      `${failed.map((service) => service.name).join(', ')} failed`,
      Math.min(20, failed.length * 10),
    );
  }

  const security = input.updates?.securityCount ?? 0;
  if (security > 0) {
    add(`${security} security ${security === 1 ? 'update' : 'updates'} waiting`, 5);
  }
  if (input.info?.rebootRequired || input.updates?.rebootRequired) add('A reboot is waiting', 5);
  if (input.info?.timeSync.synchronized === false) add('The clock is not in sync', 5);

  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + finding.points, 0));
  const band: HealthBand = score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor';
  return { score, band, label: BAND_LABEL[band], findings };
}
