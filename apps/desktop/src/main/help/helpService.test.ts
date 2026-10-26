import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { parseArticle } from '../../shared/help/parse';
import { chunkArticles } from './chunker';
import type { Embedder } from './embedders';
import {
  buildHelpPrompt,
  citedSources,
  createHelpService,
  fitPassages,
  type HelpService,
  type HelpServiceDeps,
  passageBudget,
} from './helpService';

const articles = [
  parseArticle(
    'vault',
    `---
title: Vault
category: Connect
summary: Keep secrets encrypted.
keywords: secrets
---
The Vault keeps your secrets.

## Unlock the vault

Type your master password and press Enter.
`,
  ),
  parseArticle(
    'workspace',
    `---
title: Workspace
category: Workspace
summary: Run agents side by side.
keywords: terminal
---
The Workspace runs terminals.

## Split a pane

Drag a terminal tab to the edge to split the pane.
`,
  ),
];
const chunks = chunkArticles(articles);

/** Maps text onto two axes: "vault-ness" and "workspace-ness", so similarity is predictable. */
function fakeEmbedder(id = 'fake:1'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const lower = t.toLowerCase();
        const a = /vault|secret|password/.test(lower) ? 1 : 0.05;
        const b = /workspace|pane|terminal/.test(lower) ? 1 : 0.05;
        const n = Math.hypot(a, b);
        return Float32Array.from([a / n, b / n]);
      });
    },
  };
}

const settings = { openaiApiKey: 'sk', geminiApiKey: null, ollamaBaseUrl: '' };

let dir: string;
let service: HelpService;
let runPrompt: Mock<HelpServiceDeps['runPrompt']>;
let embedder: ReturnType<typeof fakeEmbedder>;
let progress: Array<{ done: number; total: number }>;

function make(overrides: Partial<Parameters<typeof createHelpService>[0]> = {}): HelpService {
  return createHelpService({
    dbFile: join(dir, 'help.db'),
    chunks: () => chunks,
    getSettings: async () => settings,
    runPrompt,
    createEmbedder: () => embedder,
    onProgress: (p) => progress.push(p),
    indexOptions: { loadVectorExtension: () => false },
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runova-help-svc-'));
  runPrompt = vi.fn<HelpServiceDeps['runPrompt']>(
    async () => 'Open **Vault** and type your master password [1].',
  );
  embedder = fakeEmbedder();
  progress = [];
  service = make();
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('createHelpService', () => {
  it('answers from the retrieved passages and cites them', async () => {
    const result = await service.ask({
      provider: 'openai',
      model: 'gpt',
      question: 'How do I unlock my secrets?',
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('master password');
    expect(result.retrieval).toBe('hybrid');
    expect(result.sources[0]).toMatchObject({ n: 1, slug: 'vault', anchor: 'unlock-the-vault' });

    const [provider, model, prompt, history, , images, system] = runPrompt.mock.calls[0]!;
    expect([provider, model, history, images]).toEqual(['openai', 'gpt', [], []]);
    expect(prompt).toContain('[1] Vault > Unlock the vault');
    expect(prompt).toContain('Question: How do I unlock my secrets?');
    expect(system).toMatch(/Runova/);
    expect(system).toMatch(/same language/);
  });

  it('embeds the passages once and reports progress', async () => {
    await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    await service.ask({ provider: 'openai', model: 'gpt', question: 'pane' });
    const documentBatches = embedder.calls.filter(
      (c) => c.length > 1 || chunks.some((ch) => ch.text === c[0]),
    );
    expect(documentBatches.flat()).toHaveLength(chunks.length);
    expect(progress.at(-1)).toEqual({
      done: chunks.length,
      total: chunks.length,
      embedder: 'fake:1',
    });
  });

  it('reuses stored vectors after a restart', async () => {
    await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    service.close();
    embedder = fakeEmbedder();
    service = make();
    await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    // Only the question itself was embedded this time.
    expect(embedder.calls).toEqual([['vault']]);
  });

  it('rewrites a follow-up into a standalone search query before retrieving', async () => {
    runPrompt
      .mockResolvedValueOnce('"split a workspace pane"\nextra line')
      .mockResolvedValueOnce('Drag the tab to the edge [1].');
    const history = [
      { role: 'user' as const, content: 'How do I split a pane?' },
      { role: 'assistant' as const, content: 'Drag a tab.' },
    ];
    const result = await service.ask({
      provider: 'openai',
      model: 'gpt',
      question: 'and then?',
      history,
    });

    expect(runPrompt).toHaveBeenCalledTimes(2);
    const [, , rewritePrompt, rewriteHistory, , , rewriteSystem] = runPrompt.mock.calls[0]!;
    expect(rewritePrompt).toContain('User: How do I split a pane?');
    expect(rewritePrompt).toContain('Latest message: and then?');
    expect(rewriteHistory).toEqual([]);
    expect(rewriteSystem).toMatch(/search query/);

    const [, , answerPrompt, answerHistory] = runPrompt.mock.calls[1]!;
    expect(answerPrompt).toContain('[1] Workspace > Split a pane');
    expect(answerPrompt).toContain('Question: and then?');
    expect(answerHistory).toEqual(history);
    expect(embedder.calls.at(-1)).toEqual(['split a workspace pane']);
    expect(result.sources[0]).toMatchObject({ slug: 'workspace', anchor: 'split-a-pane' });
  });

  it('rewrites a question in another language into English search words', async () => {
    runPrompt.mockResolvedValueOnce('unlock the vault master password').mockResolvedValueOnce('ok');
    await service.ask({ provider: 'openai', model: 'gpt', question: 'چطور گاوصندوق را باز کنم؟' });
    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(runPrompt.mock.calls[1]![2]).toContain('[1] Vault > Unlock the vault');
  });

  it('asks once for a plain first question', async () => {
    await service.ask({ provider: 'openai', model: 'gpt', question: 'How do I unlock the vault?' });
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  it('retrieves with the original words when the rewrite fails', async () => {
    runPrompt.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce('ok');
    const result = await service.ask({
      provider: 'openai',
      model: 'gpt',
      question: 'master password?',
      history: [{ role: 'user', content: 'hello' }],
    });
    expect(result.ok).toBe(true);
    expect(runPrompt.mock.calls[1]![2]).toContain('Vault > Unlock the vault');
  });

  it('says how far indexing has got before the first batch finishes', async () => {
    await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    expect(progress[0]).toEqual({ done: 0, total: chunks.length, embedder: 'fake:1' });
  });

  it('falls back to keyword search when embedding fails, and says so', async () => {
    embedder.embed = async () => {
      throw new Error('Ollama has no nomic-embed-text model for search.');
    };
    const result = await service.ask({
      provider: 'ollama',
      model: 'llama',
      question: 'master password',
    });
    expect(result.ok).toBe(true);
    expect(result.retrieval).toBe('keyword');
    expect(result.notice).toMatch(/nomic-embed-text/);
    expect(runPrompt.mock.calls[0]![2]).toContain('Vault > Unlock the vault');
  });

  it('uses keyword search alone when the provider has no embedder', async () => {
    service.close();
    service = make({ createEmbedder: () => null });
    const result = await service.ask({ provider: 'gemini', model: 'g', question: 'split pane' });
    expect(result.retrieval).toBe('keyword');
    expect(result.notice).toBeUndefined();
  });

  it('still asks the model when nothing matches, so it can say the help has no answer', async () => {
    service.close();
    service = make({ createEmbedder: () => null });
    await service.ask({ provider: 'openai', model: 'gpt', question: 'zebra xylophone' });
    expect(runPrompt.mock.calls[0]![2]).toContain('No help passages matched');
  });

  it('reports a model failure without throwing', async () => {
    runPrompt.mockRejectedValue(new Error('Set an OpenAI API key in Settings first.'));
    const result = await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    expect(result).toMatchObject({ ok: false, error: 'Set an OpenAI API key in Settings first.' });
  });

  it('reports a cancelled request as cancelled', async () => {
    const controller = new AbortController();
    runPrompt.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const result = await service.ask(
      { provider: 'openai', model: 'gpt', question: 'vault' },
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it('reports a request that ran out of time as an error, not a cancel', async () => {
    const controller = new AbortController();
    runPrompt.mockImplementation(async () => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
      throw new DOMException('timed out', 'TimeoutError');
    });
    const result = await service.ask(
      { provider: 'openai', model: 'gpt', question: 'vault' },
      controller.signal,
    );
    expect(result.cancelled).toBeUndefined();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/No answer in time/);
  });

  it('refuses an empty question', async () => {
    const result = await service.ask({ provider: 'openai', model: 'gpt', question: '  ' });
    expect(result.ok).toBe(false);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('describes the index for the status line', async () => {
    expect(await service.status('openai')).toMatchObject({
      chunks: chunks.length,
      embedded: 0,
      backend: 'js',
      embedder: 'fake:1',
    });
    await service.ask({ provider: 'openai', model: 'gpt', question: 'vault' });
    expect((await service.status('openai')).embedded).toBe(chunks.length);
  });
});

describe('reindex', () => {
  it('embeds every passage and reports progress as it goes', async () => {
    const result = await service.reindex('openai');
    expect(result).toEqual({
      ok: true,
      embedded: chunks.length,
      total: chunks.length,
      removedModels: [],
    });
    expect(progress[0]).toEqual({ done: 0, total: chunks.length, embedder: 'fake:1' });
    expect(progress.at(-1)).toEqual({
      done: chunks.length,
      total: chunks.length,
      embedder: 'fake:1',
    });
    expect((await service.status('openai')).embedded).toBe(chunks.length);
  });

  it('does not embed again when everything already has a vector', async () => {
    await service.reindex('openai');
    const callsBefore = embedder.calls.length;
    progress = [];
    const result = await service.reindex('openai');
    expect(result).toMatchObject({ ok: true, embedded: chunks.length, total: chunks.length });
    expect(embedder.calls).toHaveLength(callsBefore);
    expect(progress).toEqual([]);
  });

  it('embeds only what is missing', async () => {
    await service.reindex('openai');
    service.close();
    // An article edited between runs: only the changed passages should go to the provider.
    const edited = chunks.map((c, i) =>
      i === 0 ? { ...c, text: `${c.text} More.`, hash: 'new' } : c,
    );
    embedder = fakeEmbedder();
    service = make({ chunks: () => edited });
    const result = await service.reindex('openai');
    expect(result.ok).toBe(true);
    expect(embedder.calls.flat()).toEqual([edited[0]!.text]);
  });

  it('with fresh, throws the current vectors away and embeds everything again', async () => {
    await service.reindex('openai');
    embedder.calls.length = 0;
    const result = await service.reindex('openai', { fresh: true });
    expect(result).toMatchObject({ ok: true, embedded: chunks.length, total: chunks.length });
    expect(embedder.calls.flat()).toEqual(chunks.map((c) => c.text));
  });

  it('without fresh, ignores an options object that does not ask for it', async () => {
    await service.reindex('openai');
    embedder.calls.length = 0;
    await service.reindex('openai', { fresh: false });
    expect(embedder.calls).toEqual([]);
  });

  it("drops the vectors of the provider's earlier models and says which", async () => {
    let current = fakeEmbedder('openai:old');
    service.close();
    service = make({ createEmbedder: () => current });
    await service.reindex('openai');
    expect((await service.status('openai')).embedded).toBe(chunks.length);

    current = fakeEmbedder('openai:new');
    const result = await service.reindex('openai');
    expect(result).toEqual({
      ok: true,
      embedded: chunks.length,
      total: chunks.length,
      removedModels: ['openai:old'],
    });
    // The old model is gone from the index, so switching back has to embed again.
    current = fakeEmbedder('openai:old');
    expect((await service.status('openai')).embedded).toBe(0);
  });

  it('keeps the vectors of another provider', async () => {
    let current = fakeEmbedder('gemini:g1');
    service.close();
    service = make({ createEmbedder: () => current });
    await service.reindex('gemini');

    current = fakeEmbedder('openai:o1');
    const result = await service.reindex('openai');
    expect(result.removedModels).toEqual([]);

    current = fakeEmbedder('gemini:g1');
    expect((await service.status('gemini')).embedded).toBe(chunks.length);
  });

  it('does not mistake a provider whose name starts the same for the same provider', async () => {
    // "ollama:" must not match an id like "ollama-cloud:..." from some other source.
    let current = fakeEmbedder('ollama-extra:x');
    service.close();
    service = make({ createEmbedder: () => current });
    await service.reindex('ollama');

    current = fakeEmbedder('ollama:nomic-embed-text');
    const result = await service.reindex('ollama');
    expect(result.removedModels).toEqual([]);
  });

  it('asks for the provider to be set up when it has no embedder', async () => {
    service.close();
    service = make({ createEmbedder: () => null });
    const result = await service.reindex('gemini');
    expect(result).toEqual({
      ok: false,
      embedded: 0,
      total: chunks.length,
      removedModels: [],
      error: expect.stringMatching(/Set up this provider in Settings/),
    });
  });

  it('leaves existing vectors alone when the provider has no embedder', async () => {
    let current: Embedder | null = fakeEmbedder('openai:old');
    service.close();
    service = make({ createEmbedder: () => current });
    await service.reindex('openai');
    // The key was removed in Settings: nothing is searched, but nothing should be thrown away.
    current = null;
    await service.reindex('openai');
    current = fakeEmbedder('openai:old');
    expect((await service.status('openai')).embedded).toBe(chunks.length);
  });

  it('reports the embedder error and how much is embedded', async () => {
    embedder.embed = async () => {
      throw new Error('Ollama has no bge-m3 model for search.');
    };
    const result = await service.reindex('ollama');
    expect(result).toMatchObject({
      ok: false,
      embedded: 0,
      total: chunks.length,
      error: 'Ollama has no bge-m3 model for search.',
    });
    expect(result.cancelled).toBeUndefined();
  });

  it('can be run again after a failure', async () => {
    const working = embedder.embed;
    embedder.embed = async () => {
      throw new Error('rate limited');
    };
    expect((await service.reindex('openai')).ok).toBe(false);
    embedder.embed = working;
    expect(await service.reindex('openai')).toMatchObject({ ok: true, embedded: chunks.length });
  });

  it('reports a stopped run as cancelled, not as an error', async () => {
    const controller = new AbortController();
    embedder.embed = async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const result = await service.reindex('openai', {}, controller.signal);
    expect(result).toMatchObject({ ok: false, cancelled: true, embedded: 0, total: chunks.length });
    expect(result.error).toMatch(/stopped/i);
  });

  it('takes over the work of a run that was stopped when a newer request replaced it', async () => {
    const first = new AbortController();
    const working = embedder.embed;
    embedder.embed = (_texts, _kind, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const stopped = service.reindex('openai', {}, first.signal);
    await vi.waitFor(() => expect(progress).toHaveLength(1));

    // The newer request joins the run that is still winding down, as the IPC layer does when it
    // aborts the old request and starts the new one in the same turn.
    embedder.embed = working;
    first.abort();
    const replacement = service.reindex('openai', { fresh: true }, new AbortController().signal);

    expect(await stopped).toMatchObject({ ok: false, cancelled: true });
    expect(await replacement).toMatchObject({ ok: true, embedded: chunks.length });
  });

  it('does not treat a timeout as the user stopping the run', async () => {
    const controller = new AbortController();
    embedder.embed = async () => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
      throw new DOMException('timed out', 'TimeoutError');
    };
    const result = await service.reindex('openai', {}, controller.signal);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBeUndefined();
  });

  it('still reports the dropped models when the run then fails', async () => {
    let current = fakeEmbedder('openai:old');
    service.close();
    service = make({ createEmbedder: () => current });
    await service.reindex('openai');

    current = fakeEmbedder('openai:new');
    current.embed = async () => {
      throw new Error('boom');
    };
    const result = await service.reindex('openai');
    expect(result).toMatchObject({ ok: false, removedModels: ['openai:old'] });
  });
});

describe('embeddingModels', () => {
  it('asks the model lister for the provider, with the current settings', async () => {
    const options = [{ value: 'bge-m3', label: 'bge-m3', installed: true }];
    const listEmbeddingModels = vi.fn(async () => options);
    service.close();
    service = make({ listEmbeddingModels });
    expect(await service.embeddingModels('ollama')).toBe(options);
    expect(listEmbeddingModels).toHaveBeenCalledWith('ollama', settings);
  });
});

describe('buildHelpPrompt', () => {
  it('numbers the passages and puts the question last', () => {
    const prompt = buildHelpPrompt('Q?', chunks.slice(0, 2));
    expect(prompt.startsWith('Help passages:')).toBe(true);
    expect(prompt).toContain('[1] Vault\n');
    expect(prompt).toContain('[2] Vault > Unlock the vault');
    expect(prompt.trim().endsWith('Question: Q?')).toBe(true);
  });
});

describe('fitPassages', () => {
  const sized = (id: string, length: number) => ({ ...chunks[0]!, id, text: 'x'.repeat(length) });

  it('keeps passages in rank order until the next would pass the budget', () => {
    const picked = fitPassages([sized('a', 400), sized('b', 400), sized('c', 400)], 900);
    expect(picked.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('always keeps the best passage, even when it alone is over budget', () => {
    expect(fitPassages([sized('a', 5000), sized('b', 10)], 900).map((p) => p.id)).toEqual(['a']);
  });
});

describe('passageBudget', () => {
  it('gives hosted models room for every passage', () => {
    expect(passageBudget('openai', null)).toBeGreaterThanOrEqual(9600);
    expect(passageBudget('gemini', null)).toBe(passageBudget('openai', null));
  });

  it("sizes Ollama's share to its context window, assuming 4096 tokens when unset", () => {
    expect(passageBudget('ollama', null)).toBeLessThan(7000);
    expect(passageBudget('ollama', 16384)).toBeGreaterThan(passageBudget('ollama', null));
    expect(passageBudget('ollama', 512)).toBeGreaterThanOrEqual(2000);
  });
});

describe('citedSources', () => {
  const used = chunks.slice(0, 3);

  it('keeps the passages the answer cites, in citation order', () => {
    expect(citedSources('See [3] and [1], also [3].', used).map((s) => s.n)).toEqual([3, 1]);
  });

  it('ignores numbers that are not passages', () => {
    expect(citedSources('Step [9] and [0].', used).map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it('falls back to every passage, one per heading, when nothing is cited', () => {
    const twice = [used[0]!, { ...used[0]!, id: 'other' }];
    expect(citedSources('No citations.', twice)).toHaveLength(1);
  });
});
