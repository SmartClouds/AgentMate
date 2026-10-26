import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The online voice engines on loopback for the Studio voice e2e (E36), in the test process. The
 * app is pointed here with AGENTMATE_STUDIO_TTS_URL. Each engine answers in its own shape: OpenAI
 * with a 24 kHz WAV, ElevenLabs with 48 kHz PCM and character timings, plus its voice list. Speech
 * lasts a twentieth of a second a character, so the spec can work out how long a scene should be.
 */

export const TTS_KEY = 'fake-tts-key';
export const SECONDS_PER_CHAR = 0.05;

export interface FakeTtsApis {
  url: string;
  /** Every request, as `METHOD path`, with the text it was asked to say. */
  requests: { path: string; text: string }[];
  /** Each speech answer waits this long first, so a test can stop the app in the middle. */
  setDelay: (ms: number) => void;
  stop: () => Promise<void>;
}

/** A quiet tone, so the voice can be heard in a render's mix. */
function tone(seconds: number, rate: number): Buffer {
  const frames = Math.round(seconds * rate);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 6000), i * 2);
  }
  return pcm;
}

function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function startFakeTtsApis(): Promise<FakeTtsApis> {
  const requests: FakeTtsApis['requests'] = [];
  let delay = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const key =
        request.headers.authorization?.replace(/^Bearer /, '') ?? request.headers['xi-api-key'];
      if (key !== TTS_KEY) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Invalid key' } }));
        return;
      }
      if (path === '/v1/voices/add' && request.method === 'POST') {
        const body = Buffer.concat(chunks).toString('latin1');
        requests.push({ path: `POST ${path}`, text: body.includes('RIFF') ? 'wav' : 'none' });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ voice_id: 'v-cloned', requires_verification: false }));
        return;
      }
      if (path.startsWith('/v1/voices/') && request.method === 'DELETE') {
        requests.push({ path: `DELETE ${path}`, text: '' });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (path === '/v1/voices') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ voices: [{ voice_id: 'v-rachel', name: 'Rachel' }] }));
        return;
      }
      let body: { input?: string; text?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Not JSON: answered as an empty text below.
      }
      const text = body.input ?? body.text ?? '';
      requests.push({ path: `${request.method} ${path}`, text });
      const seconds = [...text].length * SECONDS_PER_CHAR;
      if (path === '/v1/audio/speech') {
        setTimeout(() => {
          response.writeHead(200, { 'Content-Type': 'audio/wav' });
          response.end(wav(tone(seconds, 24_000), 24_000));
        }, delay);
        return;
      }
      if (path.startsWith('/v1/text-to-speech/')) {
        const characters = [...text];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            audio_base64: tone(seconds, 48_000).toString('base64'),
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, i) => i * SECONDS_PER_CHAR),
              character_end_times_seconds: characters.map((_, i) => (i + 1) * SECONDS_PER_CHAR),
            },
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setDelay: (ms) => {
      delay = ms;
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
