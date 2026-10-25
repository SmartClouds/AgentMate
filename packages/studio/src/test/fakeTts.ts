import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeWav } from '../voice/wav.js';
import { ZH } from './chineseTags.js';

/**
 * A local stand-in for the four voice engines' HTTP APIs, on the same paths, so the adapters and
 * the narrator run against something real over the wire. Every engine answers with a soft tone
 * whose length follows the text (a twentieth of a second a character), checks its key, and can be
 * told to fail a number of times first.
 */

export const GOOD_KEY = 'good-key';

export interface FakeTtsServer {
  url: string;
  requests: { path: string; body: string; headers: IncomingMessage['headers'] }[];
  /** The next `count` speech requests fail with `status`. */
  failNext(count: number, status: number): void;
  close(): Promise<void>;
}

/** 16-bit mono PCM: a tone at a fifth of full scale. */
export function tonePcm(seconds: number, rate: number): Buffer {
  const frames = Math.round(seconds * rate);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 6500), i * 2);
  return pcm;
}

const lengthOf = (text: string) => Math.max(0.3, text.length * 0.05);

export async function startFakeTts(): Promise<FakeTtsServer> {
  const requests: FakeTtsServer['requests'] = [];
  let failures = 0;
  let failStatus = 500;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ path, body, headers: req.headers });
      const keyOk =
        req.headers.authorization === `Bearer ${GOOD_KEY}` ||
        req.headers['x-goog-api-key'] === GOOD_KEY ||
        req.headers['xi-api-key'] === GOOD_KEY ||
        req.headers['ocp-apim-subscription-key'] === GOOD_KEY;
      if (!keyOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
        return;
      }
      if (path === '/v1/voices') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            voices: [
              { voice_id: 'v-rachel', name: 'Rachel', labels: { gender: 'female' } },
              { voice_id: 'v-yun', name: 'Yun', labels: { language: ZH } },
            ],
          }),
        );
        return;
      }
      if (failures > 0) {
        failures -= 1;
        res.writeHead(failStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Fake failure ${failStatus}` } }));
        return;
      }
      if (path === '/v1/audio/speech') {
        const { input } = JSON.parse(body) as { input: string };
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(encodeWav(tonePcm(lengthOf(input), 24_000), 24_000)));
      } else if (path === '/v1beta/interactions') {
        const parsed = JSON.parse(body) as { input: { content: { text: string }[] }[] };
        const text = parsed.input[0]?.content[0]?.text ?? '';
        const wav = Buffer.from(encodeWav(tonePcm(lengthOf(text), 24_000), 24_000)).toString(
          'base64',
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            steps: [
              { type: 'thinking' },
              { type: 'model_output', content: [{ type: 'audio', data: wav }] },
            ],
          }),
        );
      } else if (/^\/v1\/text-to-speech\/[^/]+\/with-timestamps$/.test(path)) {
        const { text } = JSON.parse(body) as { text: string };
        const seconds = lengthOf(text);
        const characters = [...text];
        const step = seconds / Math.max(1, characters.length);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            audio_base64: tonePcm(seconds, 48_000).toString('base64'),
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, i) => i * step),
              character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
            },
          }),
        );
      } else if (path === '/cognitiveservices/v1') {
        const text = body.replace(/<[^>]+>/g, '');
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(encodeWav(tonePcm(lengthOf(text), 48_000), 48_000)));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    failNext(count, status) {
      failures = count;
      failStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
