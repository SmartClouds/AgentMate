import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SpeechJobInput } from './speechHostProtocol';
import { createWhisperRunner, describeSpeechError, removeStaleDownloads } from './whisperRunner';

/**
 * Whisper inside the speech utility process. transformers.js is stubbed: what matters here is
 * what the runner asks it for (the language, the weights) and how it treats the loaded model.
 */

type FakeAsr = Mock<
  (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string }>
> & { dispose: Mock<() => Promise<void>> };

function fakeAsr(text = ' hello there '): FakeAsr {
  const asr = vi.fn(async (_audio: Float32Array, _options: Record<string, unknown>) => ({
    text,
  })) as FakeAsr;
  asr.dispose = vi.fn(async () => undefined);
  return asr;
}

const BASE = { hubId: 'onnx-community/whisper-base' };
const TURBO = { hubId: 'onnx-community/whisper-large-v3-turbo', dtype: 'q4' };

function job(overrides: Partial<SpeechJobInput> = {}): SpeechJobInput {
  return {
    samples: new Float32Array(16_000),
    language: 'en',
    model: BASE,
    cacheDir: '/user-data/whisper-models',
    ...overrides,
  };
}

let pipeline: Mock;
let env: Record<string, unknown>;
let loadTransformers: Mock;
const fetch = vi.fn();

function runner() {
  return createWhisperRunner({ loadTransformers, fetch });
}

beforeEach(() => {
  pipeline = vi.fn();
  env = {};
  loadTransformers = vi.fn(async () => ({ pipeline, env }));
});

describe('createWhisperRunner', () => {
  it('asks for the language it was given, for transcription', async () => {
    const asr = fakeAsr('سلام');
    pipeline.mockResolvedValue(asr);

    const text = await runner().transcribe(job({ language: 'fa' }), vi.fn());

    expect(text).toBe('سلام');
    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ language: 'fa', task: 'transcribe' }),
    );
  });

  it('trims what the model wrote', async () => {
    pipeline.mockResolvedValue(fakeAsr('  add a login page  '));
    expect(await runner().transcribe(job(), vi.fn())).toBe('add a login page');
  });

  it('caches models under the folder it is given and downloads through its own fetch', async () => {
    pipeline.mockResolvedValue(fakeAsr());

    await runner().transcribe(job(), vi.fn());

    expect(env).toMatchObject({
      cacheDir: '/user-data/whisper-models',
      allowLocalModels: false,
      allowRemoteModels: true,
      fetch,
    });
  });

  it('loads the large model with its 4-bit weights', async () => {
    pipeline.mockResolvedValue(fakeAsr());

    await runner().transcribe(job({ model: TURBO }), vi.fn());

    expect(pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-large-v3-turbo',
      expect.objectContaining({ dtype: 'q4' }),
    );
  });

  it('loads a small model at full precision', async () => {
    pipeline.mockResolvedValue(fakeAsr());

    await runner().transcribe(job(), vi.fn());

    expect(pipeline.mock.calls[0]?.[1]).toBe('onnx-community/whisper-base');
    expect(pipeline.mock.calls[0]?.[2]).not.toHaveProperty('dtype');
  });

  it('keeps one loaded model across recordings', async () => {
    pipeline.mockResolvedValue(fakeAsr());
    const whisper = runner();

    await whisper.transcribe(job(), vi.fn());
    await whisper.transcribe(job(), vi.fn());

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(loadTransformers).toHaveBeenCalledTimes(1);
  });

  it('lets go of the old model when another one is asked for', async () => {
    const base = fakeAsr();
    const large = fakeAsr();
    pipeline.mockResolvedValueOnce(base).mockResolvedValueOnce(large);
    const whisper = runner();

    await whisper.transcribe(job(), vi.fn());
    await whisper.transcribe(job({ model: TURBO }), vi.fn());

    expect(base.dispose).toHaveBeenCalledTimes(1);
    expect(large.dispose).not.toHaveBeenCalled();
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('tries the model again after it failed to load', async () => {
    pipeline
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))
      .mockResolvedValueOnce(fakeAsr('second try'));
    const whisper = runner();

    await expect(whisper.transcribe(job(), vi.fn())).rejects.toThrow('ERR_CONNECTION_CLOSED');
    expect(await whisper.transcribe(job(), vi.fn())).toBe('second try');
  });

  it('reports download progress to the recording that is waiting on it', async () => {
    pipeline.mockImplementation(async (_task, _id, options) => {
      options.progress_callback({ status: 'progress', file: 'onnx/encoder.onnx', progress: 41.6 });
      options.progress_callback({ status: 'done', file: 'onnx/encoder.onnx' });
      return fakeAsr();
    });
    const onProgress = vi.fn();

    await runner().transcribe(job(), onProgress);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ percent: 42, file: 'onnx/encoder.onnx' });
  });
});

describe('removeStaleDownloads', () => {
  it('clears half-downloaded files another process left, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-cache-'));
    try {
      const onnx = join(root, 'onnx-community', 'whisper-tiny', 'onnx');
      await mkdir(onnx, { recursive: true });
      const keep = [
        join(root, 'onnx-community', 'whisper-tiny', 'config.json'),
        join(onnx, 'encoder_model.onnx'),
        join(onnx, `decoder_model_merged.onnx.tmp.${process.pid}.abc123`),
      ];
      const stale = [
        join(onnx, 'decoder_model_merged.onnx.tmp.36452.1viqgqn'),
        join(onnx, 'encoder_model.onnx.tmp.36452.17k2awi'),
      ];
      for (const file of [...keep, ...stale]) await writeFile(file, 'x');

      await removeStaleDownloads(root, process.pid);

      for (const file of keep) await expect(stat(file)).resolves.toBeTruthy();
      for (const file of stale) await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is fine with a cache folder that does not exist yet', async () => {
    await expect(
      removeStaleDownloads(join(tmpdir(), 'no-such-whisper-cache'), process.pid),
    ).resolves.toBeUndefined();
  });
});

describe('describeSpeechError', () => {
  it('says what a bare network code was about', () => {
    const message = describeSpeechError(new Error('net::ERR_CONNECTION_CLOSED'));
    expect(message).toContain('Could not download the speech model');
    expect(message).toContain('net::ERR_CONNECTION_CLOSED');
  });

  it('leaves other errors as they are', () => {
    expect(describeSpeechError(new Error('Out of memory'))).toBe('Out of memory');
    expect(describeSpeechError(undefined)).toBe('Transcription failed.');
  });
});
