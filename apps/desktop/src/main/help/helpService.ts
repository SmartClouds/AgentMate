import type {
  AiProvider,
  AskAiHistoryMessage,
  HelpAskInput,
  HelpAskResult,
  HelpIndexProgress,
  HelpIndexStatus,
  HelpReindexResult,
  HelpSource,
} from '../../shared/apiTypes';
import type { HelpChunk } from './chunker';
import type { Embedder, EmbedderSettings, EmbeddingModelOption } from './embedders';
import {
  createEmbedder as defaultCreateEmbedder,
  listEmbeddingModels as defaultListEmbeddingModels,
} from './embedders';
import { reciprocalRankFusion } from './fusion';
import { HelpIndex, type HelpIndexOptions } from './helpIndex';

/**
 * The help chat: retrieval-augmented answers about Runova, drawn only from the Help articles.
 *
 * A question is looked up two ways (keywords through FTS5, meaning through the provider's
 * embeddings), the two rankings are fused, and the best passages go to the chat model with an
 * instruction to answer from them alone and cite them by number. Embedding the articles happens
 * on the first question per provider, in the background of that request, and is kept on disk.
 */

/** Candidates taken from each search before fusing. */
const CANDIDATES = 10;
/** At most this many passages go to the model, fewer when they would not fit its context. */
const PASSAGES = 6;
const EMBED_BATCH = 32;
/** What Ollama gives a model when the user has not set a context length. */
const OLLAMA_DEFAULT_CONTEXT_TOKENS = 4096;

export const HELP_REWRITE_PROMPT = `You turn the user's latest message into a short English search query for the Runova help articles.
Use the conversation to resolve words like "it" or "that". Translate to English if needed.
Reply with the query only: no quotes, no explanation, at most 12 words.`;

export const HELP_SYSTEM_PROMPT = `You are the Runova guide, the help assistant built into the Runova desktop app.
Answer questions about using Runova. Use only the numbered help passages in the user's message. Do not rely on outside knowledge about Runova, and never invent buttons, menus, settings or shortcuts.

How to answer:
- Start with the direct answer, then the steps. Use numbered steps for tasks and bold for UI labels, like **Settings** > **AI**.
- Say where things are in the app (which page, tab or button), the way the passages describe it.
- Cite the passages you used with their numbers in square brackets, like [2], right after the sentence they support.
- If the passages do not cover the question, say plainly that the help articles do not cover it, then point to the closest related topic if there is one. Do not guess.
- If the question is not about Runova, say briefly that you can only help with using Runova.
- Keep it short and practical. Reply in the same language the user writes in, but keep UI labels exactly as they appear in the passages.`;

export interface HelpServiceDeps {
  dbFile: string;
  chunks: () => HelpChunk[];
  getSettings: () => Promise<EmbedderSettings & { ollamaContextLength?: number | null }>;
  runPrompt: (
    provider: AiProvider,
    model: string,
    prompt: string,
    history: AskAiHistoryMessage[],
    signal: AbortSignal | undefined,
    images: string[],
    system: string,
  ) => Promise<string>;
  createEmbedder?: (provider: AiProvider, settings: EmbedderSettings) => Embedder | null;
  listEmbeddingModels?: (
    provider: AiProvider,
    settings: EmbedderSettings,
  ) => Promise<EmbeddingModelOption[]>;
  onProgress?: (progress: HelpIndexProgress) => void;
  indexOptions?: HelpIndexOptions;
}

export interface HelpService {
  ask(input: HelpAskInput, signal?: AbortSignal): Promise<HelpAskResult>;
  status(provider: AiProvider): Promise<HelpIndexStatus>;
  /**
   * Embeds every passage that has no vector yet from the provider's current model. With `fresh`
   * the model's vectors are thrown away first, so everything is embedded again. Vectors from the
   * provider's earlier models are dropped either way, since nothing searches them any more.
   */
  reindex(
    provider: AiProvider,
    options?: { fresh?: boolean },
    signal?: AbortSignal,
  ): Promise<HelpReindexResult>;
  /** The embedding models Settings can offer for the provider. */
  embeddingModels(provider: AiProvider): Promise<EmbeddingModelOption[]>;
  close(): void;
}

export function buildHelpPrompt(question: string, passages: HelpChunk[]): string {
  const body =
    passages.length > 0
      ? passages.map((p, i) => `[${i + 1}] ${p.text}`).join('\n\n---\n\n')
      : 'No help passages matched this question.';
  return `Help passages:\n\n${body}\n\nQuestion: ${question}\n`;
}

/**
 * Characters of passage text a provider's model can take with room left for the instructions,
 * the conversation and the answer. Hosted models have large windows; a local Ollama model gets
 * whatever context length the user set, and Ollama quietly drops the start of a prompt that does
 * not fit, which would cut off the instructions and the best passages first.
 */
export function passageBudget(
  provider: AiProvider,
  ollamaContextLength: number | null | undefined,
): number {
  if (provider !== 'ollama') return 16_000;
  const tokens =
    ollamaContextLength && ollamaContextLength > 0
      ? ollamaContextLength
      : OLLAMA_DEFAULT_CONTEXT_TOKENS;
  // About 4 characters a token, with a bit under half of the window spent on passages.
  return Math.min(24_000, Math.max(2_000, Math.round(tokens * 1.6)));
}

/** The best passages that fit in `maxChars`, in rank order. The top one always goes in. */
export function fitPassages(passages: HelpChunk[], maxChars: number): HelpChunk[] {
  const picked: HelpChunk[] = [];
  let used = 0;
  for (const passage of passages) {
    if (picked.length > 0 && used + passage.text.length > maxChars) break;
    picked.push(passage);
    used += passage.text.length;
  }
  return picked;
}

/** A follow-up or a question in another language needs rewriting before it can be searched. */
function needsRewrite(question: string, history: AskAiHistoryMessage[]): boolean {
  return history.length > 0 || /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(question);
}

function rewritePrompt(question: string, history: AskAiHistoryMessage[]): string {
  const recent = history
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
    .join('\n');
  return `${recent ? `Conversation:\n${recent}\n\n` : ''}Latest message: ${question}`;
}

/** The model's query, trimmed to its first line and stripped of quotes, or null if unusable. */
function cleanQuery(text: string): string | null {
  const line =
    text
      .trim()
      .split('\n')[0]
      ?.trim()
      .replace(/^["'`]+|["'`]+$/g, '') ?? '';
  return line ? line.slice(0, 200) : null;
}

function toSource(chunk: HelpChunk, n: number): HelpSource {
  return {
    n,
    slug: chunk.slug,
    anchor: chunk.anchor,
    articleTitle: chunk.articleTitle,
    heading: chunk.heading,
  };
}

/**
 * The passages an answer cites, in the order it first cites them. An answer that cites none
 * (small local models often forget) still lists what it was given, one entry per heading.
 */
export function citedSources(answer: string, passages: HelpChunk[]): HelpSource[] {
  const cited: number[] = [];
  for (const [, n] of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const index = Number(n);
    if (index >= 1 && index <= passages.length && !cited.includes(index)) cited.push(index);
  }
  if (cited.length > 0) return cited.map((n) => toSource(passages[n - 1]!, n));
  const seen = new Set<string>();
  return passages.flatMap((p, i) => {
    const key = `${p.slug}#${p.anchor}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [toSource(p, i + 1)];
  });
}

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return (
    (signal?.reason as Error | undefined)?.name === 'TimeoutError' ||
    (error as Error | undefined)?.name === 'TimeoutError'
  );
}

/** A request the user stopped. A timeout aborts the same signal, but that one is an error. */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (isTimeout(error, signal)) return false;
  return signal?.aborted === true || (error as Error | undefined)?.name === 'AbortError';
}

export function createHelpService(deps: HelpServiceDeps): HelpService {
  const makeEmbedder = deps.createEmbedder ?? defaultCreateEmbedder;
  const listModels = deps.listEmbeddingModels ?? defaultListEmbeddingModels;
  let index: HelpIndex | null = null;
  /** One embedding run per embedder at a time; a second question waits for the first run. */
  const running = new Map<string, Promise<void>>();

  function openIndex(): HelpIndex {
    if (!index) {
      index = new HelpIndex(deps.dbFile, deps.indexOptions);
      index.sync(deps.chunks());
    }
    return index;
  }

  async function embedPending(
    idx: HelpIndex,
    embedder: Embedder,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending = idx.pendingEmbeddings(embedder.id);
    if (pending.length === 0) return;
    const total = idx.embeddedCount(embedder.id) + pending.length;
    let done = total - pending.length;
    deps.onProgress?.({ done, total, embedder: embedder.id });
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(
        batch.map((c) => c.text),
        'document',
        signal,
      );
      idx.storeEmbeddings(
        embedder.id,
        batch.map((c, j) => ({ id: c.id, vector: vectors[j]! })),
      );
      done += batch.length;
      deps.onProgress?.({ done, total, embedder: embedder.id });
    }
  }

  async function ensureEmbedded(
    idx: HelpIndex,
    embedder: Embedder,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const existing = running.get(embedder.id);
      const run =
        existing ?? embedPending(idx, embedder, signal).finally(() => running.delete(embedder.id));
      if (!existing) running.set(embedder.id, run);
      try {
        return await run;
      } catch (error) {
        // A run that someone else started is stopped by that caller's signal, not ours (a rebuild
        // replaced by a newer one, say). Take the work over instead of reporting their stop as ours.
        const stoppedByOther =
          existing && !signal?.aborted && (error as Error | undefined)?.name === 'AbortError';
        if (!stoppedByOther) throw error;
      }
    }
  }

  /**
   * Ranked passage ids for a question. `query` is what gets searched (the rewritten question when
   * there is one); `original` is the user's own wording, searched by keyword as well so a rewrite
   * that drifts cannot lose an exact term the user typed.
   */
  async function retrieve(
    idx: HelpIndex,
    query: string,
    original: string,
    embedder: Embedder | null,
    signal?: AbortSignal,
  ): Promise<{ ids: string[]; retrieval: 'hybrid' | 'keyword'; notice?: string }> {
    const keyword = [idx.searchText(query, CANDIDATES)];
    if (original !== query) keyword.push(idx.searchText(original, CANDIDATES));
    if (!embedder) return { ids: reciprocalRankFusion(keyword), retrieval: 'keyword' };
    try {
      await ensureEmbedded(idx, embedder, signal);
      const [vector] = await embedder.embed([query], 'query', signal);
      const semantic = vector ? idx.searchVector(embedder.id, vector, CANDIDATES) : [];
      // Keywords go first so an exact term wins a tie between two passages that mean the same.
      return {
        ids: reciprocalRankFusion([keyword[0]!, semantic, ...keyword.slice(1)]),
        retrieval: 'hybrid',
      };
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return {
        ids: reciprocalRankFusion(keyword),
        retrieval: 'keyword',
        notice: `Answered from keyword search only. ${(error as Error).message}`,
      };
    }
  }

  /** A standalone English search query for a follow-up or a non-English question. */
  async function searchQuery(
    input: HelpAskInput,
    question: string,
    history: AskAiHistoryMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (!needsRewrite(question, history)) return question;
    try {
      const text = await deps.runPrompt(
        input.provider,
        input.model,
        rewritePrompt(question, history),
        [],
        signal,
        [],
        HELP_REWRITE_PROMPT,
      );
      return cleanQuery(text) ?? question;
    } catch (error) {
      if (isAbort(error, signal) || isTimeout(error, signal)) throw error;
      return question;
    }
  }

  return {
    async ask(input, signal) {
      const question = input.question.trim();
      if (!question) return { ok: false, text: '', sources: [], error: 'Type a question first.' };
      const history = input.history ?? [];
      try {
        const idx = openIndex();
        const settings = await deps.getSettings();
        const embedder = makeEmbedder(input.provider, settings);
        const query = await searchQuery(input, question, history, signal);
        const { ids, retrieval, notice } = await retrieve(idx, query, question, embedder, signal);
        const passages = fitPassages(
          idx.getChunks(ids.slice(0, PASSAGES)),
          passageBudget(input.provider, settings.ollamaContextLength),
        );
        const text = await deps.runPrompt(
          input.provider,
          input.model,
          buildHelpPrompt(question, passages),
          history,
          signal,
          [],
          HELP_SYSTEM_PROMPT,
        );
        return {
          ok: true,
          text,
          sources: citedSources(text, passages),
          retrieval,
          ...(notice ? { notice } : {}),
        };
      } catch (error) {
        if (isAbort(error, signal)) {
          return { ok: false, text: '', sources: [], cancelled: true, error: 'Request cancelled.' };
        }
        if (isTimeout(error, signal)) {
          return {
            ok: false,
            text: '',
            sources: [],
            error:
              'No answer in time, so the request was stopped. Check your connection and try again.',
          };
        }
        return { ok: false, text: '', sources: [], error: (error as Error).message };
      }
    },

    async status(provider) {
      const idx = openIndex();
      const embedder = makeEmbedder(provider, await deps.getSettings());
      return {
        chunks: idx.count(),
        embedded: embedder ? idx.embeddedCount(embedder.id) : 0,
        backend: idx.vectorBackend,
        embedder: embedder?.id ?? null,
      };
    },

    async reindex(provider, options = {}, signal) {
      const idx = openIndex();
      const embedder = makeEmbedder(provider, await deps.getSettings());
      if (!embedder) {
        return {
          ok: false,
          embedded: 0,
          total: idx.count(),
          removedModels: [],
          error: 'Set up this provider in Settings first.',
        };
      }
      // Earlier models of this provider are never searched again, so their vectors only take space.
      const removedModels = idx
        .embedderIds()
        .filter((id) => id !== embedder.id && id.startsWith(`${provider}:`));
      for (const id of removedModels) idx.clearEmbeddings(id);
      if (options.fresh) idx.clearEmbeddings(embedder.id);
      try {
        await ensureEmbedded(idx, embedder, signal);
        return {
          ok: true,
          embedded: idx.embeddedCount(embedder.id),
          total: idx.count(),
          removedModels,
        };
      } catch (error) {
        const result = {
          ok: false,
          embedded: idx.embeddedCount(embedder.id),
          total: idx.count(),
          removedModels,
        };
        if (isAbort(error, signal))
          return { ...result, cancelled: true, error: 'Indexing stopped.' };
        return { ...result, error: (error as Error).message };
      }
    },

    async embeddingModels(provider) {
      return listModels(provider, await deps.getSettings());
    },

    close() {
      index?.close();
      index = null;
    },
  };
}
