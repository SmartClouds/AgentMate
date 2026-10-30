import type {
  ImageInfo,
  NetworkInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  sampleDiskUsage,
  sampleImages,
  sampleNetworks,
} from '@shared/deploy/testing/fakeDockerData';
import { dockerBridge, SERVER } from '../../containers/testing/fixtures';

/**
 * The Containers fixtures plus what a server collects over time: an old release's image, an
 * untagged layer from a rebuild and a network a removed project left behind. The seeded Docker
 * already has a stopped container (migrate-once) and a volume nothing mounts (old-cache).
 */

export { SERVER };

const DAY = 86_400_000;
const MIB = 1024 * 1024;

export function oldImage(): ImageInfo {
  return {
    id: `sha256:${'a1'.repeat(32)}`,
    tags: ['shop-api:0.9'],
    digests: [],
    createdAtUnixMs: Date.now() - 60 * DAY,
    sizeBytes: 300 * MIB,
    containers: 0,
  };
}

export function danglingImage(): ImageInfo {
  return {
    id: `sha256:${'b2'.repeat(32)}`,
    tags: [],
    digests: [],
    createdAtUnixMs: Date.now() - 2 * DAY,
    sizeBytes: 40 * MIB,
    containers: 0,
  };
}

export function leftoverNetwork(): NetworkInfo {
  return {
    id: 'c3'.repeat(32),
    name: 'oldshop_default',
    driver: 'bridge',
    scope: 'local',
    internal: false,
    builtIn: false,
    subnets: ['172.21.0.0/16'],
    containers: 0,
    composeProject: 'oldshop',
  };
}

export function cleanupBridge(
  roles: string[] = ['owner'],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...dockerBridge(roles),
    'deployDocker.listImages': [...sampleImages(), oldImage(), danglingImage()],
    'deployDocker.listNetworks': [...sampleNetworks(), leftoverNetwork()],
    'deployDocker.diskUsage': sampleDiskUsage(),
    'deployDocker.remove': async () => undefined,
    'deployDocker.removeImage': async () => undefined,
    'deployDocker.removeVolume': async () => undefined,
    'deployDocker.removeNetwork': async () => undefined,
    'deployDocker.prune': async () => ({ removed: 12, reclaimedBytes: 300 * MIB }),
    ...overrides,
  };
}
