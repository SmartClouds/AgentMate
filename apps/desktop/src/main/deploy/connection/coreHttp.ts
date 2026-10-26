import {
  Agent,
  type ClientRequest,
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  request,
} from 'node:http';
import type { Duplex, Readable, Writable } from 'node:stream';
import type { HealthResponse } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';
import type { CoreTransport } from './transport';

/**
 * REST calls to the server core. Everything else goes through the hub; REST is only for health,
 * sign-in and large uploads. Each request gets its own stream from the transport, so an SSH
 * channel never outlives the request it carried.
 */

/** The Host header a new core answers to (it takes the old name too); it never answers to anything else. */
export const CORE_HOST = RUNOVA_CORE.host;

/** What to send as Host through `transport`: the old name until the transport knows the core is new. */
export function coreHostFor(transport: CoreTransport): string {
  return transport.host?.() ?? LEGACY_CORE.host;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** How much of a refused download's body is read for the core's JSON reason. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Hands every HTTP connection to the transport instead of dialing TCP. */
class TransportAgent extends Agent {
  constructor(private readonly transport: CoreTransport) {
    super({ keepAlive: false });
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.transport.openStream().then(
      (stream) => callback?.(null, stream),
      (error: Error) => callback?.(error, undefined as unknown as Duplex),
    );
    return undefined;
  }
}

export interface CoreRequestOptions {
  token?: string;
  timeoutMs?: number;
}

/** What a long transfer (a file of any size, E27) adds to a request. */
export interface CoreTransferOptions {
  /** Cancels the request at once; it rejects with a CoreHttpAbortError. */
  signal?: AbortSignal;
  /**
   * Replaces the total deadline (`timeoutMs`): the request fails with a CoreHttpStallError only
   * once no bytes have moved either way for this long, so a big transfer on a slow link can take
   * as long as it needs.
   */
  stallTimeoutMs?: number;
}

/** A streamed request body: a stack's build context (E07), a file (E27). */
export interface CoreStreamOptions extends CoreRequestOptions, CoreTransferOptions {
  contentType: string;
  contentLength: number;
  headers?: Record<string, string>;
  /** Bytes handed to the transport so far. */
  onProgress?: (sentBytes: number) => void;
}

/** A streamed response body: a backup (E15), a file (E27). */
export interface CoreDownloadOptions extends CoreRequestOptions, CoreTransferOptions {
  /** Request headers to send as well, such as `range`. */
  headers?: Record<string, string>;
  /** The status and headers of an accepted answer, before any of its body is written. */
  onResponse?: (status: number, headers: IncomingHttpHeaders) => void;
  /** Bytes received so far. */
  onProgress?: (receivedBytes: number) => void;
}

/** A refusal from the core, with its status and (when it sent JSON) the body. */
export class CoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CoreHttpError';
  }
}

/** A request cancelled through its AbortSignal. */
export class CoreHttpAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHttpAbortError';
  }
}

/** A transfer with a stall timeout that went that long without a byte moving. */
export class CoreHttpStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHttpStallError';
  }
}

interface Deadline {
  /** Bytes moved: a stall timeout starts over. */
  touch(): void;
  stop(): void;
}

function seconds(ms: number): string {
  return `${ms / 1000} s`;
}

/**
 * The request's deadline and its cancel: a total deadline, or with `stallTimeoutMs` one that
 * starts over whenever `touch` is called. Either way the request is destroyed and `fail` hears
 * why. A deadline of its own rather than a socket timeout: an SSH channel never fires one, and
 * the tunnel opening is part of what may hang.
 */
function watch(
  outgoing: ClientRequest,
  fail: (error: Error) => void,
  words: { overdue: string; stalled: string; cancelled: string },
  options: CoreRequestOptions & CoreTransferOptions,
): Deadline {
  const stop = (error: Error) => {
    outgoing.destroy(error);
    // A request still waiting for its tunnel has no socket to report the error through.
    fail(error);
  };
  const stallMs = options.stallTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer =
      stallMs === undefined
        ? setTimeout(() => stop(new Error(words.overdue)), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        : setTimeout(
            () => stop(new CoreHttpStallError(`${words.stalled} for ${seconds(stallMs)}.`)),
            stallMs,
          );
  };
  arm();
  const onAbort = () => stop(new CoreHttpAbortError(words.cancelled));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    touch: () => {
      if (stallMs !== undefined) arm();
    },
    stop: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** The core's JSON reason for a refusal, or null when it sent none. */
function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status alone says what happened.
    return null;
  }
}

export class CoreHttpClient {
  private readonly agent: Agent;

  constructor(readonly transport: CoreTransport) {
    this.agent = new TransportAgent(transport);
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/v1/health', { timeoutMs: 15_000 });
  }

  get<T>(path: string, options: CoreRequestOptions = {}): Promise<T> {
    return this.send<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body: unknown, options: CoreRequestOptions = {}): Promise<T> {
    return this.send<T>('POST', path, body, options);
  }

  /** Streams the body as it reads it, so a large upload is never held in memory. */
  putStream<T>(path: string, body: Readable, options: CoreStreamOptions): Promise<T> {
    const headers: Record<string, string> = {
      ...options.headers,
      host: coreHostFor(this.transport),
      accept: 'application/json',
      'content-type': options.contentType,
      'content-length': String(options.contentLength),
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    return this.exchange<T>('PUT', path, headers, options, (outgoing, touch) => {
      let sent = 0;
      body.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        touch();
        options.onProgress?.(sent);
      });
      body.on('error', (error) => outgoing.destroy(error));
      body.pipe(outgoing);
    });
  }

  /**
   * Streams a GET's body into `destination` (a backup, E15; a file, E27), never holding it in
   * memory, and resolves with the number of bytes written once the destination has them all. A
   * refusal rejects with a CoreHttpError as the other calls do, its JSON body kept.
   */
  download(
    path: string,
    destination: Writable,
    options: CoreDownloadOptions = {},
  ): Promise<number> {
    const headers: Record<string, string> = {
      ...options.headers,
      host: coreHostFor(this.transport),
      accept: 'application/octet-stream',
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const cancelled = `The download of ${path} was cancelled.`;
    if (options.signal?.aborted) return Promise.reject(new CoreHttpAbortError(cancelled));
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, bytes = 0) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (error) reject(error);
        else resolve(bytes);
      };
      const outgoing = request(
        { agent: this.agent, host: coreHostFor(this.transport), path, method: 'GET', headers },
        (response) => {
          const status = response.statusCode ?? 0;
          deadline.touch();
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size <= MAX_ERROR_BODY_BYTES) chunks.push(chunk);
            });
            response.on('end', () =>
              finish(
                new CoreHttpError(
                  `The server core refused GET ${path} (${status}).`,
                  status,
                  parseJson(Buffer.concat(chunks).toString('utf8')),
                ),
              ),
            );
            response.on('error', (error) => finish(error));
            return;
          }
          options.onResponse?.(status, response.headers);
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            deadline.touch();
            options.onProgress?.(received);
          });
          response.on('error', (error) => finish(error));
          destination.on('error', (error) => {
            outgoing.destroy(error);
            finish(error);
          });
          destination.on('finish', () => finish(null, received));
          response.pipe(destination);
        },
      );
      const deadline = watch(
        outgoing,
        (error) => finish(error),
        {
          overdue: `The server core did not finish sending ${path} in time.`,
          stalled: `The server core stopped sending ${path}`,
          cancelled,
        },
        options,
      );
      outgoing.on('error', (error) => finish(error));
      outgoing.end();
    });
  }

  private send<T>(
    method: string,
    path: string,
    body: unknown,
    options: CoreRequestOptions,
  ): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = {
      host: coreHostFor(this.transport),
      accept: 'application/json',
    };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    return this.exchange<T>(method, path, headers, options, (outgoing) => outgoing.end(payload));
  }

  private exchange<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    options: CoreRequestOptions & CoreTransferOptions,
    write: (outgoing: ClientRequest, touch: () => void) => void,
  ): Promise<T> {
    const cancelled = `The ${method} ${path} request was cancelled.`;
    if (options.signal?.aborted) return Promise.reject(new CoreHttpAbortError(cancelled));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (error) reject(error);
        else resolve(value as T);
      };
      const outgoing = request(
        { agent: this.agent, host: coreHostFor(this.transport), path, method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          deadline.touch();
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            deadline.touch();
            if (size > MAX_RESPONSE_BYTES) {
              outgoing.destroy(
                new Error(`The server core's answer to ${method} ${path} is too large.`),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) {
              settle(
                new CoreHttpError(
                  `The server core refused ${method} ${path} (${status}).`,
                  status,
                  parseJson(text),
                ),
              );
              return;
            }
            try {
              settle(null, (text ? JSON.parse(text) : undefined) as T);
            } catch {
              settle(new Error(`The server core sent an unreadable answer to ${method} ${path}.`));
            }
          });
          response.on('error', (error) => settle(error));
        },
      );
      const deadline = watch(
        outgoing,
        (error) => settle(error),
        {
          overdue: `The server core did not answer ${method} ${path} in time.`,
          stalled: `The server core stopped answering ${method} ${path}`,
          cancelled,
        },
        options,
      );
      outgoing.on('close', () => deadline.stop());
      outgoing.on('error', (error) => settle(error));
      write(outgoing, deadline.touch);
    });
  }
}
