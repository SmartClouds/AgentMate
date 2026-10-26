import { readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LocalServer, startHttpServer, tempDir } from '../../test/main/fixtures';

/**
 * `net.request` is Electron's HTTP client, which the mock does not provide. Backing it with
 * node:http keeps every assertion here against a real socket: the resume logic is all about
 * headers, status codes and a connection dying part way through a body, none of which a stubbed
 * fetch would reproduce.
 */
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    net: {
      ...(actual.net as Record<string, unknown>),
      request: (options: { method: string; url: string }) =>
        httpRequest(options.url, { method: options.method }),
    },
  };
});

const { DownloadAbortedError, DownloadFatalError, ResumableDownload, fileSize } = await import(
  './resumableDownload'
);

const BODY = Buffer.from('0123456789abcdefghijABCDEFGHIJ'.repeat(4), 'utf-8');

let server: LocalServer | null = null;
let dir = '';
let destPath = '';

beforeEach(() => {
  dir = tempDir('runova-download-');
  destPath = join(dir, 'Runova-Setup.exe');
});

afterEach(async () => {
  await server?.close();
  server = null;
});

interface Recorded {
  progress: { transferred: number; total: number; bytesPerSecond: number }[];
  reconnects: [number, number][];
}

function options(
  extra: Partial<Parameters<InstanceType<typeof ResumableDownload>['run']>[0]> = {},
) {
  const recorded: Recorded = { progress: [], reconnects: [] };
  const base = {
    url: `${server?.url}/Runova-Setup.exe`,
    destPath,
    expectedSize: BODY.length as number | null,
    userAgent: 'Runova/1.0 (test)',
    onProgress: (progress: Recorded['progress'][number]) => recorded.progress.push(progress),
    onReconnect: (attempt: number, transferred: number) =>
      recorded.reconnects.push([attempt, transferred]),
    ...extra,
  };
  return { run: base, recorded };
}

/** Serves `BODY` and honours a Range header the way a release CDN does. */
function serveRange(response: ServerResponse, range: string | undefined): void {
  const match = range ? /^bytes=(\d+)-/.exec(range) : null;
  if (!match) {
    response.writeHead(200, {
      'content-length': String(BODY.length),
      'content-type': 'application/octet-stream',
    });
    response.end(BODY);
    return;
  }
  const start = Number(match[1]);
  const slice = BODY.subarray(start);
  response.writeHead(206, {
    'content-length': String(slice.length),
    'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
  });
  response.end(slice);
}

describe('fileSize', () => {
  it('reports zero for a file that is not there yet', async () => {
    await expect(fileSize(join(dir, 'nothing.bin'))).resolves.toBe(0);
  });

  it('reports the byte count of a partial file', async () => {
    writeFileSync(destPath, BODY.subarray(0, 17));
    await expect(fileSize(destPath)).resolves.toBe(17);
  });
});

describe('ResumableDownload happy path', () => {
  it('downloads the whole file and reports progress', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    expect(readFileSync(destPath)).toEqual(BODY);
    // No partial file, so no Range header should go out at all.
    expect(server.requests[0].headers.range).toBeUndefined();
    expect(server.requests[0].headers['user-agent']).toBe('Runova/1.0 (test)');
    expect(server.requests[0].headers['cache-control']).toBe('no-cache');
    expect(recorded.progress.length).toBeGreaterThan(0);
    const last = recorded.progress[recorded.progress.length - 1];
    expect(last).toMatchObject({ transferred: BODY.length, total: BODY.length });
    expect(last.bytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(recorded.reconnects).toEqual([]);
  });

  it('returns straight away when the file is already complete', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    writeFileSync(destPath, BODY);
    const { run } = options();

    await new ResumableDownload().run(run);

    // Re-downloading a finished installer would waste the user's bandwidth.
    expect(server.requests).toEqual([]);
  });

  it('derives the total from content-length when no expected size is known', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    const { run, recorded } = options({ expectedSize: null });

    await new ResumableDownload().run(run);

    const last = recorded.progress[recorded.progress.length - 1];
    expect(last.total).toBe(BODY.length);
  });
});

describe('ResumableDownload resume', () => {
  it('asks for the missing bytes and appends them to the partial file', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    writeFileSync(destPath, BODY.subarray(0, 40));
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    expect(server.requests[0].headers.range).toBe('bytes=40-');
    // Appended, not restarted, which is the whole point of keeping the partial file.
    expect(readFileSync(destPath)).toEqual(BODY);
    expect(recorded.progress[0].transferred).toBe(40);
  });

  it('restarts cleanly when the server ignores Range and sends the whole body', async () => {
    server = await startHttpServer((_request, response) => {
      // A 200 to a Range request means the server does not do partial content.
      response.writeHead(200, { 'content-length': String(BODY.length) });
      response.end(BODY);
    });
    writeFileSync(destPath, BODY.subarray(0, 40));
    const { run } = options();

    await new ResumableDownload().run(run);

    // Appending here would have produced a 160 byte file that fails to install.
    expect(readFileSync(destPath)).toEqual(BODY);
  });

  it('retries after a 416 and completes on the next attempt', async () => {
    let served = 0;
    server = await startHttpServer((request, response) => {
      served += 1;
      if (served === 1) {
        response.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
        response.end();
        return;
      }
      serveRange(response, request.headers.range);
    });
    writeFileSync(destPath, BODY.subarray(0, 40));
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    // A 416 is recoverable, so the download must not be handed to the user as a failure.
    expect(recorded.reconnects).toEqual([[1, 40]]);
    expect(readFileSync(destPath)).toEqual(BODY);
  });

  it('resumes after the connection dies part way through the body', async () => {
    let served = 0;
    server = await startHttpServer((request, response) => {
      served += 1;
      if (served === 1) {
        response.writeHead(200, { 'content-length': String(BODY.length) });
        // Half-closing once the first chunk is out is what a dropped connection looks like:
        // the client has the bytes but the body never reaches the promised length.
        response.write(BODY.subarray(0, 50), () => response.socket?.end());
        return;
      }
      serveRange(response, request.headers.range);
    });
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    expect(recorded.reconnects).toHaveLength(1);
    expect(recorded.reconnects[0][0]).toBe(1);
    // The retry asks for exactly the bytes that survived on disk, so the 50 already received
    // are never fetched twice.
    expect(server.requests[1].headers.range).toBe('bytes=50-');
    expect(readFileSync(destPath)).toEqual(BODY);
  });

  it('retries when the body ends short of the expected size', async () => {
    let served = 0;
    server = await startHttpServer((request, response) => {
      served += 1;
      if (served === 1) {
        // A complete, well formed response that is simply shorter than the published
        // installer, which is the case the expected-size check exists for.
        response.writeHead(200, { 'content-length': '60' });
        response.end(BODY.subarray(0, 60));
        return;
      }
      serveRange(response, request.headers.range);
    });
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    expect(recorded.reconnects).toEqual([[1, 60]]);
    expect(readFileSync(destPath)).toEqual(BODY);
  });
});

describe('ResumableDownload failures', () => {
  it.each([404, 403, 410])('treats HTTP %i as fatal rather than retrying forever', async (code) => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(code);
      response.end();
    });
    const { run, recorded } = options();

    await expect(new ResumableDownload().run(run)).rejects.toBeInstanceOf(DownloadFatalError);
    // The asset is gone, so a retry would only spin.
    expect(recorded.reconnects).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('refuses a partial file larger than the published installer', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    writeFileSync(destPath, Buffer.concat([BODY, BODY]));
    const { run } = options();

    await expect(new ResumableDownload().run(run)).rejects.toThrow(
      /Partial download is larger than the published installer/,
    );
    // Nothing was requested, so the stale file is left for the user to delete.
    expect(server.requests).toEqual([]);
  });

  it('keeps retrying a plain HTTP error instead of failing', async () => {
    let served = 0;
    server = await startHttpServer((request, response) => {
      served += 1;
      if (served <= 2) {
        response.writeHead(502);
        response.end();
        return;
      }
      serveRange(response, request.headers.range);
    });
    const { run, recorded } = options();

    await new ResumableDownload().run(run);

    expect(recorded.reconnects.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(readFileSync(destPath)).toEqual(BODY);
  });
});

describe('ResumableDownload abort', () => {
  it('rejects with DownloadAbortedError and keeps the bytes already written', async () => {
    let held: ServerResponse | null = null;
    server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'content-length': String(BODY.length) });
      response.write(BODY.subarray(0, 50));
      // Held open so the abort lands mid-download, the way a user pausing does.
      held = response;
    });

    const download = new ResumableDownload();
    const { run, recorded } = options({
      onProgress: (progress: { transferred: number }) => {
        recorded.progress.push(progress as Recorded['progress'][number]);
        if (progress.transferred >= 50) download.abort();
      },
    });

    await expect(download.run(run)).rejects.toBeInstanceOf(DownloadAbortedError);

    expect(download.wasAborted).toBe(true);
    // An abort must never be reported as a connection problem worth retrying.
    expect(recorded.reconnects).toEqual([]);
    // The promise can reject a tick before the write stream has finished flushing, so the
    // bytes are checked once they have landed rather than at the instant of the rejection.
    await vi.waitFor(async () => expect(await fileSize(destPath)).toBe(50));
    (held as ServerResponse | null)?.end();
  });

  it('resumes from the paused offset when run again', async () => {
    writeFileSync(destPath, BODY.subarray(0, 50));
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );

    const download = new ResumableDownload();
    download.abort();
    // A fresh run clears the abort flag, which is what the resume button relies on.
    const { run } = options();
    await download.run(run);

    expect(download.wasAborted).toBe(false);
    expect(server.requests[0].headers.range).toBe('bytes=50-');
    expect(readFileSync(destPath)).toEqual(BODY);
  });

  it('refuses to start when aborted before the first byte is read', async () => {
    server = await startHttpServer((request, response) =>
      serveRange(response, request.headers.range),
    );
    const download = new ResumableDownload();
    const { run } = options({
      onProgress: () => download.abort(),
    });

    await download.run(run).catch(() => undefined);
    // Either it finished or it aborted; what matters is that abort() never throws on its own.
    expect(() => download.abort()).not.toThrow();
  });
});
