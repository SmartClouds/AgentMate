import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { TranscribeAudioResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';

/**
 * The speech handler between the renderer's recording and transformers.js. The model itself is
 * stubbed: what matters here is what the handler asks it for, above all that it always names a
 * language. transformers.js does not detect one, so a missing language is read as English and
 * Persian speech comes back as made-up English.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const state = vi.hoisted(() => ({
  settings: { speechModel: 'base', speechLanguage: 'auto' } as Record<string, string>,
  locale: 'en-US',
}));
const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getLocale: () => state.locale },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
}));
vi.mock('../store', () => ({ store: { getSettings: async () => state.settings } }));
vi.mock('./send', () => ({ broadcastToWindows: vi.fn() }));
vi.mock('@huggingface/transformers', () => transformers);

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

async function transcribe(language: string): Promise<TranscribeAudioResult> {
  const handler = handlers.get(IPC.speech.transcribe);
  if (!handler) throw new Error('speech handlers are not registered');
  return (await handler(
    {},
    { samples: new Float32Array(16000), language },
  )) as TranscribeAudioResult;
}

// The first import pulls in all of @agentmat/core, which can take longer than a hook is allowed
// on a busy machine. Paying for it once up front keeps the per-test re-imports quick.
beforeAll(async () => {
  await import('./speech');
}, 120_000);

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  transformers.pipeline.mockReset();
  state.settings = { speechModel: 'base', speechLanguage: 'auto' };
  state.locale = 'en-US';
  const { registerSpeechHandlers } = await import('./speech');
  registerSpeechHandlers();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('speech.transcribe language', () => {
  it('passes Persian through when that is what the user speaks', async () => {
    const asr = fakeAsr('سلام');
    transformers.pipeline.mockResolvedValue(asr);

    const result = await transcribe('fa');

    expect(result).toEqual({ ok: true, text: 'سلام' });
    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ language: 'fa', task: 'transcribe' }),
    );
  });

  it('never leaves the language out for an old "auto" setting', async () => {
    const asr = fakeAsr();
    transformers.pipeline.mockResolvedValue(asr);
    state.locale = 'fa-IR';

    await transcribe('auto');

    expect(asr.mock.calls[0]?.[1]).toMatchObject({ language: 'fa' });
  });

  it('falls back to English for a language it does not know', async () => {
    const asr = fakeAsr();
    transformers.pipeline.mockResolvedValue(asr);
    state.locale = 'ja-JP';

    await transcribe('xx');

    expect(asr.mock.calls[0]?.[1]).toMatchObject({ language: 'en' });
  });

  it('trims what the model wrote', async () => {
    transformers.pipeline.mockResolvedValue(fakeAsr('  add a login page  '));
    expect(await transcribe('en')).toEqual({ ok: true, text: 'add a login page' });
  });
});

describe('speech.transcribe model', () => {
  it('loads the large model with its 4-bit weights', async () => {
    state.settings.speechModel = 'large-v3-turbo';
    transformers.pipeline.mockResolvedValue(fakeAsr());

    await transcribe('fa');

    expect(transformers.pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-large-v3-turbo',
      expect.objectContaining({ dtype: 'q4' }),
    );
  });

  it('loads a small model at full precision', async () => {
    transformers.pipeline.mockResolvedValue(fakeAsr());

    await transcribe('en');

    const options = transformers.pipeline.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(transformers.pipeline.mock.calls[0]?.[1]).toBe('onnx-community/whisper-base');
    expect(options).not.toHaveProperty('dtype');
  });

  it('keeps one loaded model across recordings', async () => {
    transformers.pipeline.mockResolvedValue(fakeAsr());

    await transcribe('en');
    await transcribe('en');

    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
  });

  it('lets go of the old model when the setting switches to another', async () => {
    const base = fakeAsr();
    const large = fakeAsr();
    transformers.pipeline.mockResolvedValueOnce(base).mockResolvedValueOnce(large);

    await transcribe('en');
    state.settings.speechModel = 'large-v3-turbo';
    await transcribe('fa');

    expect(base.dispose).toHaveBeenCalledTimes(1);
    expect(large.dispose).not.toHaveBeenCalled();
    expect(transformers.pipeline).toHaveBeenCalledTimes(2);
  });

  it('reports a model that failed to load, and tries again next time', async () => {
    transformers.pipeline
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(fakeAsr('second try'));

    expect(await transcribe('en')).toEqual({ ok: false, text: '', error: 'fetch failed' });
    expect(await transcribe('en')).toEqual({ ok: true, text: 'second try' });
  });
});
