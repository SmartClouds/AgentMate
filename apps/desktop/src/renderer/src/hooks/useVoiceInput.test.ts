// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { NOTHING_HEARD_MESSAGE, useVoiceInput } from './useVoiceInput';

/**
 * Voice input holds the microphone, so the cases that matter are the ones where something is
 * still held after the user is done with it: a refused permission, a failed transcription, a
 * component that unmounts mid-recording. jsdom has neither MediaRecorder nor Web Audio, so both
 * are stood up here, recording what the hook did with them.
 */

/** The audio track the hook is expected to stop, whichever way recording ends. */
const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] } as unknown as MediaStream;

const getUserMedia = vi.fn(async (): Promise<MediaStream> => stream);

class FakeMediaRecorder {
  static last: FakeMediaRecorder | null = null;

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType = 'audio/webm';
  started = false;

  constructor(readonly source: MediaStream) {
    FakeMediaRecorder.last = this;
  }

  start(): void {
    this.started = true;
  }

  /** The real recorder flushes its last chunk and then fires onstop; the hook relies on both. */
  stop(): void {
    this.started = false;
    this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

/** How many samples the decode pipeline hands back, so a test can make it produce silence. */
let renderedSamples = 16_000;
/** How loud those samples are. Speech peaks well above the hook's silence floor. */
let renderedLevel = 0.2;

class FakeAudioContext {
  async decodeAudioData(): Promise<{ duration: number }> {
    return { duration: renderedSamples / 16_000 };
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
    return { getChannelData: () => new Float32Array(renderedSamples).fill(renderedLevel) };
  }
}

function install(): void {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
}

function refuse(name: string, message: string): void {
  getUserMedia.mockImplementationOnce(() => {
    const error = new Error(message);
    error.name = name;
    return Promise.reject(error);
  });
}

interface VoiceOptions {
  language?: string;
  onText?: (text: string) => void;
}

function renderVoice(options: VoiceOptions = {}, bridge: Record<string, unknown> = {}) {
  const onText = options.onText ?? vi.fn();
  const rendered = renderHookWithProviders(
    () => useVoiceInput({ language: options.language ?? 'en', onText }),
    { bridge },
  );
  return { ...rendered, onText };
}

beforeEach(() => {
  renderedSamples = 16_000;
  renderedLevel = 0.2;
  FakeMediaRecorder.last = null;
  track.stop.mockClear();
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => stream);
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useVoiceInput availability', () => {
  it('starts idle and reports that this machine can record', () => {
    const { result } = renderVoice();

    expect(result.current.status).toBe('idle');
    expect(result.current.supported).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.downloadPercent).toBeNull();
  });

  it('reports that it is unsupported where the browser has no MediaRecorder', () => {
    vi.stubGlobal('MediaRecorder', undefined);

    const { result } = renderVoice();

    expect(result.current.supported).toBe(false);
  });

  it('follows the first-run model download main reports', () => {
    const { result, bridge } = renderVoice();
    expect(bridge.$listenerCount('speech.onModelProgress')).toBe(1);

    act(() => bridge.$emit('speech.onModelProgress', { percent: 42 }));

    expect(result.current.downloadPercent).toBe(42);
  });

  // Every mic on the page hears the broadcast, so a download another one ran can leave 100% here.
  it('does not carry a finished download from another mic into its own recording', async () => {
    const { result, bridge } = renderVoice(
      {},
      { 'speech.transcribe': () => new Promise(() => undefined) },
    );
    act(() => bridge.$emit('speech.onModelProgress', { percent: 100 }));

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.status).toBe('transcribing'));
    expect(result.current.downloadPercent).toBeNull();
  });
});

describe('useVoiceInput recording', () => {
  it('asks for the microphone and starts recording', async () => {
    const { result } = renderVoice();

    await act(async () => result.current.toggle());

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.current.status).toBe('recording');
    expect(FakeMediaRecorder.last?.started).toBe(true);
  });

  it('hands the transcript to the caller and lets go of the microphone', async () => {
    const transcribe = vi.fn(async () => ({ ok: true, text: 'add a login form' }));
    const { result, onText, bridge } = renderVoice(
      { language: 'fa' },
      { 'speech.transcribe': transcribe },
    );

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(onText).toHaveBeenCalledWith('add a login form'));
    // Whatever language the user picked has to reach the model, not the hook's own default.
    expect(bridge.$fn('speech.transcribe')).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'fa' }),
    );
    const [[request]] = transcribe.mock.calls as unknown as [[{ samples: Float32Array }]];
    expect(request.samples).toHaveLength(16_000);
    expect(result.current.status).toBe('idle');
    expect(track.stop).toHaveBeenCalled();
  });

  it('goes through transcribing on the way back to idle', async () => {
    let release: (() => void) | null = null;
    const { result } = renderVoice(
      {},
      {
        'speech.transcribe': () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true, text: 'later' });
          }),
      },
    );

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.status).toBe('transcribing'));
    await act(async () => release?.());
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('says nothing to the caller when the recording held no audio', async () => {
    renderedSamples = 0;
    const { result, onText } = renderVoice();

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('ignores a toggle while it is still transcribing, so one press is one recording', async () => {
    const { result } = renderVoice({}, { 'speech.transcribe': () => new Promise(() => undefined) });

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('transcribing'));

    await act(async () => result.current.toggle());

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('useVoiceInput silence', () => {
  // Whisper invents words for silence, so these never reach the model.
  it('does not send a clip that is too short to hold a word', async () => {
    renderedSamples = 3_000;
    const transcribe = vi.fn();
    const { result, onText } = renderVoice({}, { 'speech.transcribe': transcribe });

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe(NOTHING_HEARD_MESSAGE));
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('does not send a recording that stayed quiet all the way through', async () => {
    renderedLevel = 0.002;
    const transcribe = vi.fn();
    const { result, onText } = renderVoice({}, { 'speech.transcribe': transcribe });

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe(NOTHING_HEARD_MESSAGE));
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('useVoiceInput cancel and timer', () => {
  it('counts the seconds while recording and resets when it stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderVoice(
        {},
        { 'speech.transcribe': () => new Promise(() => undefined) },
      );
      await act(async () => result.current.toggle());
      expect(result.current.elapsedSeconds).toBe(0);

      await act(async () => vi.advanceTimersByTime(3_100));
      expect(result.current.elapsedSeconds).toBe(3);

      await act(async () => result.current.toggle());
      await waitFor(() => expect(result.current.elapsedSeconds).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a recording away without transcribing it', async () => {
    const transcribe = vi.fn();
    const { result, onText } = renderVoice({}, { 'speech.transcribe': transcribe });
    await act(async () => result.current.toggle());

    act(() => result.current.cancel());

    expect(result.current.status).toBe('idle');
    expect(track.stop).toHaveBeenCalled();
    // Give a stray onstop the chance to start a transcription it should not.
    await act(async () => undefined);
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it('drops a transcription that finishes after it was cancelled', async () => {
    let release: (() => void) | null = null;
    const { result, onText } = renderVoice(
      {},
      {
        'speech.transcribe': () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true, text: 'too late' });
          }),
      },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('transcribing'));

    act(() => result.current.cancel());
    expect(result.current.status).toBe('idle');

    // A new recording starts before the old answer comes back; the old one must not touch it.
    await act(async () => result.current.toggle());
    await act(async () => release?.());

    expect(onText).not.toHaveBeenCalled();
    expect(result.current.status).toBe('recording');
  });
});

describe('useVoiceInput failures', () => {
  it('explains a blocked microphone instead of sitting on a spinner', async () => {
    refuse('NotAllowedError', 'Permission denied');
    const { result } = renderVoice();

    await act(async () => result.current.toggle());

    await waitFor(() =>
      expect(result.current.error).toBe(
        'Microphone access was blocked. Allow it to use voice input.',
      ),
    );
    expect(result.current.status).toBe('idle');
    expect(FakeMediaRecorder.last).toBeNull();
  });

  it('says so when the machine has no microphone at all', async () => {
    refuse('NotFoundError', 'Requested device not found');
    const { result } = renderVoice();

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe('No microphone was found.'));
  });

  it('falls back to whatever the browser said for any other failure', async () => {
    refuse('AbortError', 'The device is already in use');
    const { result } = renderVoice();

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe('The device is already in use'));
  });

  it('surfaces a transcription the model refused, and can be tried again', async () => {
    const { result, onText } = renderVoice(
      {},
      { 'speech.transcribe': async () => ({ ok: false, error: 'Model failed to load.' }) },
    );

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe('Model failed to load.'));
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('reports a decode that blew up rather than leaving the button stuck', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData(): Promise<never> {
          return Promise.reject(new Error('Unsupported audio format'));
        }
        async close(): Promise<void> {
          return undefined;
        }
      },
    );
    const { result } = renderVoice();

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe('Unsupported audio format'));
    expect(result.current.status).toBe('idle');
  });

  it('releases the microphone when the component goes away mid-recording', async () => {
    const { result, unmount } = renderVoice();
    await act(async () => result.current.toggle());
    track.stop.mockClear();

    unmount();

    expect(track.stop).toHaveBeenCalled();
  });
});
