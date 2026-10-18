import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpeechJobInput, SpeechModelRef } from './speechHostProtocol';

/**
 * Whisper itself, inside the speech utility process. onnxruntime-node loads the weights and runs
 * every decoding step synchronously on the calling thread, which for the large model is minutes
 * of solid CPU. That is why none of this runs in main: there it froze every window until the
 * transcription finished.
 */

type TransformersModule = typeof import('@huggingface/transformers');
// pipeline() is typed to return a union of every pipeline class, which isn't
// callable. Narrow to the ASR pipeline instance, which is what
// 'automatic-speech-recognition' actually produces.
type AsrPipeline = InstanceType<TransformersModule['AutomaticSpeechRecognitionPipeline']>;

export interface ModelProgress {
  percent: number | null;
  file: string;
}

export interface WhisperRunnerOptions {
  /** Loads transformers.js. Lazy, because the first import alone takes many seconds. */
  loadTransformers: () => Promise<TransformersModule>;
  /** The fetch the model download goes through. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface WhisperRunner {
  transcribe(input: SpeechJobInput, onProgress: (progress: ModelProgress) => void): Promise<string>;
}

/**
 * A failed download surfaces as Chromium's bare error code ("net::ERR_CONNECTION_CLOSED"), which
 * tells the user nothing about what was being downloaded or what to do.
 */
export function describeSpeechError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/^net::ERR_/.test(message)) {
    return `Could not download the speech model (${message}). Check your internet connection or proxy and try again. Files that finished downloading are kept.`;
  }
  return message || 'Transcription failed.';
}

/**
 * transformers.js downloads each file to `<file>.tmp.<pid>.<random>` and renames it once it is
 * whole. A host that was stopped mid-download (cancelled, timed out, crashed) never gets to the
 * rename, and on a slow line that can leave hundreds of megabytes behind. Only one host runs at a
 * time, so a temporary file from any other process is one nobody will finish.
 */
export async function removeStaleDownloads(cacheDir: string, currentPid: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir, { recursive: true });
  } catch {
    return;
  }
  const stale = /\.tmp\.(\d+)\.[^.\\/]+$/;
  await Promise.all(
    entries.map(async (entry) => {
      const match = stale.exec(entry);
      if (!match || Number(match[1]) === currentPid) return;
      await unlink(join(cacheDir, entry)).catch(() => undefined);
    }),
  );
}

export function createWhisperRunner(options: WhisperRunnerOptions): WhisperRunner {
  let transformersPromise: Promise<TransformersModule> | null = null;
  // One pipeline is kept alive per model. Building it loads the weights into memory, which is
  // expensive, so reusing it makes every transcription after the first one fast.
  let pipelinePromise: Promise<AsrPipeline> | null = null;
  let loadedModelId: string | null = null;
  // The pipeline's progress callback is fixed when it is built, so it reports through whichever
  // recording is waiting on it now.
  let reportProgress: (progress: ModelProgress) => void = () => undefined;

  function loadTransformers(cacheDir: string): Promise<TransformersModule> {
    if (!transformersPromise) {
      transformersPromise = Promise.all([
        options.loadTransformers(),
        removeStaleDownloads(cacheDir, process.pid),
      ]).then(([mod]) => {
        // Models are cached under userData so they survive app updates and never land inside
        // the read-only asar. The first run must be allowed to fetch from the hub.
        mod.env.cacheDir = cacheDir;
        mod.env.allowLocalModels = false;
        mod.env.allowRemoteModels = true;
        // transformers.js keeps the fetch it found at import, Node's own, which knows nothing of
        // the proxy the app is set to.
        mod.env.fetch = options.fetch;
        return mod;
      });
      transformersPromise.catch(() => {
        transformersPromise = null;
      });
    }
    return transformersPromise;
  }

  async function getPipeline(model: SpeechModelRef, cacheDir: string): Promise<AsrPipeline> {
    const modelId = model.hubId;
    if (pipelinePromise && loadedModelId === modelId) return pipelinePromise;

    // The large model holds over a gigabyte in memory, so the one it replaces is let go first.
    if (pipelinePromise) {
      const previous = pipelinePromise;
      pipelinePromise = null;
      loadedModelId = null;
      await previous.then((p) => p.dispose()).catch(() => undefined);
    }

    const { pipeline } = await loadTransformers(cacheDir);
    loadedModelId = modelId;
    pipelinePromise = (
      pipeline('automatic-speech-recognition', modelId, {
        ...(model.dtype ? { dtype: model.dtype as 'q4' } : {}),
        // transformers.js reports download progress per file; it is forwarded so the UI can
        // show a "downloading model" state on the very first use.
        progress_callback: (item: unknown) => {
          const p = item as { status?: string; file?: string; progress?: number };
          if (p.status === 'progress' || p.status === 'download') {
            reportProgress({
              percent: typeof p.progress === 'number' ? Math.round(p.progress) : null,
              file: p.file ?? '',
            });
          }
        },
      }) as Promise<AsrPipeline>
    ).catch((error) => {
      // Reset so a later attempt can retry instead of resolving the cached
      // rejected promise forever.
      pipelinePromise = null;
      loadedModelId = null;
      throw error;
    });

    return pipelinePromise;
  }

  return {
    async transcribe(input, onProgress) {
      reportProgress = onProgress;
      try {
        const transcriber = await getPipeline(input.model, input.cacheDir);

        // The pipeline accepts more options than its published types expose (e.g.
        // `task`), so call through a permissive signature.
        const run = transcriber as unknown as (
          audio: Float32Array,
          options: Record<string, unknown>,
        ) => Promise<{ text?: string } | { text?: string }[]>;

        const output = await run(input.samples, {
          language: input.language,
          task: 'transcribe',
          // Whisper's context window is 30s; chunking lets longer dictation through.
          chunk_length_s: 30,
          stride_length_s: 5,
        });

        const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '');
        return text.trim();
      } finally {
        reportProgress = () => undefined;
      }
    },
  };
}
