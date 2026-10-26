import type { HealthIncident, HealthReport, HealthSample, Project } from '@runova/core';
import type { ProjectEnvironment } from '@shared/apiTypes';
import type {
  HealthSecretReveal,
  HealthTargetDetail,
  HealthTargetSummary,
} from '@shared/healthTypes';

/** Test data for the Health page. Times are fixed so relative labels are stable. */

export const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Storefront',
    folderPath: 'C:\\work\\storefront',
    cliId: 'claude-code',
    ...overrides,
  } as Project;
}

export function environment(overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment {
  return {
    id: 'env-prod',
    projectId: 'p1',
    name: 'Production',
    kind: 'production',
    order: 0,
    files: [],
    credentials: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProjectEnvironment;
}

export function samples(states: HealthSample['state'][], start = NOW - states.length * 60_000) {
  return states.map(
    (state, i): HealthSample => ({ at: start + i * 60_000, state, latencyMs: 100 + i }),
  );
}

export function target(overrides: Partial<HealthTargetSummary> = {}): HealthTargetSummary {
  return {
    id: 't1',
    projectId: 'p1',
    environmentId: 'env-prod',
    name: 'API',
    serverLabel: 'web-1',
    serverLink: null,
    url: 'https://api.example.com/_runova/health?probe=1',
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    paused: false,
    hasSecret: true,
    secretRotatedAt: null,
    state: 'pass',
    lastCheckedAt: NOW - 30_000,
    nextCheckAt: NOW + 30_000,
    latencyMs: 120,
    uptime24h: 0.995,
    daily: [],
    samples: samples(['pass', 'pass', 'warn', 'pass']),
    servicesTotal: 2,
    servicesFailing: 0,
    headline: null,
    openIncident: null,
    ...overrides,
  };
}

export function incident(overrides: Partial<HealthIncident> = {}): HealthIncident {
  return {
    id: 'i1',
    targetId: 't1',
    openedAt: NOW - 600_000,
    resolvedAt: null,
    state: 'fail',
    summary: 'postgres:connection is failing',
    failingServices: ['postgres:connection'],
    diagnosis: null,
    ...overrides,
  };
}

export function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    state: 'fail',
    httpStatus: 503,
    latencyMs: 240,
    checkedAt: NOW - 30_000,
    serviceId: 'storefront-api',
    description: null,
    releaseId: 'abc123',
    version: '1',
    output: null,
    problem: null,
    raw: '{\n  "status": "fail"\n}',
    services: [
      {
        key: 'postgres:connection',
        name: 'postgres',
        measurement: 'connection',
        componentId: null,
        componentType: 'datastore',
        status: 'fail',
        observedValue: null,
        observedUnit: null,
        time: null,
        error: {
          message: 'Connection refused',
          code: 'ECONNREFUSED',
          detail: 'Tried 10.0.0.5:5432',
          stack: 'Error: Connection refused\n    at connect (db.js:10:5)',
          hint: 'Check that the database is running',
          since: null,
        },
      },
      {
        key: 'redis:ping',
        name: 'redis',
        measurement: 'ping',
        componentId: null,
        componentType: 'datastore',
        status: 'pass',
        observedValue: 3,
        observedUnit: 'ms',
        time: null,
        error: null,
      },
    ],
    ...overrides,
  };
}

export function detail(overrides: Partial<HealthTargetDetail> = {}): HealthTargetDetail {
  const summary = overrides.target ?? target({ state: 'fail', openIncident: incident() });
  return {
    target: summary,
    report: report(),
    incidents: summary.openIncident ? [summary.openIncident] : [],
    samples: summary.samples,
    latency: [],
    ...overrides,
  };
}

export function reveal(overrides: Partial<HealthSecretReveal> = {}): HealthSecretReveal {
  return {
    targetId: 't1',
    authMode: 'bearer',
    secret: 'rnh_test_secret_value_1234567890',
    sha256: 'a'.repeat(64),
    basicUser: null,
    hashEnvVar: 'RUNOVA_HEALTH_TOKEN_SHA256',
    ...overrides,
  };
}
