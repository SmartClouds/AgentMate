import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, type LocalServer, startHttpServer } from '../../test/main/fixtures';
import { type HealthProbeTarget, type HealthTransport, probeHealthTarget } from './probe';

/**
 * One probe against a real local server over Node's fetch, which is what the app's net.fetch
 * transport stands in for. What matters most: the key goes only to the address the user saved
 * (never to a redirect, never over plain http to another host), and nothing the endpoint sends
 * back can hold the key once it is a report.
 */

const NOW = 1_760_000_000_000;
const KEY = 'rnh_k3yThatMustNeverLeakAnywhere0123456789abcdefg';
const servers: LocalServer[] = [];
const nodeFetch: HealthTransport = (url, init) => fetch(url, init);

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function server(
  handler: Parameters<typeof startHttpServer>[0],
): Promise<LocalServer & { target: HealthProbeTarget }> {
  const started = await startHttpServer(handler);
  servers.push(started);
  return { ...started, target: target(`${started.url}/_runova/health`) };
}

function target(url: string, overrides: Partial<HealthProbeTarget> = {}): HealthProbeTarget {
  return {
    url,
    timeoutSec: 5,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    ...overrides,
  };
}

function probe(
  probeTarget: HealthProbeTarget,
  transport: HealthTransport = nodeFetch,
  secret = KEY,
) {
  return probeHealthTarget(probeTarget, secret, { transport, now: () => NOW });
}

const passing = {
  status: 'pass',
  releaseId: '1.0.0',
  checks: { 'postgres:connection': [{ status: 'pass', observedValue: 3, observedUnit: 'ms' }] },
};

describe('probeHealthTarget against a compliant endpoint', () => {
  it('reads a passing report and times it', async () => {
    const site = await server((_req, res) => json(res, passing));
    const report = await probe(site.target);
    expect(report.state).toBe('pass');
    expect(report.httpStatus).toBe(200);
    expect(report.checkedAt).toBe(NOW);
    expect(report.releaseId).toBe('1.0.0');
    expect(report.services.map((service) => service.key)).toEqual(['postgres:connection']);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends a GET with the Bearer key and the protocol headers', async () => {
    const site = await server((_req, res) => json(res, passing));
    await probe(site.target);
    expect(site.requests).toHaveLength(1);
    const [request] = site.requests;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/_runova/health');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers.accept).toBe('application/health+json');
    expect(request.headers['user-agent']).toBe('Runova-Health/1');
    expect(request.headers['cache-control']).toBe('no-cache');
  });

  it('sends HTTP Basic credentials for a Basic target', async () => {
    const site = await server((_req, res) => json(res, passing));
    await probe({ ...site.target, authMode: 'basic', basicUser: 'runova' }, nodeFetch, 'pw-1');
    const expected = Buffer.from('runova:pw-1', 'utf-8').toString('base64');
    expect(site.requests[0].headers.authorization).toBe(`Basic ${expected}`);
  });

  it('reports warn when a check is degraded', async () => {
    const site = await server((_req, res) =>
      json(res, {
        status: 'pass',
        checks: { 'disk:free': [{ status: 'warn', output: 'Less than 10% left' }] },
      }),
    );
    const report = await probe(site.target);
    expect(report.state).toBe('warn');
    expect(report.services[0].error?.message).toBe('Less than 10% left');
  });

  it('reports fail with the failing service on a 503', async () => {
    const site = await server((_req, res) =>
      json(
        res,
        {
          status: 'fail',
          checks: {
            'redis:ping': [
              { status: 'fail', output: 'connect ECONNREFUSED', runova: { errorCode: 'X' } },
            ],
          },
        },
        503,
      ),
    );
    const report = await probe(site.target);
    expect(report.state).toBe('fail');
    expect(report.httpStatus).toBe(503);
    expect(report.services[0]).toMatchObject({ key: 'redis:ping', status: 'fail' });
  });

  it('reports unauthorized on a 401', async () => {
    const site = await server((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="runova-health"' });
      res.end();
    });
    const report = await probe(site.target);
    expect(report.state).toBe('unauthorized');
    expect(report.httpStatus).toBe(401);
  });

  it('reports invalid when the body is not JSON', async () => {
    const site = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    });
    const report = await probe(site.target);
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/not JSON/);
  });

  it('masks the key when the endpoint echoes it back', async () => {
    const site = await server((req, res) =>
      json(
        res,
        {
          status: 'fail',
          output: `got header ${String(req.headers.authorization)}`,
          checks: { 'auth:echo': [{ status: 'fail', output: `token was ${KEY}` }] },
        },
        503,
      ),
    );
    const report = await probe(site.target);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(KEY.slice(4));
  });
});

describe('probeHealthTarget refuses what would leak the key', () => {
  it('does not follow a redirect, so the target of it never sees the key', async () => {
    const elsewhere = await server((_req, res) => json(res, passing));
    const site = await server((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.url}/steal` });
      res.end();
    });
    const report = await probe(site.target);
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/redirect/i);
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("treats Electron's cancelled redirect as a redirect", async () => {
    const transport = vi.fn<HealthTransport>(async () => {
      throw new Error('Redirect was cancelled');
    });
    const report = await probe(target('https://shop.example.com/health'), transport);
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/redirect/i);
  });

  it('never sends the key over plain http to a host that is not this computer', async () => {
    const transport = vi.fn<HealthTransport>();
    const report = await probe(target('http://shop.example.com/health'), transport);
    expect(transport).not.toHaveBeenCalled();
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/https/);
  });

  it('allows plain http to a remote host only when the target allows it', async () => {
    const transport = vi.fn<HealthTransport>(async () => Response.json(passing));
    const report = await probe(
      target('http://shop.example.com/health', { allowInsecure: true }),
      transport,
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(report.state).toBe('pass');
  });

  it.each([
    'http://localhost:3000/health',
    'http://127.0.0.1/health',
    'http://127.8.9.10:81/health',
    'http://[::1]:8080/health',
    'https://shop.example.com/health',
  ])('allows %s without the insecure switch', async (url) => {
    const transport = vi.fn<HealthTransport>(async () => Response.json(passing));
    await probe(target(url), transport);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('refuses an address that does not parse, or is not http', async () => {
    const transport = vi.fn<HealthTransport>();
    expect((await probe(target('not a url'), transport)).state).toBe('invalid');
    expect((await probe(target('ftp://example.com/x'), transport)).state).toBe('invalid');
    expect(transport).not.toHaveBeenCalled();
  });

  it('stops reading a body larger than 512 KB', async () => {
    const site = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/health+json' });
      res.end(`{"status":"pass","pad":"${'x'.repeat(600 * 1024)}"}`);
    });
    const report = await probe(site.target);
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/larger than 512 KB/);
  });

  it('refuses a declared length over the cap before reading it', async () => {
    const cancel = vi.fn(async () => undefined);
    const transport = vi.fn<HealthTransport>(async () => {
      const response = new Response('{}', { headers: { 'content-length': `${1024 * 1024}` } });
      Object.defineProperty(response, 'body', { value: { cancel, getReader: vi.fn() } });
      return response;
    });
    const report = await probe(target('https://shop.example.com/health'), transport);
    expect(report.problem).toMatch(/larger than 512 KB/);
    expect(cancel).toHaveBeenCalled();
  });

  it('reads an empty body as an empty answer', async () => {
    const transport = vi.fn<HealthTransport>(async () => new Response(null, { status: 200 }));
    const report = await probe(target('https://shop.example.com/health'), transport);
    expect(report.state).toBe('invalid');
    expect(report.problem).toMatch(/empty body/);
  });
});

describe('probeHealthTarget when the endpoint cannot be reached', () => {
  it('times out after the target timeout', async () => {
    const site = await server(() => {
      // Never answers.
    });
    const report = await probe({ ...site.target, timeoutSec: 0.3 });
    expect(report.state).toBe('unreachable');
    expect(report.problem).toBe('Timed out after 0.3 s.');
  });

  it('says the connection was refused', async () => {
    const site = await server((_req, res) => json(res, passing));
    await site.close();
    const report = await probe(site.target);
    expect(report.state).toBe('unreachable');
    expect(report.problem).toMatch(/refused/);
  });

  function failing(error: unknown): HealthTransport {
    return async () => {
      throw error;
    };
  }

  it.each([
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /resolved/],
    [new Error('net::ERR_NAME_NOT_RESOLVED'), /resolved/],
    [new Error('net::ERR_CONNECTION_REFUSED'), /refused/],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), /certificate/],
    [
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      }),
      /certificate/,
    ],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), /reset/],
    [new Error('net::ERR_CONNECTION_TIMED_OUT'), /timed out/i],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), /ERR_INTERNET_DISCONNECTED/],
    [Object.assign(new Error('Aborted'), { name: 'AbortError' }), /Timed out/],
    ['a plain string', /a plain string/],
  ])('explains %s', async (error, problem) => {
    const report = await probe(target('https://shop.example.com/health'), failing(error));
    expect(report.state).toBe('unreachable');
    expect(report.problem).toMatch(problem);
  });

  it('keeps the key out of an error message that holds it', async () => {
    const report = await probe(
      target('https://shop.example.com/health'),
      failing(new Error(`bad header value ${KEY}`)),
    );
    expect(report.problem).not.toContain(KEY);
  });
});
