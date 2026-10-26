import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import {
  DEFAULT_WHISPER_MODEL,
  resolveSpeechLanguage,
  WHISPER_MODELS,
  type WhisperModel,
} from '@runova/core';
import { app, ipcMain, utilityProcess } from 'electron';
import type {
  SpeechModelState,
  TranscribeAudioInput,
  TranscribeAudioResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { createSpeechHost, type SpeechHost } from '../speech/speechHostClient';
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

function entryPath(): string {
  // Loaded from inside the archive in packaged builds: unlike a worker thread, a utility process
  // reads asar, and staying inside it is what lets the runtime find its node_modules.
  const bundled = join(__dirname, 'speechHost.mjs');
  return bundled.replace(`app.asar.unpacked${sep}`, `app.asar${sep}`);
}

function spawnSpeechHost() {
  return utilityProcess.fork(entryPath(), [], {
    serviceName: 'Runova Speech',
    // A proxy that wants a password asks main, which already answers for the windows.
    respondToAuthRequestsFromMainProcess: true,
    stdio: 'ignore',
  });
}

let speechHost: SpeechHost | null = null;

function host(): SpeechHost {
  if (!speechHost) {
    speechHost = createSpeechHost({
      spawn: spawnSpeechHost,
      onProgress: (progress) => broadcastToWindows(IPC.speech.onModelProgress, progress),
    });
  }
  return speechHost;
}

/** Speech to text with the model chosen in Settings: 16 kHz mono samples in, words out. */
export async function transcribeSamples(
  input: TranscribeAudioInput,
): Promise<TranscribeAudioResult> {
  try {
    const settings = await store.getSettings();
    const model = resolveModel(settings.speechModel);
    return await host().transcribe(input.requestId || randomUUID(), {
      samples: input.samples,
      // Always a real language. Left out, transformers.js does not detect one, it assumes
      // English, and Persian speech comes back as made-up English words.
      language: resolveSpeechLanguage(input.language, app.getLocale()),
      model: { hubId: model.hubId, ...(model.dtype ? { dtype: model.dtype } : {}) },
      cacheDir: join(app.getPath('userData'), 'whisper-models'),
    });
  } catch (error) {
    return {
      ok: false,
      text: '',
      error: (error as Error).message || 'Transcription failed.',
    };
  }
}

export function registerSpeechHandlers(): void {
  ipcMain.handle(IPC.speech.transcribe, (_event, input: TranscribeAudioInput) =>
    transcribeSamples(input),
  );

  ipcMain.handle(IPC.speech.cancel, (_event, requestId: unknown) => {
    if (typeof requestId === 'string' && requestId) speechHost?.cancel(requestId);
  });

  ipcMain.handle(IPC.speech.getModelState, async (): Promise<SpeechModelState> => {
    const settings = await store.getSettings();
    const modelId = resolveModel(settings.speechModel).hubId;
    return { ready: speechHost?.isModelLoaded(modelId) ?? false, modelId };
  });
}

export function shutdownSpeech(): void {
  speechHost?.shutdown();
}
