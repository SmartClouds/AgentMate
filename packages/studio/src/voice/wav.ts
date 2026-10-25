/**
 * WAV files: read the format and the samples from a RIFF header, and write 16-bit PCM back out.
 * Narration lengths come from the sample count, so a scene fits its voice to the sample.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the sample data. */
  dataOffset: number;
  dataLength: number;
  /** Sample frames (one sample per channel). */
  frames: number;
  seconds: number;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** Reads a WAV header, walking its chunks to the format and the data. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('That is not a WAV file.');
  }
  let at = 12;
  let format: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    let size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('The WAV file has its sound before its format.');
      // A stream written before its length was known says 0 or the maximum; take what is there.
      if (size === 0 || size === 0xffffffff || body + size > bytes.length)
        size = bytes.length - body;
      const frameBytes = (format.bitsPerSample / 8) * format.channels;
      const frames = Math.floor(size / frameBytes);
      return {
        ...format,
        dataOffset: body,
        dataLength: size,
        frames,
        seconds: frames / format.sampleRate,
      };
    }
    at = body + size + (size % 2);
  }
  throw new Error('The WAV file has no sound in it.');
}

/** A WAV file around 16-bit little-endian PCM. */
export function encodeWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) out[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
