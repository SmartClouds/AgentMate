import type {
  AlertInfo,
  AlertKind,
  AlertSeverity,
  CoreUpdateRequest,
  CoreUpdateResult,
  DirectTlsStatus,
  JobInfo,
  JobKind,
  JobLogLine,
  JobLogSource,
  JobState,
  MetricsSample,
  ServiceInfo,
  SystemInfo,
  UpdatesInfo,
} from '../protocol/generated/AgentMate.ServerCore.Contracts';
import { FakeAssistant } from './fakeAssistant';
import { FakeCloudflareCore } from './fakeCloudflareCore';
import { FakeCoreConnection } from './fakeCoreConnection';
import { metricsSample, sampleServices, sampleSystemInfo, sampleUpdates } from './fakeCoreData';
import { FakeDocker } from './fakeDocker';
import { FakeErrorReporting } from './fakeErrorReporting';
import { FakeFiles } from './fakeFiles';
import { FakeFirewall } from './fakeFirewall';
import { FakeNginx } from './fakeNginx';
import { FakeTelegram } from './fakeTelegram';

/**
 * A server core in memory for tests (T11): the machine behind the hub. Tests move it along by
 * hand (a metrics sample, a job's next log line, an alert raised) and every open connection's
 * streams hear of it, with the replay cursors the real core honours: samples strictly after
 * `sinceUnixMs`, log lines after `afterSeq`, alert changes after `afterRevision`. `connect`
 * gives one hub connection (`FakeCoreConnection`, an `ICoreHub`); `dropAll` ends every one, as a
 * reboot or a token running out would, and `down` turns new connections away with a 503.
 */

export const FAKE_CORE_PASSWORD = 'correct horse battery staple';

/** The pin of the fake core's direct TLS certificate (any 32 bytes, base64). */
export const FAKE_CORE_TLS_PIN = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';

/** How long the core keeps live samples for a reconnecting client to catch up on. */
const LIVE_WINDOW_MS = 15 * 60_000;

/** Kinds of job that work on the package manager, so only one runs at a time. */
const PACKAGE_JOBS: ReadonlySet<JobKind> = new Set<JobKind>([
  'packagesRefresh',
  'packagesUpgrade',
  'packagesUpgradeSecurity',
  'automaticUpdates',
  'reboot',
]);

/** Thrown by `connect` while the core is down; carries the status a real upgrade would get. */
export class FakeCoreDown extends Error {
  readonly status = 503;

  constructor() {
    super('The server core is not answering (503).');
    this.name = 'FakeCoreDown';
  }
}

export interface FakeJob {
  info: JobInfo;
  lines: JobLogLine[];
}

export class FakeCore {
  readonly connections: FakeCoreConnection[] = [];
  readonly samples: MetricsSample[] = [];
  readonly jobs = new Map<string, FakeJob>();
  readonly alerts = new Map<number, AlertInfo>();
  roles: string[] = ['owner'];
  userName = 'maria';
  password = FAKE_CORE_PASSWORD;
  /** Until when sensitive calls are allowed, after a step-up (the core's clock). */
  stepUpUntil = 0;
  /** While true, `connect` fails as a core that is starting or rebooting would. */
  down = false;
  /** Set by `rebootServer`; the test decides when the machine actually goes down. */
  rebootRequested = false;
  /** Every `updateCore` request, and how the core answers one (a test sets it). */
  readonly coreUpdates: CoreUpdateRequest[] = [];
  answerCoreUpdate: (request: CoreUpdateRequest) => CoreUpdateResult = () => ({
    outcome: 'switching',
    runningVersion: '1.0.0',
  });
  system: SystemInfo = sampleSystemInfo();
  services: ServiceInfo[] = sampleServices();
  updates: UpdatesInfo = sampleUpdates();
  /** Docker on the pretend server (E06): containers, logs, stats, events and resources. */
  readonly docker: FakeDocker = new FakeDocker(this);
  /** The files in its containers and volumes (E27). */
  readonly files: FakeFiles = new FakeFiles(this);
  /** nginx, its sites and certificates (E10, E11). */
  readonly nginx: FakeNginx = new FakeNginx({
    now: () => this.now(),
    startJob: (kind, title, options) => this.startJob(kind, title, options),
    finishJob: (jobId, state) => this.finishJob(jobId, state),
    deliverSiteLog: (siteId, kind, lines, reset) => {
      for (const connection of this.openConnections) {
        connection.deliverSiteLog(siteId, kind, lines, reset);
      }
    },
  });
  private revision = 0;
  private sampled = 0;
  private jobCount = 0;
  private alertCount = 0;

  /** The exec stream, its approvals and the journal (E09). */
  readonly assistant: FakeAssistant = new FakeAssistant(() => this.now());

  /** The host firewall (E13); a change nobody confirms in time raises firewallRolledBack. */
  readonly firewall: FakeFirewall;

  /** Cloudflare on the server (E14): the origin lock, Origin CA certificates and DNS tokens. */
  readonly cloudflare: FakeCloudflareCore;

  /** Direct TLS (E16): off until an Owner turns it on. */
  directTls: DirectTlsStatus = {
    enabled: false,
    port: 7443,
    sources: [],
    listening: false,
    pin: FAKE_CORE_TLS_PIN,
    certificateNotAfterUnixMs: Date.UTC(2046, 0, 1),
    defaultPort: 7443,
  };

  /** Error reporting (E29): where the core sends its warnings and errors. Off until an Owner sets it up. */
  readonly errorReporting: FakeErrorReporting = new FakeErrorReporting({
    now: () => this.now(),
    userName: () => this.userName,
  });

  /** Telegram notifications (E30): where the core sends its alerts. Off until an Owner sets them up. */
  readonly telegram: FakeTelegram = new FakeTelegram({
    now: () => this.now(),
    userName: () => this.userName,
  });

  constructor(readonly now: () => number = Date.now) {
    this.firewall = new FakeFirewall(now, (change) =>
      this.raise(
        'firewallRolledBack',
        'firewall',
        'warning',
        `A firewall change nobody confirmed was rolled back: ${change.summary}.`,
      ),
    );
    this.cloudflare = new FakeCloudflareCore({ now, firewall: this.firewall, nginx: this.nginx });
  }

  get openConnections(): FakeCoreConnection[] {
    return this.connections.filter((connection) => !connection.closed);
  }

  connect(): FakeCoreConnection {
    if (this.down) throw new FakeCoreDown();
    const connection = new FakeCoreConnection(this);
    this.connections.push(connection);
    return connection;
  }

  /** Every open connection ends at once, its streams first, as SignalR reports it. */
  dropAll(): void {
    for (const connection of this.openConnections) connection.drop();
  }

  /** The next reading, sent to every metrics stream. */
  sample(overrides: Partial<MetricsSample> = {}): MetricsSample {
    const sample = { ...metricsSample(this.now(), this.sampled), ...overrides };
    this.sampled += 1;
    this.samples.push(sample);
    while (this.samples.length > 0 && this.samples[0].atUnixMs < sample.atUnixMs - LIVE_WINDOW_MS) {
      this.samples.shift();
    }
    for (const connection of this.openConnections) connection.deliverSample(sample);
    return sample;
  }

  startJob(
    kind: JobKind,
    title: string,
    options: { cancellable?: boolean; resource?: string } = {},
  ): JobInfo {
    if (PACKAGE_JOBS.has(kind)) {
      const busy = [...this.jobs.values()].find(
        (job) => job.info.state === 'running' && PACKAGE_JOBS.has(job.info.kind),
      );
      if (busy) throw new Error(`Another job is already working on packages: ${busy.info.title}.`);
    }
    this.jobCount += 1;
    const info: JobInfo = {
      id: `00000000-0000-4000-8000-${String(this.jobCount).padStart(12, '0')}`,
      kind,
      title,
      state: 'running',
      createdAtUnixMs: this.now(),
      logLines: 0,
      cancellable: options.cancellable ?? true,
      resource: options.resource ?? (PACKAGE_JOBS.has(kind) ? 'packages' : undefined),
      requestedBy: this.userName,
    };
    this.jobs.set(info.id, { info, lines: [] });
    return { ...info };
  }

  log(jobId: string, text: string, source: JobLogSource = 'out'): JobLogLine {
    const job = this.job(jobId);
    const line: JobLogLine = { seq: job.lines.length + 1, atUnixMs: this.now(), source, text };
    job.lines.push(line);
    job.info = { ...job.info, logLines: job.lines.length };
    for (const connection of this.openConnections) connection.deliverJobLine(jobId, line);
    return line;
  }

  finishJob(jobId: string, state: Exclude<JobState, 'running'>, exitCode?: number): JobInfo {
    const job = this.job(jobId);
    job.info = {
      ...job.info,
      state,
      finishedAtUnixMs: this.now(),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
    for (const connection of this.openConnections) connection.deliverJobEnd(jobId, job.info);
    return { ...job.info };
  }

  job(jobId: string): FakeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`The fake core has no job ${jobId}.`);
    return job;
  }

  /** Opens an alert, or moves the open one on (a worse severity clears its acknowledgment). */
  raise(kind: AlertKind, resource: string, severity: AlertSeverity, message: string): AlertInfo {
    const open = [...this.alerts.values()].find(
      (alert) => alert.kind === kind && alert.resource === resource && !alert.resolvedAtUnixMs,
    );
    if (!open) {
      this.alertCount += 1;
      return this.change({
        id: this.alertCount,
        revision: 0,
        kind,
        severity,
        resource,
        message,
        firstSeenAtUnixMs: this.now(),
        lastSeenAtUnixMs: this.now(),
        occurrences: 1,
      });
    }
    const worse = rank(severity) > rank(open.severity);
    const { acknowledgedAtUnixMs, acknowledgedBy, ...rest } = open;
    return this.change({
      ...(worse ? rest : open),
      severity,
      message,
      lastSeenAtUnixMs: this.now(),
      occurrences: open.occurrences + 1,
    });
  }

  resolve(alertId: number): AlertInfo {
    return this.change({ ...this.alert(alertId), resolvedAtUnixMs: this.now() });
  }

  acknowledge(alertId: number, by = this.userName): AlertInfo {
    const alert = this.alert(alertId);
    if (alert.acknowledgedAtUnixMs) return { ...alert };
    return this.change({ ...alert, acknowledgedAtUnixMs: this.now(), acknowledgedBy: by });
  }

  alert(alertId: number): AlertInfo {
    const alert = this.alerts.get(alertId);
    if (!alert) throw new Error(`The fake core has no alert ${alertId}.`);
    return alert;
  }

  /** Open alerts by revision, or every change after one, as StreamAlerts starts. */
  changesAfter(afterRevision?: number): AlertInfo[] {
    return [...this.alerts.values()]
      .filter((alert) =>
        afterRevision === undefined ? !alert.resolvedAtUnixMs : alert.revision > afterRevision,
      )
      .sort((a, b) => a.revision - b.revision);
  }

  /** Ends every alert stream, as the core does with a subscriber that fell behind. */
  endAlertStreams(): void {
    for (const connection of this.openConnections) connection.endAlertStreams();
  }

  private change(alert: AlertInfo): AlertInfo {
    this.revision += 1;
    const changed = { ...alert, revision: this.revision };
    this.alerts.set(changed.id, changed);
    for (const connection of this.openConnections) connection.deliverAlert(changed);
    return { ...changed };
  }
}

export function rank(severity: AlertSeverity): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}
