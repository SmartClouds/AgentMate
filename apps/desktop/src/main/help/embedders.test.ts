import { HELP_EMBEDDING_MODEL_OPTIONS, HELP_EMBEDDING_MODELS } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedder, listEmbeddingModels } from './embedders';

const fetchMock = vi.fn();

function reply(json: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as Response;
}

function sent(call = 0): {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return {
    url,
    body: JSON.parse(init.body as string),
    headers: init.headers as Record<string, string>,
  };
}

const settings = {
  openaiApiKey: 'sk-test',
  geminiApiKey: 'gm-test',
  ollamaBaseUrl: 'http://ollama:11434/',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEmbedder', () => {
  it('returns null when the provider has no API key', () => {
    expect(createEmbedder('openai', { ...settings, openaiApiKey: '  ' })).toBeNull();
    expect(createEmbedder('gemini', { ...settings, geminiApiKey: null })).toBeNull();
  });

  it('names each embedder after its provider and model', () => {
    expect(createEmbedder('openai', settings)?.id).toBe(
      `openai:${HELP_EMBEDDING_MODELS.openai.id}`,
    );
    expect(createEmbedder('ollama', settings)?.id).toBe(
      `ollama:${HELP_EMBEDDING_MODELS.ollama.id}`,
    );
  });
});

describe('createEmbedder with a picked model', () => {
  const picked = {
    openai: 'text-embedding-3-large',
    gemini: 'gemini-embedding-2',
    ollama: 'bge-m3',
  };
  const withPick = { ...settings, helpEmbeddingModels: picked };

  it('puts the picked model in each embedder id', () => {
    expect(createEmbedder('openai', withPick)?.id).toBe('openai:text-embedding-3-large');
    expect(createEmbedder('gemini', withPick)?.id).toBe('gemini:gemini-embedding-2');
    expect(createEmbedder('ollama', withPick)?.id).toBe('ollama:bge-m3');
  });

  it('sends the picked OpenAI model in the request body', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ index: 0, embedding: [1, 0] }] }));
    await createEmbedder('openai', withPick)!.embed(['a'], 'document');
    expect(sent().body).toEqual({ model: 'text-embedding-3-large', input: ['a'] });
  });

  it('sends the picked Gemini model in the URL and in each request', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [{ values: [1, 0] }] }));
    await createEmbedder('gemini', withPick)!.embed(['a'], 'document');
    const { url, body } = sent();
    expect(url).toContain('/models/gemini-embedding-2:batchEmbedContents');
    expect((body.requests as Array<{ model: string }>)[0]?.model).toBe('models/gemini-embedding-2');
  });

  it('sends the picked Ollama model in the request body', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [[1, 0]] }));
    await createEmbedder('ollama', withPick)!.embed(['a'], 'document');
    expect(sent().body).toEqual({ model: 'bge-m3', input: ['a'] });
  });

  it('names the picked Ollama model in the pull hint', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'not found' }, 404));
    await expect(createEmbedder('ollama', withPick)!.embed(['a'], 'query')).rejects.toThrow(
      'ollama pull bge-m3',
    );
  });

  it('uses the default for a provider that was not picked, whatever the others have', () => {
    const onlyOpenAi = { ...settings, helpEmbeddingModels: { openai: 'text-embedding-3-large' } };
    expect(createEmbedder('gemini', onlyOpenAi)?.id).toBe(
      `gemini:${HELP_EMBEDDING_MODELS.gemini.id}`,
    );
    expect(createEmbedder('ollama', onlyOpenAi)?.id).toBe(
      `ollama:${HELP_EMBEDDING_MODELS.ollama.id}`,
    );
  });

  it('still needs the provider key, whatever model is picked', () => {
    expect(createEmbedder('openai', { ...withPick, openaiApiKey: null })).toBeNull();
  });
});

describe('OpenAI embeddings', () => {
  it('posts the texts in one batch and returns vectors in input order', async () => {
    fetchMock.mockResolvedValue(
      reply({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const vectors = await createEmbedder('openai', settings)!.embed(['a', 'b'], 'document');
    expect(vectors.map((v) => [...v])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    const { url, body, headers } = sent();
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(body).toEqual({ model: HELP_EMBEDDING_MODELS.openai.id, input: ['a', 'b'] });
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('splits large inputs into batches of 100', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string) as { input: string[] };
      return reply({
        data: input.map((text, index) => ({ index, embedding: [1, Number(text.slice(1))] })),
      });
    });
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const vectors = await createEmbedder('openai', settings)!.embed(texts, 'document');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(150);
    // Unit length, but the direction still says which text it came from.
    expect(vectors[120]![1]! / vectors[120]![0]!).toBeCloseTo(120);
  });

  it('surfaces the provider error message', async () => {
    fetchMock.mockResolvedValue(reply({ error: { message: 'Incorrect API key' } }, 401));
    await expect(createEmbedder('openai', settings)!.embed(['a'], 'query')).rejects.toThrow(
      'Incorrect API key',
    );
  });
});

describe('Gemini embeddings', () => {
  it('uses batchEmbedContents with a task type per use', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [{ values: [0.5, 0.5] }] }));
    const embedder = createEmbedder('gemini', settings)!;
    await embedder.embed(['what is the vault'], 'query');
    const { url, body, headers } = sent();
    const model = HELP_EMBEDDING_MODELS.gemini.id;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    );
    expect(headers['x-goog-api-key']).toBe('gm-test');
    expect(body).toEqual({
      requests: [
        {
          model: `models/${model}`,
          content: { parts: [{ text: 'what is the vault' }] },
          taskType: 'RETRIEVAL_QUERY',
          outputDimensionality: HELP_EMBEDDING_MODELS.gemini.dimensions,
        },
      ],
    });

    await embedder.embed(['doc'], 'document');
    expect((sent(1).body.requests as Array<{ taskType: string }>)[0]?.taskType).toBe(
      'RETRIEVAL_DOCUMENT',
    );
  });

  it('normalizes vectors so cosine distance works on reduced sizes', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [{ values: [3, 4] }] }));
    const [vector] = await createEmbedder('gemini', settings)!.embed(['x'], 'query');
    expect([...vector!].map((n) => Number(n.toFixed(3)))).toEqual([0.6, 0.8]);
  });
});

describe('Ollama embeddings', () => {
  it('posts to /api/embed on the saved server', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [[1, 2, 3]] }));
    const [vector] = await createEmbedder('ollama', settings)!.embed(['a'], 'document');
    expect(vector).toHaveLength(3);
    const { url, body } = sent();
    expect(url).toBe('http://ollama:11434/api/embed');
    expect(body).toEqual({ model: HELP_EMBEDDING_MODELS.ollama.id, input: ['a'] });
  });

  it('falls back to the local server when none is saved', async () => {
    fetchMock.mockResolvedValue(reply({ embeddings: [[1]] }));
    await createEmbedder('ollama', { ...settings, ollamaBaseUrl: '' })!.embed(['a'], 'query');
    expect(sent().url).toBe('http://localhost:11434/api/embed');
  });

  it('tells you which model to pull when it is missing', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'model "nomic-embed-text" not found' }, 404));
    await expect(createEmbedder('ollama', settings)!.embed(['a'], 'query')).rejects.toThrow(
      `ollama pull ${HELP_EMBEDDING_MODELS.ollama.id}`,
    );
  });

  it('reports an unreachable server plainly', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(createEmbedder('ollama', settings)!.embed(['a'], 'query')).rejects.toThrow(
      /Could not reach Ollama/,
    );
  });
});

describe('listEmbeddingModels', () => {
  const ollamaSettings = { ollamaBaseUrl: 'http://ollama:11434/' };
  const suggested = HELP_EMBEDDING_MODEL_OPTIONS.ollama.map((o) => o.value);

  it('returns the catalog list for OpenAI without calling the network', async () => {
    const options = await listEmbeddingModels('openai', ollamaSettings);
    expect(options).toEqual(HELP_EMBEDDING_MODEL_OPTIONS.openai.map((o) => ({ ...o })));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the catalog list for Gemini without calling the network', async () => {
    const options = await listEmbeddingModels('gemini', ollamaSettings);
    expect(options.map((o) => o.value)).toEqual(
      HELP_EMBEDDING_MODEL_OPTIONS.gemini.map((o) => o.value),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands out copies, so a caller cannot change the catalog', async () => {
    const [first] = await listEmbeddingModels('openai', ollamaSettings);
    first!.label = 'changed';
    expect(HELP_EMBEDDING_MODEL_OPTIONS.openai[0]?.label).not.toBe('changed');
  });

  it('asks the saved Ollama server for its tags', async () => {
    fetchMock.mockResolvedValue(reply({ models: [] }));
    await listEmbeddingModels('ollama', ollamaSettings);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/tags');
  });

  it('asks the local server when no address is saved', async () => {
    fetchMock.mockResolvedValue(reply({ models: [] }));
    await listEmbeddingModels('ollama', { ollamaBaseUrl: '' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/tags');
  });

  it('lists installed embedding models by their capabilities, ahead of the suggestions', async () => {
    fetchMock.mockResolvedValue(
      reply({
        models: [
          { name: 'llama3.2:3b', capabilities: ['completion'] },
          // The name says nothing about embeddings, so only the capability gives it away.
          { name: 'my-vectors:v2', capabilities: ['embedding'] },
        ],
      }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options[0]).toEqual({ value: 'my-vectors:v2', label: 'my-vectors:v2', installed: true });
    expect(options.map((o) => o.value)).not.toContain('llama3.2:3b');
    expect(options.slice(1).map((o) => o.value)).toEqual(suggested);
  });

  it('trusts capabilities over the name when the server reports them', async () => {
    fetchMock.mockResolvedValue(
      reply({ models: [{ name: 'embed-lookalike:latest', capabilities: ['completion'] }] }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.map((o) => o.value)).toEqual(suggested);
  });

  it('guesses from the name on older servers that report no capabilities', async () => {
    fetchMock.mockResolvedValue(
      reply({
        models: [
          { name: 'nomic-embed-text:latest' },
          { name: 'bge-large:335m' },
          { name: 'multilingual-e5-small' },
          { name: 'all-minilm:22m' },
          { name: 'llama3.2:3b' },
          { name: 'qwen2.5-coder:7b' },
        ],
      }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.filter((o) => o.installed).map((o) => o.value)).toEqual([
      'nomic-embed-text',
      'bge-large:335m',
      'multilingual-e5-small',
      'all-minilm:22m',
    ]);
  });

  it('strips :latest from an installed name, so it matches what the user would type', async () => {
    fetchMock.mockResolvedValue(
      reply({ models: [{ name: 'bge-m3:latest', capabilities: ['embedding'] }] }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options[0]).toEqual({ value: 'bge-m3', label: 'bge-m3', installed: true });
  });

  it('keeps other tags as they are', async () => {
    fetchMock.mockResolvedValue(
      reply({ models: [{ name: 'bge-m3:567m', capabilities: ['embedding'] }] }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options[0]?.value).toBe('bge-m3:567m');
    // A different tag is a different download, so the plain suggestion still shows.
    expect(options.map((o) => o.value)).toContain('bge-m3');
  });

  it('does not repeat a suggestion that is already installed', async () => {
    fetchMock.mockResolvedValue(
      reply({ models: [{ name: 'nomic-embed-text:latest', capabilities: ['embedding'] }] }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    const values = options.map((o) => o.value);
    expect(values.filter((v) => v === 'nomic-embed-text')).toHaveLength(1);
    expect(options.find((o) => o.value === 'nomic-embed-text')?.installed).toBe(true);
    expect(values).toHaveLength(suggested.length);
  });

  it('marks only installed models, leaving suggestions to be pulled', async () => {
    fetchMock.mockResolvedValue(
      reply({ models: [{ name: 'bge-m3', capabilities: ['embedding'] }] }),
    );
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.filter((o) => o.installed).map((o) => o.value)).toEqual(['bge-m3']);
    const rest = options.filter((o) => !o.installed);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((o) => o.installed === undefined)).toBe(true);
  });

  it('offers the suggestions alone when the server cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.map((o) => o.value)).toEqual(suggested);
    expect(options.some((o) => o.installed)).toBe(false);
  });

  it('offers the suggestions alone when the server answers with an error', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'boom' }, 500));
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.map((o) => o.value)).toEqual(suggested);
  });

  it('copes with a reply that has no model list', async () => {
    fetchMock.mockResolvedValue(reply({}));
    const options = await listEmbeddingModels('ollama', ollamaSettings);
    expect(options.map((o) => o.value)).toEqual(suggested);
  });
});
