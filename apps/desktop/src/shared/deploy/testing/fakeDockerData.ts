import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerLogLine,
  ContainerStatsSample,
  ContainerSummary,
  DockerDiskUsage,
  DockerStatus,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from '../protocol/generated/Runova.ServerCore.Contracts';

/**
 * Docker on a pretend server, as the DevHost seeds it, for tests on either side of IPC: a
 * "shop" project (web, api, db, worker), a "monitoring" project (grafana, prometheus), a
 * toolbox container and a one-off migration that has exited. Some environment values are
 * secrets that must never reach a prompt; `PLANTED_SECRETS` lists them for the tests.
 */

const MIB = 1024 * 1024;
const T0 = 1_700_000_000_000;

export const DB_PASSWORD = 'hunter2-db-password-7f3a';
export const API_TOKEN = 'tok_live_9f8e7d6c5b4a3f2e';
export const GRAFANA_PASSWORD = 'grafana-admin-91ac';
export const PLANTED_SECRETS = [DB_PASSWORD, API_TOKEN, GRAFANA_PASSWORD];

/** A stable 64-character hex id for a container name. */
export function containerIdOf(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, '0').repeat(8);
}

export function sampleDockerStatus(overrides: Partial<DockerStatus> = {}): DockerStatus {
  return {
    installed: true,
    running: true,
    composeSupported: true,
    conflictingPackages: [],
    engineVersion: '29.1.3',
    apiVersion: '1.52',
    composeVersion: '2.39.4',
    storageDriver: 'overlayfs',
    cgroupVersion: 2,
    ...overrides,
  };
}

export interface SeedContainer {
  summary: ContainerSummary;
  details: Omit<ContainerDetails, 'summary' | 'envKeys'>;
  env: ContainerEnvVariable[];
}

function seed(
  name: string,
  image: string,
  options: {
    project?: string;
    service?: string;
    state?: ContainerSummary['state'];
    health?: ContainerSummary['health'];
    ports?: ContainerSummary['ports'];
    env?: Array<[string, string]>;
    command?: string[];
    mounts?: ContainerDetails['mounts'];
    memoryLimitBytes?: number;
    tty?: boolean;
  } = {},
): SeedContainer {
  const state = options.state ?? 'running';
  return {
    summary: {
      id: containerIdOf(name),
      name,
      image,
      imageId: `sha256:${containerIdOf(image)}`,
      state,
      status: state === 'running' ? 'Up 30 hours' : 'Exited (0) 12 hours ago',
      health: options.health ?? 'none',
      createdAtUnixMs: T0,
      ports: options.ports ?? [],
      ...(options.project
        ? { composeProject: options.project, composeService: options.service, composeNumber: 1 }
        : {}),
    },
    details: {
      command: options.command ?? [],
      entrypoint: [],
      labels: options.project
        ? [
            { name: 'com.docker.compose.project', value: options.project },
            { name: 'com.docker.compose.service', value: options.service ?? name },
          ]
        : [],
      mounts: options.mounts ?? [],
      networks: [
        {
          network: options.project ? `${options.project}_default` : 'bridge',
          ipAddress: '172.20.0.5',
        },
      ],
      restartPolicy: options.project ? 'unless-stopped' : 'no',
      restartCount: 0,
      tty: options.tty ?? false,
      privileged: false,
      oomKilled: false,
      hostname: containerIdOf(name).slice(0, 12),
      startedAtUnixMs: T0 + 60_000,
      ...(state === 'exited' ? { finishedAtUnixMs: T0 + 120_000, exitCode: 0 } : {}),
      ...(options.memoryLimitBytes ? { memoryLimitBytes: options.memoryLimitBytes } : {}),
    },
    env: (options.env ?? []).map(([key, value]) => ({ name: key, value })),
  };
}

export function seedContainers(): SeedContainer[] {
  return [
    seed('shop-web-1', 'nginx:1.29', {
      project: 'shop',
      service: 'web',
      health: 'healthy',
      ports: [{ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 8080 }],
      env: [['NGINX_ENTRYPOINT_QUIET_LOGS', '1']],
      command: ['nginx', '-g', 'daemon off;'],
      mounts: [
        {
          type: 'volume',
          destination: '/srv/uploads',
          readWrite: false,
          source: '/var/lib/docker/volumes/shop_uploads/_data',
          name: 'shop_uploads',
        },
      ],
    }),
    seed('shop-api-1', 'shop-api:latest', {
      project: 'shop',
      service: 'api',
      health: 'healthy',
      ports: [{ privatePort: 3000, protocol: 'tcp' }],
      env: [
        ['NODE_ENV', 'production'],
        ['PORT', '3000'],
        ['DATABASE_URL', `postgres://shop:${DB_PASSWORD}@db:5432/shop`],
        ['API_TOKEN', API_TOKEN],
      ],
      command: ['node', 'server.js'],
      memoryLimitBytes: 512 * MIB,
    }),
    seed('shop-db-1', 'postgres:17', {
      project: 'shop',
      service: 'db',
      health: 'healthy',
      ports: [{ privatePort: 5432, protocol: 'tcp' }],
      env: [
        ['POSTGRES_USER', 'shop'],
        ['POSTGRES_PASSWORD', DB_PASSWORD],
      ],
      command: ['postgres'],
      mounts: [
        {
          type: 'volume',
          destination: '/var/lib/postgresql/data',
          readWrite: true,
          source: '/var/lib/docker/volumes/shop_db-data/_data',
          name: 'shop_db-data',
        },
      ],
    }),
    seed('shop-worker-1', 'shop-api:latest', {
      project: 'shop',
      service: 'worker',
      env: [['QUEUE_URL', `redis://worker:${API_TOKEN}@redis:6379/0`]],
      command: ['node', 'worker.js'],
      tty: true,
    }),
    seed('monitoring-grafana-1', 'grafana/grafana:12.1.1', {
      project: 'monitoring',
      service: 'grafana',
      ports: [
        { privatePort: 3000, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 3001 },
        { privatePort: 3000, protocol: 'tcp', hostIp: '::', hostPort: 3001 },
      ],
      env: [['GF_SECURITY_ADMIN_PASSWORD', GRAFANA_PASSWORD]],
      command: ['/run.sh'],
    }),
    seed('monitoring-prometheus-1', 'prom/prometheus:v3.5.0', {
      project: 'monitoring',
      service: 'prometheus',
      ports: [{ privatePort: 9090, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 9090 }],
      command: ['/bin/prometheus', '--config.file=/etc/prometheus/prometheus.yml'],
    }),
    seed('toolbox', 'debian:13', { command: ['sleep', 'infinity'] }),
    seed('migrate-once', 'shop-api:latest', {
      state: 'exited',
      env: [['DATABASE_URL', `postgres://shop:${DB_PASSWORD}@db:5432/shop`]],
      command: ['node', 'migrate.js'],
    }),
  ];
}

/** The n-th reading of a container whose load rises and falls. */
export function containerStatsSample(
  containerId: string,
  atUnixMs: number,
  n = 0,
  overrides: Partial<ContainerStatsSample> = {},
): ContainerStatsSample {
  const wave = (period: number) => (Math.sin(n / period) + 1) / 2;
  const used = Math.round((80 + 40 * wave(5)) * MIB);
  const limit = 2048 * MIB;
  return {
    containerId,
    atUnixMs,
    cpuPercent: 4 + 30 * wave(4),
    onlineCpus: 4,
    memoryUsedBytes: used,
    memoryLimitBytes: limit,
    memoryPercent: (used / limit) * 100,
    networkReceivedBytes: 1_000_000 + n * 50_000,
    networkTransmittedBytes: 500_000 + n * 20_000,
    blockReadBytes: 4_000_000 + n * 4_096,
    blockWrittenBytes: 8_000_000 + n * 16_384,
    pids: 12,
    ...overrides,
  };
}

export function logLine(
  text: string,
  atUnixMs: number,
  stream: ContainerLogLine['stream'] = 'stdout',
): ContainerLogLine {
  // Docker's RFC 3339 time with nanoseconds, which is what resuming a log goes by.
  const timestamp = `${new Date(atUnixMs).toISOString().slice(0, 19)}.${String(atUnixMs % 1000).padStart(3, '0')}000000Z`;
  return { stream, timestamp, atUnixMs, text };
}

export function sampleImages(): ImageInfo[] {
  const image = (tag: string, sizeBytes: number, containers: number): ImageInfo => ({
    id: `sha256:${containerIdOf(tag)}`,
    tags: [tag],
    digests: [`${tag.split(':')[0]}@sha256:${containerIdOf(`${tag}-digest`)}`],
    createdAtUnixMs: T0 - 86_400_000,
    sizeBytes,
    containers,
  });
  return [
    image('nginx:1.29', 192_741_376, 1),
    image('shop-api:latest', 238_612_480, 3),
    image('postgres:17', 456_212_480, 1),
    image('debian:13', 120_586_240, 1),
  ];
}

export function sampleVolumes(): VolumeInfo[] {
  return [
    {
      name: 'shop_db-data',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/shop_db-data/_data',
      containers: 1,
      sizeBytes: 512 * MIB,
      composeProject: 'shop',
    },
    {
      name: 'shop_uploads',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/shop_uploads/_data',
      containers: 2,
      sizeBytes: 96 * MIB,
      composeProject: 'shop',
    },
    {
      name: 'old-cache',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/old-cache/_data',
      containers: 0,
    },
  ];
}

export function sampleNetworks(): NetworkInfo[] {
  const network = (
    name: string,
    builtIn: boolean,
    subnets: string[],
    containers: number,
    composeProject?: string,
  ): NetworkInfo => ({
    id: containerIdOf(`net-${name}`),
    name,
    driver: builtIn && name !== 'bridge' ? name : 'bridge',
    scope: 'local',
    internal: false,
    builtIn,
    subnets,
    containers,
    ...(composeProject ? { composeProject } : {}),
  });
  return [
    network('bridge', true, ['172.17.0.0/16'], 2),
    network('host', true, [], 0),
    network('shop_default', false, ['172.20.0.0/16'], 4, 'shop'),
  ];
}

export function sampleDiskUsage(): DockerDiskUsage {
  return {
    images: { count: 6, active: 5, sizeBytes: 2_055_680_000, reclaimableBytes: 120_586_240 },
    containers: { count: 8, active: 7, sizeBytes: 48 * MIB, reclaimableBytes: 2 * MIB },
    volumes: { count: 4, active: 3, sizeBytes: 1_960 * MIB, reclaimableBytes: 4 * MIB },
    buildCache: { count: 12, active: 0, sizeBytes: 300 * MIB, reclaimableBytes: 300 * MIB },
  };
}
