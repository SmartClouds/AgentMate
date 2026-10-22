import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Sentry's OpenTelemetry intake on loopback for the error reporting e2e (E29), in the test
 * process. The server core posts its logs here (OTLP over HTTP, protobuf) and this keeps every
 * request, so the spec can check where it went, what signed it and what it carried. The body is
 * kept as Latin-1 text: every byte survives and plain words can be searched for. It answers 200
 * unless the spec asks for something else with `answer`.
 *
 * `fakeSentryServer.ts` is the other direction (the app reading issues); nothing is shared.
 */

export interface IngestRequest {
  method: string;
  path: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

export interface FakeSentryIngest {
  port: number;
  requests: IngestRequest[];
  /** What the next requests get back; 200 by default. */
  answer: (status: number) => void;
  stop: () => Promise<void>;
}

export async function startFakeSentryIngest(): Promise<FakeSentryIngest> {
  const requests: IngestRequest[] = [];
  let status = 200;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('latin1'),
      });
      response.writeHead(status, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    answer: (next) => {
      status = next;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
