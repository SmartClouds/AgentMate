import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscribeAudioResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';

/**
 * The speech handler between the renderer's recording and the Whisper utility process. The
 * process is faked: what matters here is what main asks it for, above all that it always names
 * a language. transformers.js does not detect one, so a missing language is read as English and
 * Persian speech comes back as made-up English.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const state = vi.hoisted(() => ({
  settings: { speechModel: 'base', speechLanguage: 'auto' } as Record<string, string>,
  locale: 'en-US',
  hosts: [] as unknown[],
  /** What the fake host answers with; null leaves the recording hanging. */
  answer: 'heard you' as string | null,
}));

interface Sent {
  type: string;
  jobId: string;
  language?: string;
  model?: { hubId: string; dtype?: string };
  cacheDir?: string;
}

class FakeHost extends EventEmitter {
  sent: Sent[] = [];
  killed = false;
  constructor() {
    super();
    setImmediate(() => this.emit('message', { type: 'ready' }));
  }
  postMessage(message: Sent): void {
    this.sent.push(message);
    if (message.type === 'transcribe' && state.answer !== null) {
      const text = state.answer;
      setImmediate(() =>
        this.emit('message', { type: 'done', jobId: message.jobId, ok: true, text }),
      );
    }
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getLocale: () => state.locale },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  utilityProcess: {
    fork: vi.fn(() => {
      const host = new FakeHost();
      state.hosts.push(host);
      return host;
    }),
  },
}));
vi.mock('../store', () => ({ store: { getSettings: async () => state.settings } }));
vi.mock('./send', () => ({ broadcastToWindows: vi.fn() }));

function handler(channel: string) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`${channel} is not registered`);
  return fn;
}

function transcribe(language: string, requestId?: string): Promise<TranscribeAudioResult> {
  return handler(IPC.speech.transcribe)(
    {},
    { samples: new Float32Array(16000), language, requestId },
  ) as Promise<TranscribeAudioResult>;
}

function lastSent(): Sent {
  const host = state.hosts.at(-1) as FakeHost;
  return host.sent.filter((m) => m.type === 'transcribe').at(-1)!;
}

let shutdownSpeech: () => void = () => undefined;

// The first import pulls in all of @agentmat/core, which can take longer than a hook is allowed
// on a busy machine. Paying for it once up front keeps the per-test re-imports quick.
beforeAll(async () => {
  await import('./speech');
}, 120_000);

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  state.hosts = [];
  state.answer = 'heard you';
  state.settings = { speechModel: 'base', speechLanguage: 'auto' };
  state.locale = 'en-US';
  const speech = await import('./speech');
  speech.registerSpeechHandlers();
  shutdownSpeech = speech.shutdownSpeech;
});

afterEach(() => {
  shutdownSpeech();
});

describe('speech.transcribe', () => {
  it('runs Whisper in its own process and returns what it heard', async () => {
    expect(await transcribe('fa')).toEqual({ ok: true, text: 'heard you' });
    expect(state.hosts).toHaveLength(1);
  });

  it('passes Persian through when that is what the user speaks', async () => {
    await transcribe('fa');
    expect(lastSent().language).toBe('fa');
  });

  it('never leaves the language out for an old "auto" setting', async () => {
    state.locale = 'fa-IR';
    await transcribe('auto');
    expect(lastSent().language).toBe('fa');
  });

  it('falls back to English for a language it does not know', async () => {
    state.locale = 'ja-JP';
    await transcribe('xx');
    expect(lastSent().language).toBe('en');
  });

  it('asks for the large model with its 4-bit weights', async () => {
    state.settings.speechModel = 'large-v3-turbo';
    await transcribe('fa');
    expect(lastSent().model).toEqual({
      hubId: 'onnx-community/whisper-large-v3-turbo',
      dtype: 'q4',
    });
  });

  it('asks for a small model at full precision, cached under userData', async () => {
    await transcribe('en');
    expect(lastSent().model).toEqual({ hubId: 'onnx-community/whisper-base' });
    expect(lastSent().cacheDir).toMatch(/user-data[\\/]whisper-models$/);
  });

  it('reports the model as loaded only once the host has used it', async () => {
    const state0 = await handler(IPC.speech.getModelState)({});
    expect(state0).toEqual({ ready: false, modelId: 'onnx-community/whisper-base' });

    await transcribe('en');

    expect(await handler(IPC.speech.getModelState)({})).toEqual({
      ready: true,
      modelId: 'onnx-community/whisper-base',
    });
  });
});

describe('speech.cancel', () => {
  it('stops a transcription that is taking too long, and answers the waiting recording', async () => {
    state.answer = null;
    const pending = transcribe('fa', 'rec-1');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lastSent().jobId).toBe('rec-1');

    await handler(IPC.speech.cancel)({}, 'rec-1');

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect((state.hosts[0] as FakeHost).killed).toBe(true);
  });

  it('ignores a cancel without a recording to name', async () => {
    expect(() => handler(IPC.speech.cancel)({}, undefined)).not.toThrow();
    expect(state.hosts).toHaveLength(0);
  });
});
