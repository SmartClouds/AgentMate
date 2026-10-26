import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SonarHotspot, SonarIssue } from '@runova/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, type LocalServer, startHttpServer } from '../../test/main/fixtures';
import type { ScanCancelToken } from './exec';
import {
  fetchSonarFindings,
  getSonarStatus,
  validateSonarToken,
  waitForSonarTask,
} from './sonarApi';

/**
 * Driven against a real HTTP server rather than a stubbed fetch, because the things worth
 * asserting here are the request itself: the basic-auth header Sonar expects (token as username,
 * empty password), the exact query strings, and the paging loop's stop conditions. A fetch stub
 * would let all of those drift without failing.
 */

let server: LocalServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function token(): ScanCancelToken {
  return { cancelled: false, child: null };
}

/** Decodes the Authorization header back into the token Sonar was handed. */
function sentToken(headers: NodeJS.Dict<string | string[]>): string {
  const header = String(headers.authorization ?? '');
  return Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf-8');
}

function issue(key: string): SonarIssue {
  return {
    key,
    rule: 'java:S2076',
    severity: 'CRITICAL',
    component: 'proj:src/Main.java',
    project: 'proj',
    line: 12,
    message: 'OS command injection',
    type: 'VULNERABILITY',
  } as SonarIssue;
}

function hotspot(key: string): SonarHotspot {
  return {
    key,
    component: 'proj:src/Main.java',
    project: 'proj',
    securityCategory: 'command-injection',
    vulnerabilityProbability: 'HIGH',
    status: 'TO_REVIEW',
    line: 30,
    message: 'Make sure this is safe',
  } as SonarHotspot;
}

describe('getSonarStatus', () => {
  it('reports up for an UP status', async () => {
    server = await startHttpServer((_request, response) => json(response, { status: 'UP' }));

    await expect(getSonarStatus(server.url)).resolves.toBe('up');
    expect(server.requests[0].url).toBe('/api/system/status');
  });

  it('tolerates a trailing slash on the configured url', async () => {
    server = await startHttpServer((_request, response) => json(response, { status: 'UP' }));

    // Users paste the URL out of a browser, which happily adds the slash.
    await expect(getSonarStatus(`${server.url}/`)).resolves.toBe('up');
    expect(server.requests[0].url).toBe('/api/system/status');
  });

  it.each(['STARTING', 'DB_MIGRATION_NEEDED', 'DB_MIGRATION_RUNNING', 'DOWN'])(
    'reports starting for %s, which just means give it a minute',
    async (status) => {
      server = await startHttpServer((_request, response) => json(response, { status }));

      // First boot of the container takes minutes, and a scan polls for it rather than failing,
      // so anything other than a total absence of a status is "starting".
      await expect(getSonarStatus(server.url)).resolves.toBe('starting');
    },
  );

  it('reports down for a body with no status field', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));

    await expect(getSonarStatus(server.url)).resolves.toBe('down');
  });

  it('reports down for a non-2xx response', async () => {
    server = await startHttpServer((_request, response) => json(response, {}, 503));

    await expect(getSonarStatus(server.url)).resolves.toBe('down');
  });

  it('reports down when nothing is listening', async () => {
    server = await startHttpServer((_request, response) => json(response, { status: 'UP' }));
    const url = server.url;
    await server.close();
    server = null;

    // The common case: the container is not running at all.
    await expect(getSonarStatus(url)).resolves.toBe('down');
  });

  it('reports down for a body that is not JSON', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>proxy login page</html>');
    });

    // A corporate proxy answering with a login page must not read as a healthy server.
    await expect(getSonarStatus(server.url)).resolves.toBe('down');
  });

  it('sends no credentials, since the status endpoint is public', async () => {
    server = await startHttpServer((_request, response) => json(response, { status: 'UP' }));

    await getSonarStatus(server.url);

    expect(server.requests[0].headers.authorization).toBeUndefined();
  });
});

describe('validateSonarToken', () => {
  it('accepts a token the server says is valid', async () => {
    server = await startHttpServer((_request, response) => json(response, { valid: true }));

    await expect(validateSonarToken(server.url, 'squ_abc123')).resolves.toBe(true);
    expect(server.requests[0].url).toBe('/api/authentication/validate');
    // Sonar takes the token as the basic-auth username with an empty password.
    expect(sentToken(server.requests[0].headers)).toBe('squ_abc123:');
  });

  it('rejects a token the server says is invalid', async () => {
    server = await startHttpServer((_request, response) => json(response, { valid: false }));

    // A token revoked by a container reset would otherwise only surface twenty minutes in.
    await expect(validateSonarToken(server.url, 'stale')).resolves.toBe(false);
  });

  it('rejects when the endpoint answers 401', async () => {
    server = await startHttpServer((_request, response) => json(response, {}, 401));

    await expect(validateSonarToken(server.url, 'nope')).resolves.toBe(false);
  });

  it('rejects when the server cannot be reached', async () => {
    server = await startHttpServer((_request, response) => json(response, { valid: true }));
    const url = server.url;
    await server.close();
    server = null;

    await expect(validateSonarToken(url, 'anything')).resolves.toBe(false);
  });
});

describe('waitForSonarTask', () => {
  it('reads the task id out of the scanner log and polls that task', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'SUCCESS' } }),
    );
    // The scanner echoes report-task.txt into its own output, which is the only copy the app can
    // read: the file itself is written inside the scan container.
    const log = [
      'INFO: Analysis report uploaded in 84ms',
      'INFO: ce-task-url=http://localhost:9000/api/ce/task?id=AXy-9Z_task1',
    ].join('\n');

    await expect(waitForSonarTask(server.url, 'tok', 'proj', log, token())).resolves.toEqual({
      ok: true,
    });

    expect(server.requests[0].url).toBe('/api/ce/task?id=AXy-9Z_task1');
  });

  it('falls back to polling the component when the log carries no task id', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { current: { status: 'SUCCESS' } }),
    );

    // The human-readable "More about the report processing at ..." line is not one of the two
    // forms the id is read from, so this is the path a log without ce-task-url takes.
    const log = 'INFO: More about the report processing at http://localhost:9000/api/ce/task?id=x';

    await waitForSonarTask(server.url, 'tok', 'proj', log, token());

    expect(server.requests[0].url).toBe('/api/ce/component?component=proj');
  });

  it('also reads the older taskId= form', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'SUCCESS' } }),
    );

    await waitForSonarTask(server.url, 'tok', 'proj', 'taskId=legacy-42', token());

    expect(server.requests[0].url).toBe('/api/ce/task?id=legacy-42');
  });

  it('falls back to the component endpoint when the log has no task id', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { current: { status: 'SUCCESS' }, queue: [] }),
    );

    await expect(
      waitForSonarTask(server.url, 'tok', 'my proj:key', 'no id here', token()),
    ).resolves.toEqual({ ok: true });

    // The component endpoint answers with `current` plus a `queue`, not `task`.
    expect(server.requests[0].url).toBe('/api/ce/component?component=my%20proj%3Akey');
  });

  it('waits while the component queue still has work in it', async () => {
    // SUCCESS with a non-empty queue means an older task finished and this one has not, so
    // reading issues now would return the previous analysis: a silently wrong answer.
    let polls = 0;
    server = await startHttpServer((_request, response) => {
      polls += 1;
      json(
        response,
        polls === 1
          ? { current: { status: 'SUCCESS' }, queue: [{ id: 'pending' }] }
          : { current: { status: 'SUCCESS' }, queue: [] },
      );
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = waitForSonarTask(server.url, 'tok', 'proj', '', token());
    await vi.waitFor(() => expect(polls).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(polls).toBe(2);
  });

  it('keeps polling while the task is still in progress', async () => {
    let polls = 0;
    server = await startHttpServer((_request, response) => {
      polls += 1;
      json(response, { task: { status: polls < 3 ? 'IN_PROGRESS' : 'SUCCESS' } });
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', token());
    await vi.waitFor(() => expect(polls).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(polls).toBe(2));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('reports a FAILED analysis', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'FAILED' } }),
    );

    await expect(
      waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', token()),
    ).resolves.toEqual({
      ok: false,
      error: 'SonarQube failed to analyze this project.',
    });
  });

  it('reports a CANCELED analysis', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'CANCELED' } }),
    );

    await expect(
      waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', token()),
    ).resolves.toEqual({
      ok: false,
      error: 'The SonarQube analysis was cancelled.',
    });
  });

  it('stops immediately when the run has been cancelled', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'SUCCESS' } }),
    );

    const cancelled: ScanCancelToken = { cancelled: true, child: null };
    await expect(
      waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', cancelled),
    ).resolves.toEqual({ ok: false, error: 'Cancelled.' });

    // Nothing should be asked of the server once the user has pressed stop.
    expect(server.requests).toEqual([]);
  });

  it('notices a cancel that arrives between polls', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'IN_PROGRESS' } }),
    );
    const live = token();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', live);
    await vi.waitFor(() => expect(server?.requests.length).toBe(1));
    live.cancelled = true;
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: false, error: 'Cancelled.' });
  });

  it('retries rather than giving up when a poll fails outright', async () => {
    let polls = 0;
    server = await startHttpServer((_request, response) => {
      polls += 1;
      if (polls === 1) {
        // The server restarting mid-analysis is a transient failure, not a verdict.
        response.writeHead(502);
        response.end();
        return;
      }
      json(response, { task: { status: 'SUCCESS' } });
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = waitForSonarTask(server.url, 'tok', 'proj', 'taskId=t1', token());
    await vi.waitFor(() => expect(polls).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('sends the token on every poll', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { task: { status: 'SUCCESS' } }),
    );

    await waitForSonarTask(server.url, 'squ_poll', 'proj', 'taskId=t1', token());

    expect(sentToken(server.requests[0].headers)).toBe('squ_poll:');
  });
});

describe('fetchSonarFindings', () => {
  /** Answers the issues and hotspots searches from the given pages. */
  function searchServer(
    issuePages: SonarIssue[][],
    hotspotPages: SonarHotspot[][],
    total = 0,
  ): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const page = Number(url.searchParams.get('p') ?? '1');
      if (url.pathname === '/api/issues/search') {
        json(response, { issues: issuePages[page - 1] ?? [], paging: { total } });
        return;
      }
      json(response, { hotspots: hotspotPages[page - 1] ?? [] });
    };
  }

  it('returns issues and hotspots from a single page each', async () => {
    server = await startHttpServer(
      searchServer([[issue('i1'), issue('i2')]], [[hotspot('h1')]], 2),
    );

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    expect(result.issues.map((one) => one.key)).toEqual(['i1', 'i2']);
    expect(result.hotspots.map((one) => one.key)).toEqual(['h1']);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('filters server-side rather than locally', async () => {
    server = await startHttpServer(searchServer([[]], [[]]));

    await fetchSonarFindings(server.url, 'tok', 'my-proj');

    // Sonar reports every code smell it can find, and the 10k paging ceiling is only ever hit
    // when the query is unfiltered, so these parameters are load bearing.
    const issues = new URL(server.requests[0].url, 'http://x');
    expect(issues.pathname).toBe('/api/issues/search');
    expect(issues.searchParams.get('componentKeys')).toBe('my-proj');
    expect(issues.searchParams.get('types')).toBe('VULNERABILITY');
    expect(issues.searchParams.get('resolved')).toBe('false');
    expect(issues.searchParams.get('ps')).toBe('500');
    expect(issues.searchParams.get('p')).toBe('1');

    const hotspots = new URL(server.requests[1].url, 'http://x');
    expect(hotspots.pathname).toBe('/api/hotspots/search');
    expect(hotspots.searchParams.get('projectKey')).toBe('my-proj');
    expect(hotspots.searchParams.get('status')).toBe('TO_REVIEW');
  });

  it('url-encodes a project key with special characters', async () => {
    server = await startHttpServer(searchServer([[]], [[]]));

    await fetchSonarFindings(server.url, 'tok', 'group:sub proj');

    expect(server.requests[0].url).toContain('componentKeys=group%3Asub%20proj');
  });

  it('stops after one page when the page is not full', async () => {
    server = await startHttpServer(searchServer([[issue('i1')]], [[hotspot('h1')]], 1));

    await fetchSonarFindings(server.url, 'tok', 'proj');

    // Two requests total: one issues page, one hotspots page.
    expect(server.requests).toHaveLength(2);
  });

  it('pages through a full first page', async () => {
    const full = Array.from({ length: 500 }, (_unused, index) => issue(`i${index}`));
    server = await startHttpServer(searchServer([full, [issue('last')]], [[]], 501));

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    expect(result.issues).toHaveLength(501);
    expect(result.issues[500].key).toBe('last');
    expect(result.truncated).toBe(false);
  });

  it('stops paging once it has as many issues as the total says exist', async () => {
    const full = Array.from({ length: 500 }, (_unused, index) => issue(`i${index}`));
    server = await startHttpServer(searchServer([full, [issue('extra')]], [[]], 500));

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    // The total is the authority; asking for page 2 anyway would just repeat work.
    expect(result.issues).toHaveLength(500);
    expect(server.requests.filter((one) => one.url.startsWith('/api/issues/search'))).toHaveLength(
      1,
    );
  });

  it('returns an error when the very first issues page fails', async () => {
    server = await startHttpServer((_request, response) => json(response, {}, 500));

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    expect(result.error).toBe('Could not read issues from SonarQube.');
    expect(result.issues).toEqual([]);
    // Bailing out here stops an empty report being presented as a clean bill of health.
    expect(result.hotspots).toEqual([]);
  });

  it('marks the result truncated when a later issues page fails', async () => {
    const full = Array.from({ length: 500 }, (_unused, index) => issue(`i${index}`));
    let issuePolls = 0;
    server = await startHttpServer((request, response) => {
      if ((request.url ?? '').startsWith('/api/issues/search')) {
        issuePolls += 1;
        if (issuePolls === 1) {
          json(response, { issues: full, paging: { total: 1200 } });
          return;
        }
        json(response, {}, 500);
        return;
      }
      json(response, { hotspots: [] });
    });

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    // Keeping the first 500 with a truncation flag beats discarding a partial answer.
    expect(result.issues).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('does not fail the whole fetch when hotspots are unavailable', async () => {
    server = await startHttpServer((request, response) => {
      if ((request.url ?? '').startsWith('/api/issues/search')) {
        json(response, { issues: [issue('i1')], paging: { total: 1 } });
        return;
      }
      // Hotspots need a paid edition on some setups, so a failure here is expected.
      json(response, {}, 403);
    });

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    expect(result.issues).toHaveLength(1);
    expect(result.hotspots).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('pages hotspots as well', async () => {
    const full = Array.from({ length: 500 }, (_unused, index) => hotspot(`h${index}`));
    server = await startHttpServer(searchServer([[]], [full, [hotspot('tail')]]));

    const result = await fetchSonarFindings(server.url, 'tok', 'proj');

    expect(result.hotspots).toHaveLength(501);
  });

  it('sends the token on the search calls', async () => {
    server = await startHttpServer(searchServer([[]], [[]]));

    await fetchSonarFindings(server.url, 'squ_search', 'proj');

    for (const request of server.requests) {
      expect(sentToken(request.headers)).toBe('squ_search:');
    }
  });
});
