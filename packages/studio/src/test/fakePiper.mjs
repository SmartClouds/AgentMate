// A stand-in for `python -m piper`, run by Node: `node fakePiper.mjs -m piper -m <voice.onnx>
// -i <text file> -f <out.wav>`. It speaks a twentieth of a second a character at 22.05 kHz, like
// the fake online engines, and misbehaves on cue: text containing FAIL exits with an error, HANG
// never finishes, and a voice file that is not there fails the way Piper does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.lastIndexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const model = value('-m');
const text = readFileSync(value('-i'), 'utf8').trim();
if (process.env.FAKE_PIPER_LOG)
  writeFileSync(process.env.FAKE_PIPER_LOG, JSON.stringify({ model, text }));
if (!existsSync(model)) {
  process.stderr.write(`ValueError: Unable to find voice: ${model} (use piper.download_voices)\n`);
  process.exit(1);
}
if (text.includes('FAIL')) {
  process.stderr.write('RuntimeError: something broke inside onnxruntime\n');
  process.exit(1);
}
if (text.includes('HANG')) setInterval(() => undefined, 1000);
else {
  const rate = 22_050;
  const frames = Math.round([...text].length * 0.05 * rate);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 4000), i * 2);
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
  writeFileSync(value('-f'), Buffer.concat([header, pcm]));
}
