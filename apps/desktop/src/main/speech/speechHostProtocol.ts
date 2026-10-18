/**
 * Messages between main and the utility process that runs Whisper. Each side checks what it
 * receives and drops anything of the wrong shape, so a confused process can neither settle
 * someone else's recording nor crash the other side.
 */

export interface SpeechModelRef {
  /** Hugging Face repo id, e.g. onnx-community/whisper-base. */
  hubId: string;
  /** Weight precision to load, when the model needs one other than the default. */
  dtype?: string;
}

export interface SpeechJobInput {
  samples: Float32Array;
  /** Always a real Whisper language code. Main resolves "auto" before sending. */
  language: string;
  model: SpeechModelRef;
  /** Where downloaded weights are cached. */
  cacheDir: string;
}

export type MainToHost =
  | ({ type: 'transcribe'; jobId: string } & SpeechJobInput)
  | { type: 'cancel'; jobId: string };

export type HostToMain =
  | { type: 'ready' }
  | { type: 'progress'; jobId: string; percent: number | null; file: string }
  | { type: 'done'; jobId: string; ok: true; text: string }
  | { type: 'done'; jobId: string; ok: false; error: string };

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isModel(value: unknown): value is SpeechModelRef {
  return (
    isRecord(value) &&
    isId(value.hubId) &&
    (value.dtype === undefined || typeof value.dtype === 'string')
  );
}

export function parseMainMessage(raw: unknown): MainToHost | null {
  if (!isRecord(raw) || !isId(raw.jobId)) return null;
  if (raw.type === 'cancel') return { type: 'cancel', jobId: raw.jobId };
  if (
    raw.type === 'transcribe' &&
    raw.samples instanceof Float32Array &&
    isId(raw.language) &&
    isModel(raw.model) &&
    isId(raw.cacheDir)
  ) {
    return raw as unknown as MainToHost;
  }
  return null;
}

export function parseHostMessage(raw: unknown): HostToMain | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'ready') return { type: 'ready' };
  if (!isId(raw.jobId)) return null;
  if (raw.type === 'progress') {
    const percent = typeof raw.percent === 'number' ? raw.percent : null;
    return {
      type: 'progress',
      jobId: raw.jobId,
      percent,
      file: typeof raw.file === 'string' ? raw.file : '',
    };
  }
  if (raw.type === 'done') {
    if (raw.ok === true && typeof raw.text === 'string') {
      return { type: 'done', jobId: raw.jobId, ok: true, text: raw.text };
    }
    if (raw.ok === false) {
      const error =
        typeof raw.error === 'string' && raw.error ? raw.error : 'Transcription failed.';
      return { type: 'done', jobId: raw.jobId, ok: false, error };
    }
  }
  return null;
}
