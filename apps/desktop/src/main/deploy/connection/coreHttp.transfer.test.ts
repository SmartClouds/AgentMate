import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreHttpAbortError, CoreHttpClient, CoreHttpError, CoreHttpStallError } from './coreHttp';
import { devTcpTransport } from './transport';

/**
 * Big file transfers (E27) over the core's REST: request headers such as Range, the response's
 * status and headers before its body, a cancel through an AbortSignal, and a stall timeout that
 * replaces the total deadline, so a long transfer only fails when bytes stop moving.
 */

let server: Server | null = null;
const seen: IncomingMessage[] = [];

afterEach(async () => {
  seen.length = 0;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<CoreHttpClient> {
  const listening = createServer((request, response) => {
    seen.push(request);
    handler(request, response);
  });
  server = listening;
  const port = await new Promise<number>((resolve) => {
    listening.listen(0, '127.0.0.1', () => resolve((listening.address() as AddressInfo).port));
  });
  return new CoreHttpClient(devTcpTransport(port));
}

/** Sends `chunks` one every `delayMs`, then ends, or holds the response open when `hold`. */
function paced(chunks: Buffer[], delayMs: number, hold = false) {
  return (_request: IncomingMessage, response: ServerResponse) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(hold ? total + 1 : total),
    });
    let index = 0;
    const next = () => {
      if (response.destroyed) return;
      if (index >= chunks.length) {
        if (!hold) response.end();
        return;
      }
      response.write(chunks[index++]);
      setTimeout(next, delayMs);
    };
    next();
  };
}

function sink(): { stream: Writable; received: Buffer[] } {
  const received: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      received.push(chunk);
      done();
    },
  });
  return { stream, received };
}

describe('CoreHttpClient.download for file transfers', () => {
  it('sends extra headers and hands over the status and headers before the body', async () => {
    const client = await serve((_request, response) => {
      response.writeHead(206, {
        'content-length': '3',
        'x-runova-mtime-ms': '1700000000000',
      });
      response.end('abc');
    });
    const { stream, received } = sink();
    const order: string[] = [];

    const bytes = await client.download('/file', stream, {
      headers: { range: 'bytes=2-4' },
      onResponse: (status, headers) => {
        order.push(`response ${status} ${headers['x-runova-mtime-ms']}`);
      },
      onProgress: (got) => order.push(`progress ${got}`),
    });

    expect(bytes).toBe(3);
    expect(Buffer.concat(received).toString()).toBe('abc');
    expect(order).toEqual(['response 206 1700000000000', 'progress 3']);
    expect(seen[0].headers.range).toBe('bytes=2-4');
    expect(seen[0].headers.host).toBe('runova-core');
  });

  it('keeps the JSON body of a refusal', async () => {
    const client = await serve((_request, response) => {
      response.writeHead(410, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'sessionGone', message: 'Open it again.' }));
    });

    const failure = await client.download('/gone', sink().stream).catch((error) => error);

    expect(failure).toBeInstanceOf(CoreHttpError);
    expect(failure).toMatchObject({
      status: 410,
      body: { code: 'sessionGone', message: 'Open it again.' },
    });
  });

  it('runs past any deadline while bytes keep coming, and gives up once they stop', async () => {
    const chunks = Array.from({ length: 6 }, () => Buffer.alloc(1000, 1));
    const steady = await serve(paced(chunks, 60));

    const bytes = await steady.download('/slow', sink().stream, {
      timeoutMs: 100,
      stallTimeoutMs: 250,
    });
    expect(bytes).toBe(6000);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const stalled = await serve(paced([Buffer.alloc(10)], 10, true));
    const failure = await stalled
      .download('/stuck', sink().stream, { stallTimeoutMs: 150 })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(CoreHttpStallError);
    expect((failure as Error).message).toMatch(/stopped sending \/stuck for 0\.15 s/);
  });

  it('stops at once when its signal aborts', async () => {
    const client = await serve(paced([Buffer.alloc(10), Buffer.alloc(10)], 5_000));
    const controller = new AbortController();

    const download = client.download('/big', sink().stream, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(download).rejects.toBeInstanceOf(CoreHttpAbortError);
  });

  it('never starts when the signal has already aborted', async () => {
    const client = await serve(paced([Buffer.alloc(10)], 5));

    await expect(
      client.download('/never', sink().stream, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(CoreHttpAbortError);
    expect(seen).toHaveLength(0);
  });
});

describe('CoreHttpClient.putStream for file transfers', () => {
  it('stops sending when its signal aborts, and the core sees the body cut off', async () => {
    let cutOff = false;
    const controller = new AbortController();
    const client = await serve((request) => {
      request.on('close', () => {
        if (!request.complete) cutOff = true;
      });
      // Cancelled once the core has the first bytes, so there is a body to cut off.
      request.once('data', () => controller.abort());
      request.resume();
    });
    const body = new Readable({
      read() {
        // The test pushes the bytes itself.
      },
    });
    body.push(Buffer.alloc(1000));

    const upload = client.putStream('/up', body, {
      contentType: 'application/octet-stream',
      contentLength: 5000,
      signal: controller.signal,
    });

    await expect(upload).rejects.toBeInstanceOf(CoreHttpAbortError);
    await expect.poll(() => cutOff).toBe(true);
  });

  it('fails with a stall once the core stops answering, however long the body took', async () => {
    const client = await serve((request) => request.resume());
    const body = Readable.from([Buffer.alloc(100), Buffer.alloc(100)]);

    const failure = await client
      .putStream('/held', body, {
        contentType: 'application/octet-stream',
        contentLength: 200,
        stallTimeoutMs: 150,
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(CoreHttpStallError);
  });

  it('answers the JSON the core sends back', async () => {
    const client = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ size: Buffer.concat(chunks).length }));
      });
    });

    const answer = await client.putStream<{ size: number }>(
      '/ok',
      Readable.from([Buffer.alloc(7)]),
      {
        contentType: 'application/octet-stream',
        contentLength: 7,
        stallTimeoutMs: 1_000,
        headers: { 'x-extra': 'yes' },
      },
    );

    expect(answer).toEqual({ size: 7 });
    expect(seen[0].headers['x-extra']).toBe('yes');
  });
});
