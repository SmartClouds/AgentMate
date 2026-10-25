// A stand-in for ffmpeg and ffprobe, run by Node: `node fakeFfmpeg.mjs ffmpeg <args>`. It does
// not encode anything. A chunk records how many frames it was sent and a hash of each, and the
// finished "video" records the frames it was asked for, so tests can check what a render did
// without a real ffmpeg. FAKE_FFMPEG (JSON in the environment) makes it misbehave on cue.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [tool, ...args] = process.argv.slice(2);
const cue = JSON.parse(process.env.FAKE_FFMPEG || '{}');
const after = (flag) => args[args.indexOf(flag) + 1];
if (cue.log) appendFileSync(cue.log, `${JSON.stringify([tool, ...args])}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (tool === 'ffprobe') {
  const file = args.at(-1);
  const facts = JSON.parse(readFileSync(file, 'utf8'));
  if (facts.probe) {
    // A media file for import: its JSON says what ffprobe should report about it.
    process.stdout.write(JSON.stringify(facts.probe));
  } else if (args.includes('csv=p=0')) {
    process.stdout.write(`${cue.chunkFrames ?? facts.frames}\n`);
  } else {
    const streams = [
      {
        codec_type: 'video',
        codec_name: facts.codec,
        width: facts.width,
        height: facts.height,
        avg_frame_rate: `${facts.fps}/1`,
        nb_read_packets: String(cue.outputFrames ?? facts.frames),
      },
    ];
    if (!cue.noAudio) streams.push({ codec_type: 'audio', codec_name: facts.audio });
    process.stdout.write(JSON.stringify({ streams }));
  }
} else if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 9.0.2-fake Copyright (c) 2000-2026\nbuilt with nothing\n');
} else if (args.includes('-encoders')) {
  process.stdout.write(
    ' V..... = Video\n ------\n V....D libx264  x264\n V....D h264_nvenc  NVENC\n V....D ffv1  FFV1\n A....D aac  AAC\n',
  );
} else if (args.includes('-filters')) {
  process.stdout.write(' T.. = Timeline\n ------\n .S xfade  VV->V  Cross fade.\n');
} else if (args.includes('null') && args.includes('[aout]')) {
  // loudnorm's measuring pass prints its findings on stderr.
  process.stderr.write(
    cue.loudnorm ??
      [
        '[Parsed_loudnorm_0 @ 0x1]',
        '{',
        '"input_i" : "-35.75",',
        '"input_tp" : "-35.05",',
        '"input_lra" : "0.00",',
        '"input_thresh" : "-45.75",',
        '"target_offset" : "0.03"',
        '}',
        '',
      ].join('\n'),
  );
} else if (args.includes('null')) {
  // A test encode.
  if (cue.brokenEncoders?.includes(after('-c:v'))) fail('Cannot load nvcuda.dll');
} else if (args.includes('rawvideo')) {
  const [width, height] = after('-s').split('x').map(Number);
  const scale = args.includes('-vf') ? /scale=(\d+):(\d+)/.exec(after('-vf')) : null;
  const size = width * height * 4;
  const hashes = [];
  let pending = Buffer.alloc(0);
  let received = 0;
  process.stdin.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= size) {
      hashes.push(createHash('md5').update(pending.subarray(0, size)).digest('hex'));
      pending = pending.subarray(size);
      received += 1;
      if (cue.dieAfterFrames === received) fail('Conversion failed!');
    }
  });
  process.stdin.on('end', () => {
    if (cue.failChunk) fail('Error while encoding a chunk');
    writeFileSync(
      args.at(-1),
      JSON.stringify({
        kind: 'chunk',
        frames: hashes.length,
        width: scale ? Number(scale[1]) : width,
        height: scale ? Number(scale[2]) : height,
        fps: Number(after('-r')),
        codec: 'ffv1',
        hashes,
      }),
    );
  });
} else if (args.includes('concat') && !args.includes('pcm_s16le')) {
  if (cue.failAssembly) fail(cue.failAssembly);
  if (cue.failEncoder && after('-c:v') === cue.failEncoder)
    fail('InitializeEncoder failed: out of memory');
  const lists = args.flatMap((a, i) => (a === '-i' && args[i - 1] === '0' ? [args[i + 1]] : []));
  const chunks = lists.flatMap((list) =>
    readFileSync(list, 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        JSON.parse(readFileSync(/^file '(.*)'$/.exec(line)[1].replaceAll("'\\''", "'"), 'utf8')),
      ),
  );
  const frames = Number(after('-frames:v'));
  const step = Math.max(1, Math.floor(frames / 4));
  const report = (frame, end) =>
    new Promise((resolve) => {
      process.stdout.write(
        `frame=${frame}\nout_time_us=${frame * 1000}\nprogress=${end ? 'end' : 'continue'}\n`,
      );
      setTimeout(resolve, cue.slowAssembly ? 200 : 1);
    });
  (async () => {
    for (let f = 0; f < frames; f += step) await report(f, false);
    await report(frames, true);
    const out = args.at(-1);
    const webm = out.endsWith('.webm');
    writeFileSync(
      out,
      JSON.stringify({
        kind: 'video',
        frames,
        width: chunks[0].width,
        height: chunks[0].height,
        fps: Number(after('-r')),
        codec: after('-c:v'),
        audio: webm ? 'opus' : 'aac',
        hashes: chunks.flatMap((c) => c.hashes),
        graph: readFileSync(
          args[
            args.findIndex((x) => x === '-/filter_complex' || x === '-filter_complex_script') + 1
          ],
          'utf8',
        ),
      }),
    );
  })();
} else if (args.includes('pcm_s16le')) {
  // Narration: WAV pieces (a concat list) or one recording joined into one WAV. The pieces keep
  // their samples; the output says 48 kHz, so tests feed it 48 kHz pieces.
  if (cue.failJoin) fail('Error while joining narration');
  const inputs = args.includes('concat')
    ? readFileSync(after('-i'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => /^file '(.*)'$/.exec(line)[1].replaceAll("'\\''", "'"))
    : [after('-i')];
  const data = inputs.map((file) => {
    const bytes = readFileSync(file);
    let at = 12;
    while (at + 8 <= bytes.length) {
      const id = bytes.toString('latin1', at, at + 4);
      const size = bytes.readUInt32LE(at + 4);
      if (id === 'data') return bytes.subarray(at + 8, at + 8 + size);
      at += 8 + size + (size % 2);
    }
    fail(`${file} is not a WAV file`);
  });
  const pcm = Buffer.concat(data);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(args.at(-1), Buffer.concat([header, pcm]));
} else if (args.includes('s16le') && args.at(-1) === '-') {
  // Waveform samples: a second of a soft sound at 8 kHz, 16-bit mono.
  if (cue.failDerivative === 'peaks') fail('Invalid data found when processing input');
  const samples = new Int16Array(8000).map((_, i) => (i % 80 === 0 ? 16384 : 100));
  process.stdout.write(Buffer.from(samples.buffer));
} else if (args.includes('-i') && /\.(mp4|jpg)$/.test(args.at(-1))) {
  // A preview file: proxy, poster or thumbnail strip.
  const out = args.at(-1);
  if (cue.failDerivative && out.includes(cue.failDerivative)) fail(`Could not make ${out}`);
  writeFileSync(out, JSON.stringify({ kind: 'derivative', args }));
} else {
  fail(`fakeFfmpeg does not know ${args.join(' ')}`);
}
