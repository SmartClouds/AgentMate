import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  AlertQuery,
  JobQuery,
  ManagedService,
  MetricsHistoryRequest,
  MetricsResolution,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployJobWatchInput, DeployMetricsWatchInput } from '../../shared/deployTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeploySubscriptions, SubscriptionOwner } from '../deploy/live/subscriptions';
import type { DeploySystem } from '../deploy/system';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';
import { sendToContents } from './send';

/**
 * The Deploy Overview's invoke channels (E05): `deploySystem` for the server itself, `deployJobs`
 * for the jobs its buttons start, `deployAlerts` for its alerts. Like the `deploy` group they
 * answer only the main window and check every argument here. A live subscription belongs to
 * the window that opened it and ends when that window reloads, crashes or closes.
 */

export interface DeploySystemHandlerDeps {
  ipc: DeployIpcRegistry;
  system: DeploySystem;
  subscriptions: Pick<DeploySubscriptions, 'watchMetrics' | 'watchJob' | 'watchAlerts' | 'unwatch'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
  /** The window behind a call, as the owner of what it subscribes to. */
  owner: (event: IpcMainInvokeEvent) => SubscriptionOwner;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLUTIONS: ReadonlySet<string> = new Set<MetricsResolution>([
  'live',
  'minute',
  'quarterHour',
]);
const SERVICES: ReadonlySet<string> = new Set<ManagedService>(['docker', 'nginx']);
/** The core's own limits: 1 to 60 second samples, 200 jobs a page, 500 alerts. */
const INTERVAL = { min: 1_000, max: 60_000 };
const JOB_PAGE = { min: 1, max: 200 };
const ALERT_PAGE = { min: 1, max: 500 };
const POSITIVE = { min: 1, max: Number.MAX_SAFE_INTEGER };
const NON_NEGATIVE = { min: 0, max: Number.MAX_SAFE_INTEGER };

function guid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

function whole(value: unknown, range: { min: number; max: number }, what: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < range.min ||
    (value as number) > range.max
  ) {
    throw new Error(`The ${what} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value as number;
}

function optionalWhole(
  value: unknown,
  range: { min: number; max: number },
  what: string,
): number | undefined {
  return value === undefined || value === null ? undefined : whole(value, range, what);
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say yes or no for ${what}.`);
  return value;
}

function optionalFlag(value: unknown, what: string): boolean | undefined {
  return value === undefined || value === null ? undefined : flag(value, what);
}

/** The defined fields only, so the core never sees an explicit undefined. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function historyRequest(value: unknown): { serverId: string; request: MetricsHistoryRequest } {
  const input = object(value, 'a history request');
  if (typeof input.resolution !== 'string' || !RESOLUTIONS.has(input.resolution)) {
    throw new Error('Ask for live, minute or quarter-hour history.');
  }
  return {
    serverId: serverId(input.serverId),
    request: {
      resolution: input.resolution as MetricsResolution,
      ...defined({
        fromUnixMs: optionalWhole(input.fromUnixMs, NON_NEGATIVE, 'start time'),
        toUnixMs: optionalWhole(input.toUnixMs, NON_NEGATIVE, 'end time'),
      }),
    },
  };
}

function metricsWatch(value: unknown): DeployMetricsWatchInput {
  const input = object(value, 'a metrics subscription');
  return {
    serverId: serverId(input.serverId),
    ...defined({
      intervalMs: optionalWhole(input.intervalMs, INTERVAL, 'interval'),
      sinceUnixMs: optionalWhole(input.sinceUnixMs, NON_NEGATIVE, 'start time'),
    }),
  };
}

function jobWatch(value: unknown): DeployJobWatchInput {
  const input = object(value, 'a job log subscription');
  return {
    serverId: serverId(input.serverId),
    jobId: guid(input.jobId, 'job'),
    ...defined({ afterSeq: optionalWhole(input.afterSeq, NON_NEGATIVE, 'line number') }),
  };
}

function jobQuery(value: unknown): { serverId: string; query: JobQuery } {
  const input = object(value, 'a job query');
  return {
    serverId: serverId(input.serverId),
    query: {
      activeOnly: optionalFlag(input.activeOnly, 'running jobs only') ?? false,
      ...defined({
        limit: optionalWhole(input.limit, JOB_PAGE, 'page size'),
        beforeCreatedAtUnixMs: optionalWhole(input.beforeCreatedAtUnixMs, NON_NEGATIVE, 'cursor'),
      }),
    },
  };
}

function alertQuery(value: unknown): { serverId: string; query: AlertQuery } {
  const input = object(value, 'an alert query');
  return {
    serverId: serverId(input.serverId),
    query: {
      includeResolved: optionalFlag(input.includeResolved, 'resolved alerts') ?? false,
      ...defined({ limit: optionalWhole(input.limit, ALERT_PAGE, 'page size') }),
    },
  };
}

function managedService(value: unknown): ManagedService {
  if (typeof value !== 'string' || !SERVICES.has(value)) {
    throw new Error('Only Docker and nginx can be restarted from the app.');
  }
  return value as ManagedService;
}

export function registerDeploySystemHandlers(deps: DeploySystemHandlerDeps): void {
  const { ipc, system, subscriptions } = deps;
  const handle = (
    channel: string,
    run: (owner: () => SubscriptionOwner, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(() => deps.owner(event), ...args);
    });
  };

  handle(IPC.deploySystem.info, (_owner, id) => system.info(serverId(id)));
  handle(IPC.deploySystem.services, (_owner, id) => system.services(serverId(id)));
  handle(IPC.deploySystem.metricsHistory, (_owner, value) => {
    const { serverId: id, request } = historyRequest(value);
    return system.metricsHistory(id, request);
  });
  handle(IPC.deploySystem.updates, (_owner, id) => system.updates(serverId(id)));
  handle(IPC.deploySystem.checkUpdates, (_owner, id) => system.checkUpdates(serverId(id)));
  handle(IPC.deploySystem.upgradeSecurity, (_owner, id) => system.upgradeSecurity(serverId(id)));
  handle(IPC.deploySystem.upgradeAll, (_owner, value) => system.upgradeAll(stepUpInput(value)));
  handle(IPC.deploySystem.setAutomaticUpdates, (_owner, id, enabled) =>
    system.setAutomaticUpdates(serverId(id), flag(enabled, 'automatic security updates')),
  );
  handle(IPC.deploySystem.reboot, (_owner, value) => system.reboot(stepUpInput(value)));
  handle(IPC.deploySystem.restartService, (_owner, id, service) =>
    system.restartService(serverId(id), managedService(service)),
  );
  handle(IPC.deploySystem.watchMetrics, (owner, value) =>
    subscriptions.watchMetrics(owner(), metricsWatch(value)),
  );
  handle(IPC.deploySystem.unwatchMetrics, (owner, id) =>
    subscriptions.unwatch(owner(), 'metrics', guid(id, 'subscription')),
  );

  handle(IPC.deployJobs.list, (_owner, value) => {
    const { serverId: id, query } = jobQuery(value);
    return system.jobs(id, query);
  });
  handle(IPC.deployJobs.get, (_owner, id, job) => system.job(serverId(id), guid(job, 'job')));
  handle(IPC.deployJobs.cancel, (_owner, id, job) =>
    system.cancelJob(serverId(id), guid(job, 'job')),
  );
  handle(IPC.deployJobs.watch, (owner, value) => subscriptions.watchJob(owner(), jobWatch(value)));
  handle(IPC.deployJobs.unwatch, (owner, id) =>
    subscriptions.unwatch(owner(), 'job', guid(id, 'subscription')),
  );

  handle(IPC.deployAlerts.list, (_owner, value) => {
    const { serverId: id, query } = alertQuery(value);
    return system.alerts(id, query);
  });
  handle(IPC.deployAlerts.acknowledge, (_owner, id, alert) =>
    system.acknowledgeAlert(serverId(id), whole(alert, POSITIVE, 'alert')),
  );
  handle(IPC.deployAlerts.watch, (owner, id) => subscriptions.watchAlerts(owner(), serverId(id)));
  handle(IPC.deployAlerts.unwatch, (owner, id) =>
    subscriptions.unwatch(owner(), 'alerts', guid(id, 'subscription')),
  );
}

/**
 * One subscription owner per window: it sends to that window alone, and the window's
 * subscriptions end when it reloads or crashes (the page starts over without them) or closes.
 */
export function subscriptionOwners(
  drop: (ownerId: number) => void,
): (contents: WebContents) => SubscriptionOwner {
  const owners = new WeakMap<WebContents, SubscriptionOwner>();
  return (contents) => {
    const known = owners.get(contents);
    if (known) return known;
    const owner: SubscriptionOwner = {
      id: contents.id,
      send: (channel, payload) => sendToContents(contents, channel, payload),
    };
    owners.set(contents, owner);
    const gone = () => drop(contents.id);
    contents.on('did-navigate', gone);
    contents.on('render-process-gone', gone);
    contents.once('destroyed', gone);
    return owner;
  };
}
