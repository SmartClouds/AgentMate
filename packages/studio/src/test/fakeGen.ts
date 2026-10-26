import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * OpenAI's Images API and Gemini's Interactions and Files APIs on loopback, in their documented
 * shapes, for Studio's generated media (E38). A clip is a file that stays PROCESSING for a few
 * polls before it is ACTIVE; its download honours Range and can drop half way once. A prompt with
 * REFUSE in it is declined the way each provider declines.
 */

export const GEN_KEY = 'gen-test-key';

export interface FakeGenOptions {
  /** The bytes of a made picture and clip (the test's own stand-ins for PNG and MP4). */
  picture: Buffer;
  clip: Buffer;
  /** How many polls a clip stays PROCESSING. */
  processingPolls?: number;
}

export interface FakeGen {
  url: string;
  requests: { method: string; path: string; body: string; range: string | null }[];
  /** The next download sends half the file and drops the connection. */
  dropNextDownload(): void;
  /** A clip being prepared is ready at the next poll, however many polls were asked for. */
  finishClips(): void;
  close(): Promise<void>;
}

export async function startFakeGen(options: FakeGenOptions): Promise<FakeGen> {
  const requests: FakeGen['requests'] = [];
  let polls = 0;
  let drop = false;
  let finished = false;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const range = (req.headers.range as string | undefined) ?? null;
      requests.push({ method: req.method ?? 'GET', path, body, range });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const authorized =
        req.headers.authorization === `Bearer ${GEN_KEY}` ||
        req.headers['x-goog-api-key'] === GEN_KEY;
      if (!authorized) return json(401, { error: { message: 'Invalid API key.' } });
      const ask = (() => {
        try {
          return JSON.parse(body) as {
            prompt?: string;
            input?: string;
            response_format?: { type?: string };
          };
        } catch {
          return {};
        }
      })();

      if (path === '/v1/images/generations') {
        if (ask.prompt?.includes('REFUSE')) {
          return json(400, {
            error: {
              code: 'moderation_blocked',
              message: 'Your request was rejected by the safety system.',
            },
          });
        }
        return json(200, { data: [{ b64_json: options.picture.toString('base64') }] });
      }
      if (path === '/v1beta/interactions') {
        if (ask.input?.includes('REFUSE')) {
          return json(200, {
            id: 'int-refused',
            status: 'completed',
            steps: [
              {
                type: 'model_output',
                content: [{ type: 'text', text: 'I cannot make that.' }],
              },
            ],
          });
        }
        if (ask.response_format?.type === 'image') {
          return json(200, {
            id: 'int-image',
            status: 'completed',
            steps: [
              {
                type: 'model_output',
                content: [{ type: 'image', data: options.picture.toString('base64') }],
              },
            ],
          });
        }
        polls = 0;
        return json(200, {
          id: 'int-clip',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'video',
                  mime_type: 'video/mp4',
                  uri: 'https://generativelanguage.googleapis.com/v1beta/files/clip123',
                },
              ],
            },
          ],
        });
      }
      if (path === '/v1beta/files/clip123') {
        polls += 1;
        return json(200, {
          name: 'files/clip123',
          state: finished || polls > (options.processingPolls ?? 2) ? 'ACTIVE' : 'PROCESSING',
        });
      }
      if (path === '/v1beta/files/clip123:download') {
        const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
        const rest = options.clip.subarray(from);
        if (drop) {
          drop = false;
          res.writeHead(from > 0 ? 206 : 200, { 'Content-Length': String(rest.length) });
          res.write(rest.subarray(0, Math.floor(rest.length / 2)));
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.writeHead(from > 0 ? 206 : 200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(rest.length),
        });
        res.end(rest);
        return;
      }
      json(404, { error: { message: `Nothing at ${path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    dropNextDownload: () => {
      drop = true;
    },
    finishClips: () => {
      finished = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
