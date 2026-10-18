import { net } from 'electron';
import { type HostToMain, parseMainMessage, type SpeechJobInput } from './speechHostProtocol';
import { createWhisperRunner, describeSpeechError } from './whisperRunner';

/**
 * Entry point of the utility process that runs Whisper (see speechHostClient.ts for why it is a
 * process of its own). Recordings are transcribed one at a time, in the order main sends them.
 */

const port = process.parentPort;

function post(message: HostToMain): void {
  port.postMessage(message);
}

const runner = createWhisperRunner({
  loadTransformers: () => import('@huggingface/transformers'),
  // Electron's net, not Node's fetch: it goes through the proxy main set with app.setProxy.
  fetch: (input, init) => net.fetch(String(input), init),
});

const cancelled = new Set<string>();
let queue: Promise<void> = Promise.resolve();

function enqueue(jobId: string, input: SpeechJobInput): void {
  queue = queue.then(async () => {
    if (cancelled.delete(jobId)) return;
    try {
      const text = await runner.transcribe(input, (progress) =>
        post({ type: 'progress', jobId, ...progress }),
      );
      post({ type: 'done', jobId, ok: true, text });
    } catch (error) {
      post({ type: 'done', jobId, ok: false, error: describeSpeechError(error) });
    }
  });
}

port.on('message', (event: { data: unknown }) => {
  const message = parseMainMessage(event.data);
  if (!message) return;
  if (message.type === 'cancel') {
    cancelled.add(message.jobId);
    return;
  }
  const { type: _type, jobId, ...input } = message;
  enqueue(jobId, input);
});

// Ready straight away: transformers.js is only imported for the first recording, so a slow
// import is covered by that recording's own deadline rather than a start-up timeout.
post({ type: 'ready' });
