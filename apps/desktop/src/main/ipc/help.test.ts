import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HelpAskResult,
  HelpEmbeddingModelOption,
  HelpIndexProgress,
  HelpIndexStatus,
  HelpReindexResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Help page's guide over IPC: questions answered from the real bundled articles, with the
 * index kept in the profile's data folder and requests the renderer can cancel.
 */

const userData = useTempUserData();

const runAiPrompt = vi.fn();
vi.mock('./ai', () => ({ runAiPrompt: (...args: unknown[]) => runAiPrompt(...args) }));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({ openaiApiKey: 'sk', geminiApiKey: null, ollamaBaseUrl: '' }),
  },
}));
// No network: the provider's embeddings are left out, so retrieval runs on keywords alone. Gemini
// is the exception, with an embedder the tests steer by hand, to drive the index rebuild.
const embedBatch = vi.fn();
vi.mock('../help/embedders', () => ({
  createEmbedder: (provider: string) =>
    provider === 'gemini'
      ? {
          id: 'gemini:test-model',
          embed: (texts: string[], kind: string, signal?: AbortSignal) =>
            embedBatch(texts, kind, signal),
        }
      : null,
  listEmbeddingModels: async (provider: string) => [
    { value: `${provider}-model`, label: `${provider} model`, installed: true },
  ],
}));

expectChannelsCovered(IPC.help, [IPC.help.onIndexProgress]);

let help: typeof import('./help');

beforeEach(async () => {
  runAiPrompt.mockReset();
  runAiPrompt.mockResolvedValue('Open the page from the sidebar [1].');
  help = await loadIpc(
    () => import('./help'),
    (m) => m.registerHelpHandlers(),
  );
});

afterEach(() => {
  help.closeHelpIndex();
});

describe('help:ask', () => {
  it('answers from the bundled articles with the guide instructions', async () => {
    const result = await invoke<HelpAskResult>(IPC.help.ask, {
      provider: 'openai',
      model: 'gpt-test',
      question: 'How do I add a server?',
    });
    expect(result).toMatchObject({ ok: true, retrieval: 'keyword' });
    expect(result.sources.length).toBeGreaterThan(0);
    const [provider, model, prompt, , , , system] = runAiPrompt.mock.calls[0]!;
    expect([provider, model]).toEqual(['openai', 'gpt-test']);
    expect(prompt).toMatch(/^Help passages:/);
    expect(prompt).toContain('[1] ');
    expect(system).toMatch(/Runova guide/);
    expect(existsSync(join(userData.dir, 'data', 'help-index.db'))).toBe(true);
  });

  it('can be cancelled with its request id', async () => {
    runAiPrompt.mockImplementation(
      (_p, _m, _q, _h, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const pending = invoke<HelpAskResult>(IPC.help.ask, {
      provider: 'openai',
      model: 'gpt-test',
      question: 'vault',
      requestId: 'r1',
    });
    await vi.waitFor(() => expect(runAiPrompt).toHaveBeenCalled());
    await expect(invoke<boolean>(IPC.help.cancel, 'r1')).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true });
    await expect(invoke<boolean>(IPC.help.cancel, 'r1')).resolves.toBe(false);
  });
});

describe('help:status', () => {
  it('reports the indexed passages', async () => {
    const status = await invoke<HelpIndexStatus>(IPC.help.status, 'openai');
    expect(status.chunks).toBeGreaterThan(0);
    expect(status).toMatchObject({ embedded: 0, embedder: null });
    expect(['sqlite-vec', 'js']).toContain(status.backend);
  });
});

/** An embedder reply: one tiny vector per text, so the index has something to store. */
function vectorsFor(texts: string[]): Float32Array[] {
  return texts.map(() => Float32Array.from([1, 0]));
}

/** Makes the next embedding call wait until the request is aborted, like a slow provider. */
function hangUntilAborted(): void {
  embedBatch.mockImplementationOnce(
    (_texts: string[], _kind: string, signal?: AbortSignal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

describe('help:reindex', () => {
  beforeEach(() => {
    embedBatch.mockReset();
    embedBatch.mockImplementation(async (texts: string[]) => vectorsFor(texts));
  });

  it('embeds every passage of the provider and says how many', async () => {
    const result = await invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    expect(result.ok).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result).toMatchObject({ embedded: result.total, removedModels: [] });
    expect((await invoke<HelpIndexStatus>(IPC.help.status, 'gemini')).embedded).toBe(result.total);
  });

  it('tells the renderer about progress while it runs', async () => {
    const win = new FakeBrowserWindow();
    const result = await invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    const progress = win.webContents
      .sentOn(IPC.help.onIndexProgress)
      .map(([p]) => p as HelpIndexProgress);
    expect(progress[0]).toMatchObject({ done: 0, embedder: 'gemini:test-model' });
    expect(progress.at(-1)).toMatchObject({ done: result.total, total: result.total });
  });

  it('starts over when asked for a fresh run', async () => {
    await invoke(IPC.help.reindex, 'gemini');
    embedBatch.mockClear();
    await invoke(IPC.help.reindex, 'gemini');
    expect(embedBatch).not.toHaveBeenCalled();

    const result = await invoke<HelpReindexResult>(IPC.help.reindex, 'gemini', { fresh: true });
    expect(embedBatch).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, embedded: result.total });
  });

  it('reports a provider that is not set up instead of throwing', async () => {
    const result = await invoke<HelpReindexResult>(IPC.help.reindex, 'openai');
    expect(result).toMatchObject({ ok: false, embedded: 0 });
    expect(result.error).toMatch(/Settings/);
  });

  it('reports a provider error as a failed run', async () => {
    embedBatch.mockRejectedValue(new Error('Gemini embeddings failed with status 500.'));
    const result = await invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    expect(result).toMatchObject({ ok: false, error: 'Gemini embeddings failed with status 500.' });
  });

  it('lets a second request replace the run in progress', async () => {
    hangUntilAborted();
    const first = invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));

    const second = invoke<HelpReindexResult>(IPC.help.reindex, 'gemini', { fresh: true });

    await expect(first).resolves.toMatchObject({ ok: false, cancelled: true });
    const result = await second;
    expect(result).toMatchObject({ ok: true, embedded: result.total });
    // The replaced run is not left behind to be cancelled later.
    await expect(invoke<boolean>(IPC.help.cancelReindex, 'gemini')).resolves.toBe(false);
  });
});

describe('help:cancelReindex', () => {
  beforeEach(() => {
    embedBatch.mockReset();
    embedBatch.mockImplementation(async (texts: string[]) => vectorsFor(texts));
  });

  it('returns false when nothing is running for that provider', async () => {
    await expect(invoke<boolean>(IPC.help.cancelReindex, 'gemini')).resolves.toBe(false);
  });

  it('stops the run in progress and returns true', async () => {
    hangUntilAborted();
    const pending = invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    await vi.waitFor(() => expect(embedBatch).toHaveBeenCalled());

    await expect(invoke<boolean>(IPC.help.cancelReindex, 'gemini')).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true, embedded: 0 });
    await expect(invoke<boolean>(IPC.help.cancelReindex, 'gemini')).resolves.toBe(false);
  });

  it('only stops the provider it was asked about', async () => {
    hangUntilAborted();
    const pending = invoke<HelpReindexResult>(IPC.help.reindex, 'gemini');
    await vi.waitFor(() => expect(embedBatch).toHaveBeenCalled());

    await expect(invoke<boolean>(IPC.help.cancelReindex, 'ollama')).resolves.toBe(false);
    await invoke(IPC.help.cancelReindex, 'gemini');
    await pending;
  });

  it('forgets a run that finished by itself', async () => {
    await invoke(IPC.help.reindex, 'gemini');
    await expect(invoke<boolean>(IPC.help.cancelReindex, 'gemini')).resolves.toBe(false);
  });
});

describe('help:embeddingModels', () => {
  it('lists the models the guide can use for the provider', async () => {
    const options = await invoke<HelpEmbeddingModelOption[]>(IPC.help.embeddingModels, 'ollama');
    expect(options).toEqual([{ value: 'ollama-model', label: 'ollama model', installed: true }]);
  });
});
