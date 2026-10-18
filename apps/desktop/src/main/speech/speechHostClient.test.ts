import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostProcess } from '../apiClient/hostClient';
import {
  createSpeechHost,
  defaultDeadlineMs,
  SPEECH_CANCELLED_MESSAGE,
  SPEECH_CRASH_MESSAGE,
  SPEECH_START_MESSAGE,
  SPEECH_TIMEOUT_MESSAGE,
} from './speechHostClient';
import type { SpeechJobInput } from './speechHostProtocol';

/**
 * Main's side of the Whisper utility process. The process is faked: these check that main never
 * waits on it for good. A host that crashes, hangs, or is told to stop fails only the recording
 * it was working on, and the next recording gets a fresh host.
 */

interface Sent {
  type: string;
  jobId: string;
  samples?: Float32Array;
}

class FakeHost extends EventEmitter implements HostProcess {
  sent: Sent[] = [];
  killed = false;
  postMessage(message: unknown): void {
    this.sent.push(message as Sent);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  reply(message: unknown): void {
    this.emit('message', message);
  }
  jobIds(type = 'transcribe'): string[] {
    return this.sent.filter((m) => m.type === type).map((m) => m.jobId);
  }
}

function input(seconds = 1, overrides: Partial<SpeechJobInput> = {}): SpeechJobInput {
  return {
    samples: new Float32Array(seconds * 16_000).fill(0.25),
    language: 'fa',
    model: { hubId: 'onnx-community/whisper-large-v3-turbo', dtype: 'q4' },
    cacheDir: '/user-data/whisper-models',
    ...overrides,
  };
}

let hosts: FakeHost[];
const spawn = vi.fn(() => {
  const host = new FakeHost();
  hosts.push(host);
  return host;
});
const onProgress = vi.fn();

function speechHost(options: Partial<Parameters<typeof createSpeechHost>[0]> = {}) {
  return createSpeechHost({ spawn, onProgress, ...options });
}

/** Starts a host and has it report ready, the way the real one does on boot. */
function ready(index = hosts.length - 1): FakeHost {
  const host = hosts[index]!;
  host.reply({ type: 'ready' });
  return host;
}

beforeEach(() => {
  hosts = [];
  spawn.mockClear();
  onProgress.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSpeechHost', () => {
  it('starts the host on the first recording and sends it once the host is ready', async () => {
    const speech = speechHost();
    expect(spawn).not.toHaveBeenCalled();

    const done = speech.transcribe('a', input());
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hosts[0]!.sent).toEqual([]);

    const host = ready();
    expect(host.jobIds()).toEqual(['a']);
    expect(host.sent[0]).toMatchObject({
      language: 'fa',
      model: { hubId: 'onnx-community/whisper-large-v3-turbo', dtype: 'q4' },
      cacheDir: '/user-data/whisper-models',
    });
    // The audio arrives whole.
    expect(host.sent[0]!.samples).toHaveLength(16_000);

    host.reply({ type: 'done', jobId: 'a', ok: true, text: 'سلام' });
    await expect(done).resolves.toEqual({ ok: true, text: 'سلام' });
  });

  it('shares one host across recordings and knows which model it holds', async () => {
    const speech = speechHost();
    const first = speech.transcribe('a', input());
    const host = ready();
    host.reply({ type: 'done', jobId: 'a', ok: true, text: 'one' });
    await first;

    expect(speech.isModelLoaded('onnx-community/whisper-large-v3-turbo')).toBe(true);
    expect(speech.isModelLoaded('onnx-community/whisper-base')).toBe(false);

    const second = speech.transcribe('b', input());
    expect(spawn).toHaveBeenCalledTimes(1);
    host.reply({ type: 'done', jobId: 'b', ok: true, text: 'two' });
    await expect(second).resolves.toEqual({ ok: true, text: 'two' });
  });

  it('passes a failure from the host through as it was written', async () => {
    const speech = speechHost();
    const done = speech.transcribe('a', input());
    ready().reply({ type: 'done', jobId: 'a', ok: false, error: 'Could not download it.' });
    await expect(done).resolves.toEqual({ ok: false, text: '', error: 'Could not download it.' });
  });

  it('forwards download progress', () => {
    const speech = speechHost();
    void speech.transcribe('a', input());
    ready().reply({ type: 'progress', jobId: 'a', percent: 42, file: 'onnx/encoder.onnx' });
    expect(onProgress).toHaveBeenCalledWith({ percent: 42, file: 'onnx/encoder.onnx' });
  });

  it('ignores messages it cannot make sense of', async () => {
    const speech = speechHost();
    const done = speech.transcribe('a', input());
    const host = ready();
    host.reply({ type: 'done', jobId: 'someone-else', ok: true, text: 'not yours' });
    host.reply('garbage');
    host.reply({ type: 'done', jobId: 'a', ok: true });
    host.reply({ type: 'done', jobId: 'a', ok: true, text: 'yours' });
    await expect(done).resolves.toEqual({ ok: true, text: 'yours' });
  });

  describe('a host that crashes', () => {
    it('fails the recording it was on and gives the next one a fresh host', async () => {
      const speech = speechHost();
      const first = speech.transcribe('a', input());
      const second = speech.transcribe('b', input());
      const host = ready();
      expect(host.jobIds()).toEqual(['a', 'b']);

      host.emit('exit', 1);

      await expect(first).resolves.toEqual({ ok: false, text: '', error: SPEECH_CRASH_MESSAGE });
      expect(spawn).toHaveBeenCalledTimes(2);
      const replacement = ready();
      expect(replacement.jobIds()).toEqual(['b']);
      replacement.reply({ type: 'done', jobId: 'b', ok: true, text: 'made it' });
      await expect(second).resolves.toEqual({ ok: true, text: 'made it' });
    });

    it('forgets the model the dead host held', async () => {
      const speech = speechHost();
      const first = speech.transcribe('a', input());
      const host = ready();
      host.reply({ type: 'done', jobId: 'a', ok: true, text: 'one' });
      await first;

      host.emit('exit', 1);

      expect(speech.isModelLoaded('onnx-community/whisper-large-v3-turbo')).toBe(false);
    });

    it('fails the recording when the host cannot be started at all', async () => {
      const speech = createSpeechHost({
        spawn: () => {
          throw new Error('no such file');
        },
        onProgress,
      });
      await expect(speech.transcribe('a', input())).resolves.toEqual({
        ok: false,
        text: '',
        error: SPEECH_START_MESSAGE,
      });
    });

    it('fails the recording when the host never says it is ready', async () => {
      const speech = speechHost({ readyTimeoutMs: 1000 });
      const done = speech.transcribe('a', input());

      await vi.advanceTimersByTimeAsync(1000);

      await expect(done).resolves.toEqual({ ok: false, text: '', error: SPEECH_START_MESSAGE });
      expect(hosts[0]!.killed).toBe(true);
    });
  });

  describe('a host that goes quiet', () => {
    it('is stopped once the recording has had far longer than it could need', async () => {
      const speech = speechHost({ deadlineMs: () => 5000 });
      const first = speech.transcribe('a', input());
      const second = speech.transcribe('b', input());
      const host = ready();

      await vi.advanceTimersByTimeAsync(4999);
      expect(host.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(first).resolves.toEqual({ ok: false, text: '', error: SPEECH_TIMEOUT_MESSAGE });
      expect(host.killed).toBe(true);
      // What was waiting behind it is not lost.
      const replacement = ready();
      expect(replacement.jobIds()).toEqual(['b']);
      replacement.reply({ type: 'done', jobId: 'b', ok: true, text: 'still here' });
      await expect(second).resolves.toEqual({ ok: true, text: 'still here' });
    });

    it('is given more time while it reports download progress', async () => {
      const speech = speechHost({ deadlineMs: () => 5000 });
      const done = speech.transcribe('a', input());
      const host = ready();

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(4000);
        host.reply({ type: 'progress', jobId: 'a', percent: i * 25, file: 'onnx/decoder.onnx' });
      }
      expect(host.killed).toBe(false);
      host.reply({ type: 'done', jobId: 'a', ok: true, text: 'slow but fine' });
      await expect(done).resolves.toEqual({ ok: true, text: 'slow but fine' });
    });

    it('starts the clock afresh for the next recording', async () => {
      const speech = speechHost({ deadlineMs: () => 5000 });
      const first = speech.transcribe('a', input());
      const second = speech.transcribe('b', input());
      const host = ready();

      await vi.advanceTimersByTimeAsync(4000);
      host.reply({ type: 'done', jobId: 'a', ok: true, text: 'one' });
      await first;
      await vi.advanceTimersByTimeAsync(4000);

      expect(host.killed).toBe(false);
      host.reply({ type: 'done', jobId: 'b', ok: true, text: 'two' });
      await expect(second).resolves.toEqual({ ok: true, text: 'two' });
    });

    it('allows a long recording more time than a short one', () => {
      expect(defaultDeadlineMs(input(60))).toBeGreaterThan(defaultDeadlineMs(input(5)));
      // A minute of speech on the large model takes about two minutes on a laptop.
      expect(defaultDeadlineMs(input(60))).toBeGreaterThanOrEqual(8 * 60_000);
    });
  });

  describe('cancel', () => {
    it('stops the host when it is busy with that recording, and keeps the others', async () => {
      const speech = speechHost();
      const first = speech.transcribe('a', input());
      const second = speech.transcribe('b', input());
      const host = ready();

      speech.cancel('a');

      await expect(first).resolves.toEqual({
        ok: false,
        text: '',
        error: SPEECH_CANCELLED_MESSAGE,
      });
      expect(host.killed).toBe(true);
      expect(ready().jobIds()).toEqual(['b']);
      hosts[1]!.reply({ type: 'done', jobId: 'b', ok: true, text: 'kept' });
      await expect(second).resolves.toEqual({ ok: true, text: 'kept' });
    });

    it('only takes a waiting recording out of the queue', async () => {
      const speech = speechHost();
      void speech.transcribe('a', input());
      const second = speech.transcribe('b', input());
      const host = ready();

      speech.cancel('b');

      await expect(second).resolves.toMatchObject({ ok: false, error: SPEECH_CANCELLED_MESSAGE });
      expect(host.killed).toBe(false);
      expect(host.jobIds('cancel')).toEqual(['b']);
    });

    it('never sends a recording cancelled before the host was ready', async () => {
      const speech = speechHost();
      const done = speech.transcribe('a', input());
      speech.cancel('a');
      await expect(done).resolves.toMatchObject({ ok: false });
      expect(ready().jobIds()).toEqual([]);
    });

    it('ignores a recording it does not know', () => {
      const speech = speechHost();
      expect(() => speech.cancel('nope')).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('lets a late answer from the stopped host fall on the floor', async () => {
      const speech = speechHost();
      const done = speech.transcribe('a', input());
      const host = ready();
      speech.cancel('a');
      host.reply({ type: 'done', jobId: 'a', ok: true, text: 'too late' });
      await expect(done).resolves.toMatchObject({ ok: false, error: SPEECH_CANCELLED_MESSAGE });
    });
  });

  it('puts the host away once nothing has used it for a while', async () => {
    const speech = speechHost({ idleTimeoutMs: 60_000 });
    const done = speech.transcribe('a', input());
    const host = ready();
    host.reply({ type: 'done', jobId: 'a', ok: true, text: 'one' });
    await done;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(host.killed).toBe(true);
    expect(speech.isModelLoaded('onnx-community/whisper-large-v3-turbo')).toBe(false);
  });

  it('settles everything on shutdown', async () => {
    const speech = speechHost();
    const done = speech.transcribe('a', input());
    ready();
    speech.shutdown();
    await expect(done).resolves.toMatchObject({ ok: false, error: SPEECH_CANCELLED_MESSAGE });
    expect(hosts[0]!.killed).toBe(true);
  });
});
