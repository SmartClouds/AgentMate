import { describe, expect, it } from 'vitest';
import { parseHealthResponse, probeFailureReport } from './parse.js';

const AT = 1_760_000_000_000;

function respond(httpStatus: number, body: unknown, contentType = 'application/health+json') {
  return parseHealthResponse({
    httpStatus,
    contentType,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    latencyMs: 42,
    checkedAt: AT,
  });
}

const PASSING = {
  status: 'pass',
  version: '1',
  releaseId: '1.4.2+abc',
  serviceId: 'curalink-api',
  description: 'CuraLink API',
  checks: {
    'postgres:connection': [
      {
        componentId: 'db',
        componentType: 'datastore',
        status: 'pass',
        observedValue: 12,
        observedUnit: 'ms',
      },
    ],
    uptime: [{ componentType: 'system', status: 'pass', observedValue: 3600, observedUnit: 's' }],
  },
  runova: { protocol: 'runova-health/1' },
};

describe('parseHealthResponse', () => {
  it('normalizes a passing report', () => {
    const report = respond(200, PASSING);
    expect(report.state).toBe('pass');
    expect(report.httpStatus).toBe(200);
    expect(report.latencyMs).toBe(42);
    expect(report.checkedAt).toBe(AT);
    expect(report.serviceId).toBe('curalink-api');
    expect(report.releaseId).toBe('1.4.2+abc');
    expect(report.problem).toBeNull();
    expect(report.services).toHaveLength(2);
    expect(report.services[0]).toMatchObject({
      key: 'postgres:connection',
      name: 'postgres',
      measurement: 'connection',
      componentId: 'db',
      componentType: 'datastore',
      status: 'pass',
      observedValue: 12,
      observedUnit: 'ms',
      error: null,
    });
    expect(report.services[1]).toMatchObject({ key: 'uptime', name: 'uptime', measurement: null });
    expect(report.raw).toContain('"curalink-api"');
  });

  it('keeps every component under one check key as its own service', () => {
    const report = respond(200, {
      status: 'pass',
      checks: {
        'cache:responseTime': [
          { componentId: 'redis-1', status: 'pass' },
          { componentId: 'redis-2', status: 'pass' },
        ],
      },
    });
    expect(report.services.map((s) => s.key)).toEqual([
      'cache:responseTime#redis-1',
      'cache:responseTime#redis-2',
    ]);
  });

  it('reads a failing service with its Runova error details', () => {
    const report = respond(503, {
      status: 'fail',
      checks: {
        'postgres:connection': [
          {
            status: 'fail',
            time: '2026-10-17T10:00:00Z',
            output: 'connect ECONNREFUSED 10.0.0.5:5432',
            runova: {
              errorCode: 'ECONNREFUSED',
              detail: 'Pool exhausted after 3 retries',
              stack: 'Error: connect ECONNREFUSED\n    at Pool.connect (pool.js:10)',
              hint: 'Is the database container running?',
              since: '2026-10-17T09:58:00Z',
            },
          },
        ],
      },
    });
    expect(report.state).toBe('fail');
    expect(report.services[0].error).toEqual({
      message: 'connect ECONNREFUSED 10.0.0.5:5432',
      code: 'ECONNREFUSED',
      detail: 'Pool exhausted after 3 retries',
      stack: 'Error: connect ECONNREFUSED\n    at Pool.connect (pool.js:10)',
      hint: 'Is the database container running?',
      since: '2026-10-17T09:58:00Z',
    });
  });

  it('reads the error details from an endpoint built before the app was renamed', () => {
    const report = respond(503, {
      status: 'fail',
      agentmate: { protocol: 'agentmate-health/1' }, // legacy-name
      checks: {
        queue: [
          {
            status: 'fail',
            output: 'broker down',
            agentmate: { errorCode: 'E_BROKER', hint: 'Start RabbitMQ' }, // legacy-name
          },
        ],
      },
    });
    expect(report.services[0].error).toMatchObject({
      message: 'broker down',
      code: 'E_BROKER',
      hint: 'Start RabbitMQ',
    });
  });

  it('gives a failing service with no output a message anyway', () => {
    const report = respond(503, { status: 'fail', checks: { queue: [{ status: 'fail' }] } });
    expect(report.services[0].error?.message).toMatch(/no error message/i);
  });

  it('accepts the draft synonyms for status', () => {
    expect(respond(200, { status: 'ok' }).state).toBe('pass');
    expect(respond(200, { status: 'UP' }).state).toBe('pass');
    expect(respond(503, { status: 'down' }).state).toBe('fail');
    expect(respond(503, { status: 'error' }).state).toBe('fail');
    expect(respond(200, { status: 'warn' }).state).toBe('warn');
  });

  it('turns a pass with a failing check into warn, so a problem is never hidden', () => {
    const report = respond(200, {
      status: 'pass',
      checks: { mail: [{ status: 'fail', output: 'SMTP timeout' }] },
    });
    expect(report.state).toBe('warn');
  });

  it('treats a pass on a 5xx response as a failure', () => {
    expect(respond(500, { status: 'pass' }).state).toBe('fail');
  });

  it('marks 401 and 403 as unauthorized without reading the body', () => {
    const report = respond(401, '');
    expect(report.state).toBe('unauthorized');
    expect(report.problem).toMatch(/rejected/i);
    expect(respond(403, { status: 'pass' }).state).toBe('unauthorized');
  });

  it('refuses a redirect', () => {
    const report = respond(302, '');
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/redirect/i);
  });

  it('says when there is no healthcheck at the address', () => {
    const report = respond(404, '<html>Not found</html>', 'text/html');
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/404/);
  });

  it('marks a body that is not JSON as invalid on success and as a failure on 5xx', () => {
    const ok = respond(200, '<html>hello</html>', 'text/html');
    expect(ok.state).toBe('invalid');
    expect(ok.problem).toMatch(/not JSON/i);
    expect(ok.raw).toContain('<html>hello</html>');

    const crash = respond(500, 'Internal Server Error', 'text/plain');
    expect(crash.state).toBe('fail');
    expect(crash.problem).toMatch(/500/);
  });

  it('marks a 503 with no body as a failure', () => {
    const report = respond(503, '');
    expect(report.state).toBe('fail');
    expect(report.problem).toMatch(/503/);
  });

  it('marks JSON that does not follow the protocol as invalid, saying why', () => {
    const missing = respond(200, { checks: {} });
    expect(missing.state).toBe('invalid');
    expect(missing.problem).toMatch(/status/);

    const wrong = respond(200, { status: 'great' });
    expect(wrong.state).toBe('invalid');
    expect(wrong.problem).toMatch(/great/);

    const array = respond(200, [1, 2]);
    expect(array.state).toBe('invalid');
  });

  it('skips check entries that are malformed rather than rejecting the whole report', () => {
    const report = respond(200, {
      status: 'pass',
      checks: { good: [{ status: 'pass' }], bad: 'nope', worse: [{ status: 'meh' }, 7] },
    });
    expect(report.state).toBe('pass');
    expect(report.services.map((s) => s.key)).toEqual(['good']);
  });

  it('redacts secrets everywhere they can appear', () => {
    const report = respond(503, {
      status: 'fail',
      output: 'DATABASE_URL=postgres://u:pw1234@db/app',
      checks: {
        db: [
          {
            status: 'fail',
            output: 'postgres://u:pw1234@db/app refused',
            runova: { detail: 'password=pw1234', stack: 'at token=pw1234', hint: 'pw1234' },
          },
        ],
      },
    });
    const all = JSON.stringify(report);
    expect(all).not.toContain('pw1234@');
    expect(all).not.toContain('password=pw1234');
    expect(all).not.toContain('token=pw1234');
    expect(report.raw).not.toContain('pw1234@');
  });

  it('masks a literal secret the caller knows, such as the key it sent', () => {
    const key = `rnh_${'k'.repeat(43)}`;
    const report = parseHealthResponse({
      httpStatus: 503,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'fail', output: `bad header ${key}` }),
      latencyMs: 1,
      checkedAt: AT,
      knownSecrets: [key],
    });
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it('trims long text so one noisy service cannot flood the store', () => {
    const report = respond(503, {
      status: 'fail',
      checks: {
        db: [{ status: 'fail', output: 'x'.repeat(10_000), runova: { stack: 'y'.repeat(50_000) } }],
      },
    });
    const error = report.services[0].error;
    expect(error?.message.length).toBeLessThanOrEqual(2_100);
    expect(error?.stack?.length).toBeLessThanOrEqual(8_300);
    expect(report.raw?.length).toBeLessThanOrEqual(64_200);
  });

  it('caps the number of services', () => {
    const checks: Record<string, unknown> = {};
    for (let i = 0; i < 300; i += 1) checks[`c${i}`] = [{ status: 'pass' }];
    expect(respond(200, { status: 'pass', checks }).services).toHaveLength(200);
  });

  it('accepts a plain application/json content type', () => {
    expect(respond(200, { status: 'pass' }, 'application/json; charset=utf-8').state).toBe('pass');
  });
});

describe('probeFailureReport', () => {
  it('builds an unreachable report with the reason', () => {
    const report = probeFailureReport('Connection refused', AT);
    expect(report).toMatchObject({
      state: 'unreachable',
      httpStatus: null,
      latencyMs: null,
      checkedAt: AT,
      problem: 'Connection refused',
      services: [],
      raw: null,
    });
  });

  it('can mark the failure as invalid instead, and redacts the reason', () => {
    const report = probeFailureReport('bad url https://u:secretpw@x', AT, 'invalid');
    expect(report.state).toBe('invalid');
    expect(report.problem).not.toContain('secretpw');
  });
});
