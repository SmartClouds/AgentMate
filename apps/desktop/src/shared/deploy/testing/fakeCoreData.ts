import type {
  AlertInfo,
  JobInfo,
  MetricsSample,
  ServiceInfo,
  SystemInfo,
  UpdatesInfo,
} from '../protocol/generated/Runova.ServerCore.Contracts';

/**
 * Plausible answers from a server core, for tests on either side of IPC: an Ubuntu 24.04 server
 * with Docker and nginx, a few updates waiting, and metrics that move. Pass overrides for the
 * fields a test is about.
 */

const GIB = 1024 * 1024 * 1024;

export function sampleSystemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    hostname: 'prod-1',
    os: {
      id: 'ubuntu',
      versionId: '24.04',
      name: 'Ubuntu 24.04.1 LTS',
      family: 'debian',
      supported: true,
    },
    kernel: '6.8.0-45-generic',
    architecture: 'x86_64',
    cpu: { model: 'AMD EPYC 7B13', logicalCores: 4, physicalCores: 4, sockets: 1 },
    memoryTotalBytes: 8 * GIB,
    swapTotalBytes: 2 * GIB,
    disks: [
      {
        mountPoint: '/',
        device: '/dev/sda1',
        fileSystem: 'ext4',
        totalBytes: 80 * GIB,
        usedBytes: 31 * GIB,
        availableBytes: 45 * GIB,
      },
    ],
    networks: [
      { name: 'eth0', up: true, addresses: ['203.0.113.10', '2001:db8::10'], speedMbps: 1000 },
    ],
    publicAddresses: ['203.0.113.10'],
    bootedAtUnixMs: 1_700_000_000_000,
    timeSync: { synchronized: true, ntpEnabled: true, timeZone: 'Etc/UTC' },
    rebootRequiredBy: [],
    collectedAtUnixMs: 1_700_000_600_000,
    rebootRequired: false,
    ...overrides,
  };
}

export function sampleServices(): ServiceInfo[] {
  const service = (name: string, unit: string, canRestart: boolean): ServiceInfo => ({
    name,
    unit,
    description: name,
    state: 'active',
    subState: 'running',
    canRestart,
    enabledAtBoot: true,
  });
  return [
    service('SSH', 'ssh.service', false),
    service('Docker', 'docker.service', true),
    service('nginx', 'nginx.service', true),
  ];
}

export function sampleUpdates(overrides: Partial<UpdatesInfo> = {}): UpdatesInfo {
  return {
    packageManager: 'apt',
    packages: [
      {
        name: 'openssl',
        newVersion: '3.0.13-0ubuntu3.16',
        currentVersion: '3.0.13-0ubuntu3.15',
        source: 'noble-security',
        security: true,
      },
      {
        name: 'tzdata',
        newVersion: '2026c-0ubuntu0.24.04',
        currentVersion: '2026b-0ubuntu0.24.04',
        source: 'noble-updates',
        security: false,
      },
    ],
    securityCount: 1,
    automaticSecurityUpdates: {
      supported: true,
      installed: true,
      enabled: false,
      mechanism: 'unattended-upgrades',
    },
    checkedAtUnixMs: 1_700_000_500_000,
    rebootRequired: false,
    ...overrides,
  };
}

/** The n-th reading of a server whose load rises and falls, taken at `atUnixMs`. */
export function metricsSample(atUnixMs: number, n = 0): MetricsSample {
  const wave = (period: number) => (Math.sin(n / period) + 1) / 2;
  return {
    atUnixMs,
    cpuPercent: 10 + 60 * wave(5),
    cpuIowaitPercent: 2 * wave(7),
    cpuStealPercent: 0,
    load1: 0.4 + 2 * wave(5),
    load5: 0.5 + wave(9),
    load15: 0.6,
    memoryTotalBytes: 8 * GIB,
    memoryUsedBytes: Math.round((2.5 + 2 * wave(11)) * GIB),
    swapTotalBytes: 2 * GIB,
    swapUsedBytes: 0,
    networkReceiveBytesPerSecond: 20_000 + 400_000 * wave(3),
    networkTransmitBytesPerSecond: 10_000 + 150_000 * wave(4),
    diskReadBytesPerSecond: 50_000 * wave(6),
    diskWriteBytesPerSecond: 120_000 * wave(8),
    diskTotalBytes: 80 * GIB,
    diskUsedBytes: 31 * GIB,
  };
}

export function sampleJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'packagesUpgradeSecurity',
    title: 'Install security updates',
    state: 'running',
    createdAtUnixMs: 1_700_000_700_000,
    logLines: 0,
    cancellable: true,
    resource: 'packages',
    requestedBy: 'maria',
    ...overrides,
  };
}

export function sampleAlert(overrides: Partial<AlertInfo> = {}): AlertInfo {
  return {
    id: 1,
    revision: 1,
    kind: 'diskPressure',
    severity: 'warning',
    resource: '/',
    message: '/ is 91% full: 7.2 GB of 80 GB left.',
    firstSeenAtUnixMs: 1_700_000_800_000,
    lastSeenAtUnixMs: 1_700_000_800_000,
    occurrences: 1,
    ...overrides,
  };
}
