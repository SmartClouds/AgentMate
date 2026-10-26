import type { MetricsHistory } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  metricsSample,
  sampleAlert,
  sampleJob,
  sampleServices,
  sampleSystemInfo,
  sampleUpdates,
} from '@shared/deploy/testing/fakeCoreData';
import type { DeployConnection, DeployConnectionState } from '@shared/deployTypes';
import { SERVER, signedIn } from '../../security/testing/fixtures';

/** A signed-in Owner looking at a quiet Ubuntu server, for the Overview's tests. */

export { SERVER };

export const T0 = Date.now() - 60_000;

export function samples(count: number, from = T0) {
  return Array.from({ length: count }, (_, n) => metricsSample(from + n * 2_000, n));
}

export function history(count = 5): MetricsHistory {
  return { resolution: 'live', intervalSeconds: 2, samples: samples(count) };
}

export function connection(state: DeployConnectionState, extra: Partial<DeployConnection> = {}) {
  return { serverId: SERVER.id, state, since: Date.now(), ...extra };
}

export const STEP_UP_REFUSAL = new Error(
  "Error invoking remote method 'deploySystem:upgradeAll': Error: [core:stepUpRequired] Confirm your password (or a code from your authenticator app) to do this.",
);

export function overviewBridge(roles: string[] = ['owner']): Record<string, unknown> {
  return {
    'deploy.access': signedIn(roles),
    'deploy.connection': connection('online'),
    'deploy.health': {
      version: '1.53.0',
      apiVersion: 1,
      startedAtUnixMs: T0,
      checkedAt: Date.now(),
    },
    'deploySystem.info': sampleSystemInfo(),
    'deploySystem.services': sampleServices(),
    'deploySystem.updates': sampleUpdates(),
    'deploySystem.metricsHistory': history(),
    'deploySystem.watchMetrics': async () => 'metrics-1',
    'deploySystem.unwatchMetrics': async () => true,
    'deployJobs.list': { jobs: [] },
    'deployJobs.watch': async () => 'log-1',
    'deployJobs.unwatch': async () => true,
    'deployAlerts.list': [sampleAlert({ lastSeenAtUnixMs: Date.now() - 120_000 })],
    'deployAlerts.watch': async () => 'alerts-1',
    'deployAlerts.unwatch': async () => true,
  };
}

export { metricsSample, sampleAlert, sampleJob, sampleServices, sampleSystemInfo, sampleUpdates };
