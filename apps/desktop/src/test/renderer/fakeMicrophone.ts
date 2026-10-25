import { type Mock, vi } from 'vitest';

/**
 * A microphone for component tests. jsdom has no MediaRecorder or Web Audio, so these stand in
 * for both: a recording is one second of audio louder than the voice hook's silence floor, and
 * stopping it hands the recording over the way the browser does.
 */

export const fakeMicTrack: { stop: Mock<() => void> } = { stop: vi.fn() };
const stream = { getTracks: () => [fakeMicTrack] } as unknown as MediaStream;

class FakeMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType = 'audio/webm';
  constructor(readonly source: MediaStream) {}
  start(): void {
    // Nothing to start; stop() hands over the recording.
  }
  stop(): void {
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  async decodeAudioData(): Promise<{ duration: number }> {
    return { duration: 1 };
  }
  /** A level meter's analyser hears a steady, moderate voice. */
  createAnalyser() {
    return {
      fftSize: 1024,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1),
    };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

class FakeOfflineAudioContext {
  readonly destination = {};
  createBufferSource() {
    return { buffer: null, connect: () => undefined, start: () => undefined };
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(16_000).fill(0.2) };
  }
}

/** Call from beforeEach. Globals are left in place afterwards: Radix needs the jsdom ones intact. */
export function installFakeMicrophone(): void {
  fakeMicTrack.stop.mockClear();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
}
