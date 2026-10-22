import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FakeCore } from '../../../../shared/deploy/testing/fakeCore';
import { type FakeFilesCode, FakeFilesError } from '../../../../shared/deploy/testing/fakeFiles';
import { type CoreTransport, devTcpTransport } from '../../connection/transport';

/**
 * The fake core's REST file transfers (E27) on a loopback port, reached through a dev TCP
 * transport, so `CoreHttpClient` talks to it exactly as it talks to a core:
 *
 * - `GET /api/v1/files/{sessionId}/content?path=` answers the bytes with `Content-Length` and
 *   `X-AgentMate-Mtime-Ms`, and a `Range: bytes=a-b` with 206 (416 past the end).
 * - `PUT` the same path, `&mode=<octal>` optional, takes the raw body (411 without a
 *   Content-Length) and only once every byte has arrived writes the file and answers its
 *   FileEntry. A body cut off on the way writes nothing.
 * - Admins only (403), and the core's refusals as `{ code, message }` with their status.
 *
 * Tests can slow the bytes down, stop them part way, or leave PUTs unanswered.
 */

export interface FakeFilesHttp {
  transport: CoreTransport;
  port: number;
  /** Every request, in order. */
  readonly requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>;
  /** GET bodies go out `chunkBytes` at a time, one every `delayMs`. Default all at once. */
  pace: { chunkBytes: number; delayMs: number } | null;
  /** GET bodies stop after this many bytes and the response is held open. */
  stallAfterBytes: number | null;
  /** PUT bodies are read to the end and never answered. */
  holdPuts: boolean;
  /** PUT bodies that never arrived whole. */
  readonly cutOffPuts: string[];
  close(): Promise<void>;
}

const STATUS: Record<FakeFilesCode, number> = {
  notFound: 404,
  permissionDenied: 403,
  exists: 409,
  notEmpty: 409,
  isDirectory: 400,
  notDirectory: 400,
  unsupported: 400,
  invalidInput: 400,
  sessionGone: 410,
  targetGone: 410,
  diskFull: 507,
  server: 500,
};

const ADMINS = new Set(['owner', 'admin']);
const CONTENT = /^\/api\/v1\/files\/([0-9a-f-]+)\/content$/;
const RANGE = /^bytes=(\d+)-(\d*)$/;

function refuse(response: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ code, message });
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

/** A FakeFilesError's code and sentence, without the `[files:code]` tag. */
function refuseWith(response: ServerResponse, error: unknown): void {
  if (!(error instanceof FakeFilesError)) throw error;
  refuse(response, STATUS[error.code], error.code, error.message.replace(/^\[files:\w+\]\s*/, ''));
}

export async function startFakeFilesHttp(core: FakeCore): Promise<FakeFilesHttp> {
  const sockets = new Set<Socket>();
  const fake: FakeFilesHttp = {
    transport: null as unknown as CoreTransport,
    port: 0,
    requests: [],
    pace: null,
    stallAfterBytes: null,
    holdPuts: false,
    cutOffPuts: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const send = (response: ServerResponse, bytes: Buffer): void => {
    const limit = fake.stallAfterBytes;
    const sent = limit === null ? bytes : bytes.subarray(0, limit);
    const step = fake.pace?.chunkBytes ?? (sent.length || 1);
    const delay = fake.pace?.delayMs ?? 0;
    let offset = 0;
    const next = (): void => {
      if (response.destroyed) return;
      if (offset >= sent.length) {
        if (limit === null) response.end();
        return;
      }
      response.write(sent.subarray(offset, offset + step));
      offset += step;
      if (delay > 0) setTimeout(next, delay);
      else setImmediate(next);
    };
    next();
  };

  const get = (response: ServerResponse, sessionId: string, path: string, range?: string) => {
    let file: { bytes: Uint8Array; mtimeMs: number };
    try {
      file = core.files.read(sessionId, path);
    } catch (error) {
      refuseWith(response, error);
      return;
    }
    const all = Buffer.from(file.bytes);
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-agentmate-mtime-ms': String(file.mtimeMs),
    };
    const wanted = range ? RANGE.exec(range) : null;
    if (range && !wanted) {
      refuse(response, 400, 'invalidInput', 'That range cannot be read.');
      return;
    }
    if (wanted) {
      const start = Number(wanted[1]);
      if (start >= all.length) {
        response.writeHead(416, { 'content-range': `bytes */${all.length}` });
        response.end();
        return;
      }
      const end = Math.min(wanted[2] ? Number(wanted[2]) : all.length - 1, all.length - 1);
      const part = all.subarray(start, end + 1);
      response.writeHead(206, {
        ...headers,
        'content-length': String(part.length),
        'content-range': `bytes ${start}-${end}/${all.length}`,
      });
      send(response, part);
      return;
    }
    response.writeHead(200, { ...headers, 'content-length': String(all.length) });
    send(response, all);
  };

  const put = (
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
    path: string,
    mode: string | null,
  ) => {
    const declared = request.headers['content-length'];
    if (declared === undefined) {
      refuse(response, 411, 'invalidInput', 'The upload has no Content-Length.');
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('close', () => {
      if (!request.complete) fake.cutOffPuts.push(path);
    });
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== Number(declared)) {
        refuse(response, 400, 'invalidInput', 'The upload ended before its Content-Length.');
        return;
      }
      if (fake.holdPuts) return;
      try {
        const parsed = mode === null ? undefined : Number.parseInt(mode, 8);
        const entry = core.files.write(sessionId, path, new Uint8Array(bytes), parsed);
        const body = JSON.stringify(entry);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      } catch (error) {
        refuseWith(response, error);
      }
    });
  };

  const server: Server = createServer((request, response) => {
    fake.requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    const url = new URL(request.url ?? '/', 'http://agentmate-core');
    const route = CONTENT.exec(url.pathname);
    const path = url.searchParams.get('path');
    if (!route || path === null) {
      refuse(response, 404, 'notFound', 'There is nothing at that address.');
      request.resume();
      return;
    }
    const token = core.files.token;
    if (token !== null && request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end();
      request.resume();
      return;
    }
    if (!core.roles.some((role) => ADMINS.has(role))) {
      refuse(response, 403, 'permissionDenied', 'Only Admins can work with these files.');
      request.resume();
      return;
    }
    if (request.method === 'GET') {
      get(response, route[1], path, request.headers.range);
    } else if (request.method === 'PUT') {
      put(request, response, route[1], path, url.searchParams.get('mode'));
    } else {
      refuse(response, 405, 'invalidInput', 'Only GET and PUT are allowed here.');
      request.resume();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  fake.port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  fake.transport = devTcpTransport(fake.port);
  return fake;
}
