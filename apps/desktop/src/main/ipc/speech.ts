import { join } from 'node:path';
import {
  DEFAULT_WHISPER_MODEL,
  resolveSpeechLanguage,
  WHISPER_MODELS,
  type WhisperModel,
} from '@agentmat/core';
import { app, ipcMain } from 'electron';
import type {
  SpeechModelProgress,
  SpeechModelState,
  TranscribeAudioInput,
  TranscribeAudioResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';
import { broadcastToWindows } from './send';

// Whisper ONNX weights, served from the Hugging Face hub the first time and
// then cached to disk. onnx-community publishes the quantized variants
// transformers.js expects. The list itself lives in the model catalog.
function resolveModel(modelKey: string | undefined): WhisperModel {
  return (
    WHISPER_MODELS.find((m) => m.key === modelKey) ??
    WHISPER_MODELS.find((m) => m.key === DEFAULT_WHISPER_MODEL) ??
    WHISPER_MODELS[0]!
  );
}

// transformers.js is ESM-only for its Node build and pulls in the native
// onnxruntime-node addon, so it's loaded lazily on first use rather than at
// startup. That keeps app launch fast and avoids paying the cost for users
// who never touch voice input.
type TransformersModule = typeof import('@huggingface/transformers');
// pipeline() is typed to return a union of every pipeline class, which isn't
// callable. Narrow to the ASR pipeline instance, which is what
// 'automatic-speech-recognition' actually produces.
type AsrPipeline = InstanceType<TransformersModule['AutomaticSpeechRecognitionPipeline']>;

let transformersPromise: Promise<TransformersModule> | null = null;
async function loadTransformers(): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers').then((mod) => {
      // Models are cached under userData so they survive app updates and never
      // land inside the read-only asar. Local-only lookups are disabled: the
      // first run must be allowed to fetch from the hub.
      mod.env.cacheDir = join(app.getPath('userData'), 'whisper-models');
      mod.env.allowLocalModels = false;
      mod.env.allowRemoteModels = true;
      return mod;
    });
  }
  return transformersPromise;
}

// One pipeline instance is kept alive per model id. Building it loads the
// weights into memory, which is expensive, so reusing it makes every
// transcription after the first one fast.
let pipelinePromise: Promise<AsrPipeline> | null = null;
let loadedModelId: string | null = null;

function broadcastProgress(progress: SpeechModelProgress): void {
  broadcastToWindows(IPC.speech.onModelProgress, progress);
}

async function getPipeline(model: WhisperModel): Promise<AsrPipeline> {
  const modelId = model.hubId;
  if (pipelinePromise && loadedModelId === modelId) return pipelinePromise;

  // The large model holds over a gigabyte in memory, so the one it replaces is let go first.
  if (pipelinePromise) {
    const previous = pipelinePromise;
    pipelinePromise = null;
    loadedModelId = null;
    await previous.then((p) => p.dispose()).catch(() => undefined);
  }

  const { pipeline } = await loadTransformers();
  loadedModelId = modelId;
  pipelinePromise = (
    pipeline('automatic-speech-recognition', modelId, {
      ...(model.dtype ? { dtype: model.dtype as 'q4' } : {}),
      // transformers.js reports download progress per-file; forward it so the UI
      // can show a "downloading model" state on the very first use.
      progress_callback: (item: unknown) => {
        const p = item as { status?: string; file?: string; progress?: number };
        if (p.status === 'progress' || p.status === 'download') {
          broadcastProgress({
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

async function transcribe(input: TranscribeAudioInput): Promise<string> {
  const settings = await store.getSettings();
  const transcriber = await getPipeline(resolveModel(settings.speechModel));

  // The pipeline accepts more options than its published types expose (e.g.
  // `task`), so call through a permissive signature.
  const run = transcriber as unknown as (
    audio: Float32Array,
    options: Record<string, unknown>,
  ) => Promise<{ text?: string } | { text?: string }[]>;

  const output = await run(input.samples, {
    // Always a real language. Left out, transformers.js does not detect one, it assumes
    // English, and Persian speech comes back as made-up English words.
    language: resolveSpeechLanguage(input.language, app.getLocale()),
    task: 'transcribe',
    // Whisper's context window is 30s; chunking lets longer dictation through.
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '');
  return text.trim();
}

export function registerSpeechHandlers(): void {
  ipcMain.handle(
    IPC.speech.transcribe,
    async (_event, input: TranscribeAudioInput): Promise<TranscribeAudioResult> => {
      try {
        const text = await transcribe(input);
        return { ok: true, text };
      } catch (error) {
        return {
          ok: false,
          text: '',
          error: (error as Error).message || 'Transcription failed.',
        };
      }
    },
  );

  ipcMain.handle(IPC.speech.getModelState, async (): Promise<SpeechModelState> => {
    const settings = await store.getSettings();
    const modelId = resolveModel(settings.speechModel).hubId;
    return { ready: loadedModelId === modelId && pipelinePromise !== null, modelId };
  });
}
