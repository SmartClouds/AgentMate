import type {
  AlertInfo,
  CertificateInfo,
  ContainerSummary,
  ExposureInventory,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The problems feed (E09 T2): what is broken on a server right now, from what the app already
 * reads. Containers that keep restarting or report unhealthy, apps whose deploy failed, the
 * core's open alerts (a full disk, a failed job or renewal), certificates close to running out,
 * and container ports anyone on the internet can reach. Critical first, then by kind.
 */

export type ProblemKind =
  | 'crashLoop'
  | 'unhealthy'
  | 'failedDeploy'
  | 'diskPressure'
  | 'certificate'
  | 'exposedPort'
  | 'alert';

export type ProblemSeverity = 'critical' | 'warning';

export interface Problem {
  id: string;
  kind: ProblemKind;
  severity: ProblemSeverity;
  title: string;
  detail: string;
  /** The container it is about, for "Fix in project" and for the AI's context. */
  containerId?: string;
  containerName?: string;
}

export interface ProblemInputs {
  containers?: readonly ContainerSummary[];
  alerts?: readonly AlertInfo[];
  certificates?: readonly CertificateInfo[];
  exposure?: ExposureInventory | null;
  stacks?: readonly StackInfo[];
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A certificate this close to its end is a problem even while it renews on its own. */
export const CERTIFICATE_WARNING_DAYS = 14;

const ORDER: Record<ProblemKind, number> = {
  crashLoop: 0,
  failedDeploy: 1,
  unhealthy: 2,
  diskPressure: 3,
  certificate: 4,
  exposedPort: 5,
  alert: 6,
};

export const PROBLEM_LABELS: Record<ProblemKind, string> = {
  crashLoop: 'Crash loop',
  unhealthy: 'Unhealthy',
  failedDeploy: 'Failed deploy',
  diskPressure: 'Disk pressure',
  certificate: 'Certificate',
  exposedPort: 'Exposed port',
  alert: 'Alert',
};

function containerProblems(containers: readonly ContainerSummary[]): Problem[] {
  const found: Problem[] = [];
  for (const container of containers) {
    if (container.state === 'restarting') {
      found.push({
        id: `crash:${container.id}`,
        kind: 'crashLoop',
        severity: 'critical',
        title: `${container.name} keeps restarting`,
        detail: `${container.status}. It exits soon after each start, and Docker starts it again.`,
        containerId: container.id,
        containerName: container.name,
      });
    } else if (container.state === 'running' && container.health === 'unhealthy') {
      found.push({
        id: `unhealthy:${container.id}`,
        kind: 'unhealthy',
        severity: 'warning',
        title: `${container.name} is unhealthy`,
        detail: `It runs, but its health check fails (${container.status}).`,
        containerId: container.id,
        containerName: container.name,
      });
    } else if (container.state === 'dead') {
      found.push({
        id: `dead:${container.id}`,
        kind: 'crashLoop',
        severity: 'critical',
        title: `${container.name} is dead`,
        detail: 'Docker could not stop or remove it cleanly. Its log may say why.',
        containerId: container.id,
        containerName: container.name,
      });
    }
  }
  return found;
}

function stackProblems(stacks: readonly StackInfo[]): Problem[] {
  const found: Problem[] = [];
  for (const stack of stacks) {
    if (stack.status === 'failed') {
      found.push({
        id: `deploy:${stack.id}`,
        kind: 'failedDeploy',
        severity: 'critical',
        title: `The last deploy of ${stack.name} failed`,
        detail:
          'Open the app to see which step failed and its log, or roll back to a revision that worked.',
      });
    } else if (stack.status === 'degraded') {
      found.push({
        id: `degraded:${stack.id}`,
        kind: 'failedDeploy',
        severity: 'warning',
        title: `${stack.name} is not fully up`,
        detail: `${stack.runningContainers} of ${stack.containers} containers are running.`,
      });
    }
  }
  return found;
}

/** `looping` are the containers already listed as crash loops from their own state. */
function alertProblems(alerts: readonly AlertInfo[], looping: ReadonlySet<string>): Problem[] {
  const found: Problem[] = [];
  for (const alert of alerts) {
    if (alert.resolvedAtUnixMs !== undefined || alert.kind === 'rebootRequired') continue;
    if (alert.kind === 'containerCrashLoop') {
      if (looping.has(alert.resource)) continue;
      found.push({
        id: `alert:${alert.id}`,
        kind: 'crashLoop',
        severity: alert.severity === 'critical' ? 'critical' : 'warning',
        title: `${alert.resource} keeps restarting`,
        detail: alert.message,
        containerName: alert.resource,
      });
      continue;
    }
    const kind: ProblemKind =
      alert.kind === 'diskPressure'
        ? 'diskPressure'
        : alert.kind === 'jobFailed'
          ? 'failedDeploy'
          : alert.kind === 'certificateRenewalFailed'
            ? 'certificate'
            : 'alert';
    const title =
      alert.kind === 'diskPressure'
        ? `${alert.resource} is filling up`
        : alert.kind === 'jobFailed'
          ? 'A job failed'
          : alert.kind === 'certificateRenewalFailed'
            ? 'A certificate did not renew'
            : alert.kind === 'backupFailed'
              ? 'A backup failed'
              : 'The firewall needs a look';
    found.push({
      id: `alert:${alert.id}`,
      kind,
      severity: alert.severity === 'critical' ? 'critical' : 'warning',
      title,
      detail: alert.message,
    });
  }
  return found;
}

function certificateProblems(
  certificates: readonly CertificateInfo[],
  alerts: readonly AlertInfo[],
  now: number,
): Problem[] {
  const renewalFailed = new Set(
    alerts
      .filter((alert) => alert.kind === 'certificateRenewalFailed' && !alert.resolvedAtUnixMs)
      .map((alert) => alert.resource),
  );
  const found: Problem[] = [];
  for (const certificate of certificates) {
    if (certificate.state === 'revoked' || renewalFailed.has(certificate.siteId)) continue;
    const days = Math.floor((certificate.notAfterUnixMs - now) / DAY_MS);
    const domain = certificate.domains[0] ?? certificate.siteId;
    if (certificate.state === 'expired' || days < 0) {
      found.push({
        id: `cert:${certificate.siteId}`,
        kind: 'certificate',
        severity: 'critical',
        title: `The certificate for ${domain} has expired`,
        detail: 'Visitors see a warning instead of the site. Renew it from Websites.',
      });
    } else if (certificate.state === 'expiringSoon' || days <= CERTIFICATE_WARNING_DAYS) {
      found.push({
        id: `cert:${certificate.siteId}`,
        kind: 'certificate',
        severity: 'warning',
        title: `The certificate for ${domain} runs out in ${days === 1 ? '1 day' : `${days} days`}`,
        detail: certificate.lastError
          ? `The last renewal failed: ${certificate.lastError}`
          : certificate.autoRenew
            ? 'It renews on its own; if it has not by now, check the site.'
            : 'It does not renew on its own.',
      });
    }
  }
  return found;
}

function exposureProblems(exposure: ExposureInventory): Problem[] {
  const byContainer = new Map<string, { name: string; ports: string[] }>();
  for (const port of exposure.containers) {
    if (port.scope !== 'public' || port.firewall === 'closed' || port.firewall === 'restricted') {
      continue;
    }
    const entry = byContainer.get(port.containerId) ?? { name: port.containerName, ports: [] };
    const label = `${port.hostPort}/${port.protocol}`;
    if (!entry.ports.includes(label)) entry.ports.push(label);
    byContainer.set(port.containerId, entry);
  }
  return [...byContainer].map(([containerId, entry]) => ({
    id: `exposed:${containerId}`,
    kind: 'exposedPort',
    severity: 'warning',
    title: `${entry.name} is reachable from the internet`,
    detail: `Published on every address: ${entry.ports.join(', ')}. Put it behind a site or bind it to 127.0.0.1.`,
    containerId,
    containerName: entry.name,
  }));
}

export function buildProblems(inputs: ProblemInputs): Problem[] {
  const alerts = inputs.alerts ?? [];
  const fromContainers = containerProblems(inputs.containers ?? []);
  const looping = new Set(
    fromContainers.flatMap((p) =>
      p.kind === 'crashLoop' && p.containerName ? [p.containerName] : [],
    ),
  );
  const problems = [
    ...fromContainers,
    ...stackProblems(inputs.stacks ?? []),
    ...alertProblems(alerts, looping),
    ...certificateProblems(inputs.certificates ?? [], alerts, inputs.now),
    ...(inputs.exposure ? exposureProblems(inputs.exposure) : []),
  ];
  return problems.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) ||
      ORDER[a.kind] - ORDER[b.kind] ||
      a.title.localeCompare(b.title),
  );
}
