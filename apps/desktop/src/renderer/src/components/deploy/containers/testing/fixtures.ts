import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeDocker } from '@shared/deploy/testing/fakeDocker';
import {
  containerStatsSample,
  logLine,
  sampleDiskUsage,
  sampleDockerStatus,
  sampleImages,
  sampleNetworks,
  sampleVolumes,
} from '@shared/deploy/testing/fakeDockerData';
import { connection, SERVER } from '../../overview/testing/fixtures';
import { signedIn } from '../../security/testing/fixtures';

/** A signed-in user looking at the DevHost-like Docker of a server, for the Containers tests. */

export { SERVER };

export const T0 = Date.UTC(2026, 9, 2, 8, 0, 0);

export function seededDocker(): FakeDocker {
  return new FakeDocker({ now: () => T0, openConnections: [] });
}

export function container(name: string): ContainerSummary {
  const found = seededDocker().find(name);
  if (!found) throw new Error(`No seeded container ${name}`);
  return found.summary;
}

export function statsBatch(at = T0, n = 0) {
  const docker = seededDocker();
  return {
    atUnixMs: at,
    samples: docker.containers
      .filter((one) => one.summary.state === 'running')
      .map((one) => containerStatsSample(one.summary.id, at, n)),
    stopped: [],
  };
}

export function logLines(texts: Array<[string, 'stdout' | 'stderr']>) {
  return texts.map(([text, stream], n) => logLine(text, T0 + n * 1_000, stream));
}

export function dockerBridge(roles: string[] = ['owner']): Record<string, unknown> {
  const docker = seededDocker();
  return {
    'deploy.access': signedIn(roles),
    'deploy.connection': connection('online'),
    'deployDocker.status': sampleDockerStatus(),
    'deployDocker.listContainers': docker.list(),
    'deployDocker.inspect': async (_serverId: string, id: string) =>
      docker.details(docker.require(id)),
    'deployDocker.watchStats': async () => 'stats-1',
    'deployDocker.unwatchStats': async () => true,
    'deployDocker.watchEvents': async () => 'events-1',
    'deployDocker.unwatchEvents': async () => true,
    'deployDocker.watchLogs': async () => 'logs-1',
    'deployDocker.unwatchLogs': async () => true,
    'deployDocker.listImages': sampleImages(),
    'deployDocker.listVolumes': sampleVolumes(),
    'deployDocker.listNetworks': sampleNetworks(),
    'deployDocker.diskUsage': sampleDiskUsage(),
    'deployDocker.act': async (input: { containerId: string; action: string }) =>
      docker.setState(
        input.containerId,
        input.action === 'stop' ? 'exited' : 'running',
        input.action,
      ),
    'deployDocker.remove': async () => undefined,
    'deployDocker.logTail': [],
    'deployJobs.watch': async () => 'job-1',
    'deployJobs.unwatch': async () => true,
    'projects.list': [],
  };
}
