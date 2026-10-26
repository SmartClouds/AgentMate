import type {
  AlertInfo,
  CertificateInfo,
  ContainerPortInfo,
  ContainerSummary,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { buildProblems, PROBLEM_LABELS } from './problems';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function container(name: string, extra: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: `id-${name}`,
    name,
    image: 'img',
    imageId: 'sha256:1',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    createdAtUnixMs: 0,
    ports: [],
    ...extra,
  };
}

function alert(id: number, extra: Partial<AlertInfo>): AlertInfo {
  return {
    id,
    revision: id,
    kind: 'diskPressure',
    severity: 'warning',
    resource: '/',
    message: '/ is 91% full',
    firstSeenAtUnixMs: 0,
    lastSeenAtUnixMs: 0,
    occurrences: 1,
    ...extra,
  };
}

function certificate(
  siteId: string,
  days: number,
  extra: Partial<CertificateInfo> = {},
): CertificateInfo {
  return {
    siteId,
    source: 'letsEncrypt',
    state: 'valid',
    domains: [`${siteId}.example.com`],
    issuer: 'R11',
    notBeforeUnixMs: 0,
    notAfterUnixMs: NOW + days * DAY + 1000,
    autoRenew: true,
    staging: false,
    failedAttempts: 0,
    ...extra,
  } as CertificateInfo;
}

function stack(name: string, status: StackInfo['status']): StackInfo {
  return {
    id: `stack-${name}`,
    name,
    status,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
    revisionCount: 1,
    runningContainers: 1,
    containers: 3,
  };
}

function port(name: string, extra: Partial<ContainerPortInfo> = {}): ContainerPortInfo {
  return {
    containerId: `id-${name}`,
    containerName: name,
    image: 'img',
    protocol: 'tcp',
    hostAddress: '0.0.0.0',
    hostPort: 3001,
    containerPort: 3000,
    scope: 'public',
    firewall: 'open',
    ...extra,
  } as ContainerPortInfo;
}

describe('buildProblems', () => {
  it('finds crash loops, dead and unhealthy containers, critical first', () => {
    const problems = buildProblems({
      now: NOW,
      containers: [
        container('api', { health: 'unhealthy' }),
        container('sender', { state: 'restarting', status: 'Restarting (1) 3 seconds ago' }),
        container('old', { state: 'dead' }),
        container('web', { health: 'healthy' }),
        container('paused', { state: 'paused', health: 'unhealthy' }),
      ],
    });
    expect(problems.map((p) => [p.kind, p.severity, p.title])).toEqual([
      ['crashLoop', 'critical', 'old is dead'],
      ['crashLoop', 'critical', 'sender keeps restarting'],
      ['unhealthy', 'warning', 'api is unhealthy'],
    ]);
    expect(problems[1]).toMatchObject({ containerId: 'id-sender', containerName: 'sender' });
    expect(problems[1]?.detail).toContain('Restarting (1) 3 seconds ago');
  });

  it('turns failed and half-up apps and open alerts into problems, leaving reboots out', () => {
    const problems = buildProblems({
      now: NOW,
      stacks: [stack('shop', 'failed'), stack('blog', 'degraded'), stack('ok', 'running')],
      alerts: [
        alert(1, { severity: 'critical' }),
        alert(2, { kind: 'jobFailed', message: 'Deploy shop failed' }),
        alert(3, { kind: 'rebootRequired' }),
        alert(4, { kind: 'firewallRolledBack', message: 'Rolled back' }),
        alert(5, { resolvedAtUnixMs: 1 }),
      ],
    });
    expect(problems.map((p) => p.title)).toEqual([
      'The last deploy of shop failed',
      '/ is filling up',
      'A job failed',
      'shop is not fully up'.replace('shop', 'blog'),
      'The firewall needs a look',
    ]);
    expect(problems.find((p) => p.title === 'blog is not fully up')?.detail).toBe(
      '1 of 3 containers are running.',
    );
  });

  it('names failed backups and crash loops the core saw, without listing a loop twice (E30)', () => {
    const problems = buildProblems({
      now: NOW,
      containers: [container('sender', { state: 'restarting', status: 'Restarting (1) now' })],
      alerts: [
        alert(1, {
          kind: 'backupFailed',
          resource: 'backup-plan:1',
          severity: 'critical',
          message: 'Nightly: disk full',
        }),
        alert(2, { kind: 'containerCrashLoop', resource: 'sender', severity: 'critical' }),
        alert(3, {
          kind: 'containerCrashLoop',
          resource: 'worker',
          severity: 'critical',
          message: 'worker keeps restarting: it exited 3 times',
        }),
      ],
    });

    expect(problems.map((p) => [p.kind, p.title])).toEqual([
      ['crashLoop', 'sender keeps restarting'],
      ['crashLoop', 'worker keeps restarting'],
      ['alert', 'A backup failed'],
    ]);
    expect(problems.find((p) => p.title === 'worker keeps restarting')).toMatchObject({
      containerName: 'worker',
      detail: 'worker keeps restarting: it exited 3 times',
    });
  });

  it('warns about certificates close to their end and flags expired ones', () => {
    const problems = buildProblems({
      now: NOW,
      certificates: [
        certificate('fine', 60),
        certificate('soon', 5),
        certificate('one', 1, { autoRenew: false }),
        certificate('flagged', 40, { state: 'expiringSoon', lastError: 'DNS problem' }),
        certificate('gone', -2),
        certificate('revoked', -10, { state: 'revoked' }),
        certificate('failing', 3),
      ],
      alerts: [
        alert(9, { kind: 'certificateRenewalFailed', resource: 'failing', severity: 'critical' }),
      ],
    });
    expect(problems.map((p) => p.title)).toEqual([
      'A certificate did not renew',
      'The certificate for gone.example.com has expired',
      'The certificate for flagged.example.com runs out in 40 days',
      'The certificate for one.example.com runs out in 1 day',
      'The certificate for soon.example.com runs out in 5 days',
    ]);
    expect(problems.find((p) => p.title.includes('flagged'))?.detail).toContain('DNS problem');
    expect(problems.find((p) => p.title.includes('for one.'))?.detail).toBe(
      'It does not renew on its own.',
    );
  });

  it('lists each container published to the internet once, with its ports', () => {
    const problems = buildProblems({
      now: NOW,
      exposure: {
        sockets: [],
        dockerAvailable: true,
        collectedAtUnixMs: NOW,
        containers: [
          port('grafana'),
          port('grafana', { hostAddress: '::' }),
          port('grafana', { hostPort: 3002, protocol: 'udp' }),
          port('db', { scope: 'local' }),
          port('cache', { firewall: 'closed' }),
          port('api', { firewall: 'restricted' }),
        ],
      },
    });
    expect(problems).toEqual([
      {
        id: 'exposed:id-grafana',
        kind: 'exposedPort',
        severity: 'warning',
        title: 'grafana is reachable from the internet',
        detail:
          'Published on every address: 3001/tcp, 3002/udp. Put it behind a site or bind it to 127.0.0.1.',
        containerId: 'id-grafana',
        containerName: 'grafana',
      },
    ]);
  });

  it('is empty for a healthy server and labels every kind', () => {
    expect(buildProblems({ now: NOW })).toEqual([]);
    expect(buildProblems({ now: NOW, exposure: null, containers: [container('web')] })).toEqual([]);
    expect(Object.keys(PROBLEM_LABELS)).toHaveLength(7);
  });
});
