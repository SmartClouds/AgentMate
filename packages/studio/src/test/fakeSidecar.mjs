// A stand-in for the OmniVoice sidecar, run by Node, speaking the same JSON lines. FAKE_SIDECAR
// (in the environment) makes it misbehave: "fatal" fails to load, "slow" takes 400 ms to load.
// Text containing CRASH ends the process mid-job, HANG never answers, BAD answers with an error.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const cue = process.env.FAKE_SIDECAR ?? '';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function wav(path, seconds) {
  const rate = 24_000;
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
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
  writeFileSync(path, Buffer.concat([header, pcm]));
}

if (cue === 'fatal') {
  send({ type: 'fatal', error: 'OutOfMemoryError: CUDA out of memory' });
  process.exit(1);
}
process.stdout.write('loading the model\n');
setTimeout(
  () => send({ type: 'ready', device: 'cpu', sampleRate: 24000 }),
  cue === 'slow' ? 400 : 10,
);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.op === 'quit') process.exit(0);
  if (request.text.includes('CRASH')) process.exit(3);
  if (request.text.includes('HANG')) return;
  if (request.text.includes('BAD')) {
    send({ id: request.id, ok: false, error: 'ValueError: reference audio is too short' });
    return;
  }
  wav(request.out, [...request.text].length * 0.05);
  send({ id: request.id, ok: true, refAudio: request.ref_audio, refText: request.ref_text });
});
