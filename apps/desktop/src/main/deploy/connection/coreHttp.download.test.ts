import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreHttpClient, CoreHttpError } from './coreHttp';
import { devTcpTransport } from './transport';

/** A backup comes down as a stream (E15): written as it arrives, never held whole in memory. */

let server: Server | null = null;
const seen: IncomingMessage[] = [];

afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(status: number, chunks: Buffer[], delayMs = 0): Promise<CoreHttpClient> {
  const listening = createServer((request, response) => {
    seen.push(request);
    response.writeHead(status, { 'content-type': 'application/octet-stream' });
    let index = 0;
    const next = () => {
      if (index >= chunks.length) {
        response.end();
        return;
      }
      response.write(chunks[index++]);
      setTimeout(next, delayMs);
    };
    next();
  });
  server = listening;
  const port = await new Promise<number>((resolve) => {
    listening.listen(0, '127.0.0.1', () => resolve((listening.address() as AddressInfo).port));
  });
  return new CoreHttpClient(devTcpTransport(port));
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

describe('CoreHttpClient.download', () => {
  it('streams the body into the destination with a bearer token and reports progress', async () => {
    const client = await serve(200, [Buffer.from('AMBACKUP'), Buffer.alloc(70_000, 7)], 5);
    const { stream, received } = sink();
    const progress: number[] = [];

    const bytes = await client.download('/api/v1/backups/abc', stream, {
      token: 'tok',
      onProgress: (sent) => progress.push(sent),
    });

    expect(bytes).toBe(70_008);
    expect(Buffer.concat(received).subarray(0, 8).toString()).toBe('AMBACKUP');
    expect(progress.at(-1)).toBe(70_008);
    expect(seen[0].headers.authorization).toBe('Bearer tok');
    expect(seen[0].headers.host).toBe('runova-core');
  });

  it('rejects a refusal with its status and writes nothing', async () => {
    const client = await serve(404, [Buffer.from('{}')]);
    const { stream, received } = sink();

    const failure = await client.download('/api/v1/backups/gone', stream).catch((e) => e);

    expect(failure).toBeInstanceOf(CoreHttpError);
    expect((failure as CoreHttpError).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it('gives up at its deadline', async () => {
    const client = await serve(200, [Buffer.from('a'), Buffer.from('b')], 500);
    const { stream } = sink();

    await expect(client.download('/slow', stream, { timeoutMs: 100 })).rejects.toThrow(
      /did not finish sending/,
    );
  });
});
