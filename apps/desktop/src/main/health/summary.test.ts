import {
  type HealthIncident,
  type HealthReport,
  type HealthSample,
  localDayStart,
  localHourStart,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import { emptyHealthResult, type HealthResultRecord, type StoredHealthTarget } from './store';
import { toHealthDetail, toHealthSummary } from './summary';

/**
 * What the Health page gets for a target: the setup without its sealed key, the state to show,
 * and the numbers the card draws (uptime over a day, the recent strip, failing services).
 */

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

const target: StoredHealthTarget = {
  id: 't1',
  projectId: 'p1',
  environmentId: null,
  name: 'API',
  serverLabel: null,
  serverLink: null,
  url: 'https://shop.example.com/health',
  intervalSec: 60,
  timeoutSec: 10,
  authMode: 'bearer',
  basicUser: null,
  allowInsecure: false,
  autoDiagnose: true,
  createdAt: 1,
  updatedAt: 2,
  paused: false,
  secretEnvelope: { mode: 'safeStorage', ciphertext: 'c2VjcmV0' },
  secretRotatedAt: null,
};

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    state: 'pass',
    httpStatus: 200,
    latencyMs: 42,
    checkedAt: NOW - 1000,
    serviceId: null,
    description: null,
    releaseId: null,
    version: null,
    output: null,
    services: [],
    problem: null,
    raw: null,
    ...overrides,
  };
}

function service(key: string, status: 'pass' | 'warn' | 'fail', message?: string) {
  return {
    key,
    name: key,
    measurement: null,
    componentId: null,
    componentType: null,
    status,
    observedValue: null,
    observedUnit: null,
    time: null,
    error: message
      ? { message, code: null, detail: null, stack: null, hint: null, since: null }
      : null,
  };
}

function result(overrides: Partial<HealthResultRecord> = {}): HealthResultRecord {
  return { ...emptyHealthResult(), ...overrides };
}

const summarize = (record: HealthResultRecord | undefined, locked = false, base = target) =>
  toHealthSummary(base, record, { now: NOW, locked });

describe('toHealthSummary', () => {
  it('is pending with nothing to show before the first probe', () => {
    const summary = summarize(undefined);
    expect(summary).toMatchObject({
      id: 't1',
      name: 'API',
      state: 'pending',
      hasSecret: true,
      lastCheckedAt: null,
      nextCheckAt: null,
      latencyMs: null,
      uptime24h: null,
      samples: [],
      servicesTotal: 0,
      servicesFailing: 0,
      headline: null,
      openIncident: null,
    });
    expect(summary).not.toHaveProperty('secretEnvelope');
    expect(JSON.stringify(summary)).not.toContain('c2VjcmV0');
  });

  it('says there is no key when none is saved', () => {
    expect(summarize(undefined, false, { ...target, secretEnvelope: null }).hasSecret).toBe(false);
  });

  it('shows the last report', () => {
    const summary = summarize(
      result({ report: report(), lastCheckedAt: NOW - 1000, nextCheckAt: NOW + 59_000 }),
    );
    expect(summary).toMatchObject({
      state: 'pass',
      latencyMs: 42,
      lastCheckedAt: NOW - 1000,
      nextCheckAt: NOW + 59_000,
    });
  });

  it('is paused or locked whatever the last report said, paused first', () => {
    const record = result({ report: report({ state: 'fail' }) });
    expect(summarize(record, true).state).toBe('locked');
    expect(summarize(record, true, { ...target, paused: true }).state).toBe('paused');
  });

  it('counts uptime over the last 24 hours, warn as up', () => {
    const samples: HealthSample[] = [
      { at: NOW - 30 * HOUR, state: 'fail', latencyMs: null },
      { at: NOW - 3 * HOUR, state: 'pass', latencyMs: 10 },
      { at: NOW - 2 * HOUR, state: 'warn', latencyMs: 10 },
      { at: NOW - HOUR, state: 'unreachable', latencyMs: null },
      { at: NOW - 1000, state: 'pass', latencyMs: 10 },
    ];
    expect(summarize(result({ samples })).uptime24h).toBe(0.75);
    expect(summarize(result({ samples: samples.slice(0, 1) })).uptime24h).toBeNull();
  });

  it('reads uptime from the hours, which reach further back than the samples', () => {
    const hours = Array.from({ length: 20 }, (_, i) => ({
      start: localHourStart(NOW - (19 - i) * HOUR),
      checks: 60,
      failures: i === 0 ? 12 : 0,
      p50: 40,
      p95: 90,
    }));
    const samples: HealthSample[] = [{ at: NOW - 1000, state: 'pass', latencyMs: 40 }];
    expect(summarize(result({ hours, samples })).uptime24h).toBe(1 - 12 / 1200);
  });

  it('gives the last 30 days for the availability chart, today last', () => {
    const hours = [{ start: localHourStart(NOW - HOUR), checks: 10, failures: 1, p50: 1, p95: 2 }];
    const { daily } = summarize(result({ hours }));
    expect(daily).toHaveLength(30);
    expect(daily[29].start).toBe(localDayStart(NOW));
    expect(daily.reduce((sum, day) => sum + day.checks, 0)).toBe(10);
    expect(daily.reduce((sum, day) => sum + day.failures, 0)).toBe(1);
  });

  it('keeps the last 50 samples for the strip', () => {
    const samples = Array.from({ length: 200 }, (_, index) => ({
      at: NOW - (200 - index) * 1000,
      state: 'pass' as const,
      latencyMs: index,
    }));
    const strip = summarize(result({ samples })).samples;
    expect(strip).toHaveLength(50);
    expect(strip[0].latencyMs).toBe(150);
    expect(strip[49].latencyMs).toBe(199);
  });

  it('counts failing services and heads with the first failing error', () => {
    const summary = summarize(
      result({
        report: report({
          state: 'fail',
          services: [
            service('disk:free', 'warn', 'Low disk'),
            service('redis:ping', 'pass'),
            service('postgres:connection', 'fail', 'connect ECONNREFUSED\nat line 2'),
          ],
        }),
      }),
    );
    expect(summary.servicesTotal).toBe(3);
    expect(summary.servicesFailing).toBe(1);
    expect(summary.headline).toBe('postgres:connection: connect ECONNREFUSED');
  });

  it('heads with the probe problem, a degraded service, or the endpoint output', () => {
    expect(
      summarize(result({ report: report({ state: 'unreachable', problem: 'Timed out.' }) }))
        .headline,
    ).toBe('Timed out.');
    expect(
      summarize(
        result({ report: report({ state: 'warn', services: [service('disk', 'warn', 'Low')] }) }),
      ).headline,
    ).toBe('disk: Low');
    expect(
      summarize(result({ report: report({ state: 'fail', output: 'Down for maintenance' }) }))
        .headline,
    ).toBe('Down for maintenance');
    expect(summarize(result({ report: report() })).headline).toBeNull();
  });

  it('shows the incident that is still open', () => {
    const open: HealthIncident = {
      id: 'i2',
      targetId: 't1',
      openedAt: NOW - HOUR,
      resolvedAt: null,
      state: 'fail',
      summary: 'Down',
      failingServices: [],
      diagnosis: null,
    };
    const closed = { ...open, id: 'i1', resolvedAt: NOW - 2 * HOUR };
    expect(summarize(result({ incidents: [open, closed] })).openIncident?.id).toBe('i2');
    expect(summarize(result({ incidents: [closed] })).openIncident).toBeNull();
  });
});

describe('toHealthDetail', () => {
  it('adds the report, every incident and every sample', () => {
    const samples = [{ at: NOW, state: 'pass' as const, latencyMs: 1 }];
    const record = result({ report: report(), samples });
    const detail = toHealthDetail(target, record, { now: NOW, locked: false });
    expect(detail.report?.state).toBe('pass');
    expect(detail.samples).toEqual(samples);
    expect(detail.incidents).toEqual([]);
    expect(detail.target.id).toBe('t1');
  });

  it('is empty before the first probe', () => {
    const detail = toHealthDetail(target, undefined, { now: NOW, locked: false });
    expect(detail).toMatchObject({ report: null, incidents: [], samples: [] });
    expect(detail.latency).toHaveLength(24);
    expect(detail.latency.every((point) => point.p50 === null)).toBe(true);
  });

  it('gives the last 24 hours of response times, one point per hour', () => {
    const hours = [
      { start: localHourStart(NOW - 3 * HOUR), checks: 60, failures: 0, p50: 40, p95: 120 },
      { start: localHourStart(NOW), checks: 5, failures: 1, p50: 55, p95: 300 },
    ];
    const { latency } = toHealthDetail(target, result({ hours }), { now: NOW, locked: false });
    expect(latency).toHaveLength(24);
    expect(latency[23]).toEqual({
      start: localHourStart(NOW),
      checks: 5,
      failures: 1,
      p50: 55,
      p95: 300,
    });
    expect(latency[20]).toMatchObject({ p50: 40, p95: 120 });
  });
});
