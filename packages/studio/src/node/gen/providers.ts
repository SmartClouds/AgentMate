import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { STUDIO_GEN } from '@agentmat/core';

/**
 * The providers that make Studio's pictures and clips (E38), as their docs stood in October 2026:
 * OpenAI's Images API, and Gemini's Interactions API for pictures and for clips (Gemini Omni
 * Flash). A clip comes back as a file the provider is still preparing; it is polled until ready,
 * then downloaded so that a dropped connection carries on where it stopped.
 */

export class GenError extends Error {
  constructor(
    message: string,
    /** The provider declined the prompt (its content rules), as opposed to failing. */
    readonly refused = false,
    /** Worth trying again: a rate limit, a server error, a dropped connection. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GenError';
  }
}

export interface ProviderInput {
  key: string;
  fetch: typeof fetch;
  /** Sends every request here instead (tests and the e2e fake servers). */
  baseUrl?: string;
  signal?: AbortSignal;
}

const OPENAI = 'https://api.openai.com';
const GEMINI = 'https://generativelanguage.googleapis.com';

async function call(
  label: string,
  input: ProviderInput,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await input.fetch(url, { ...init, signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new GenError(
      `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      false,
      true,
    );
  }
  if (response.ok) return response;
  const text = (await response.text().catch(() => '')).slice(0, 600);
  let message = text;
  let code = '';
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string; status?: string };
    };
    message = parsed.error?.message ?? text;
    code = parsed.error?.code ?? parsed.error?.status ?? '';
  } catch {
    // Not JSON.
  }
  if (response.status === 401 || response.status === 403) {
    throw new GenError(`${label} refused the key. Check it in Settings > AI.`);
  }
  // A prompt the provider's rules turn down: said in its own words, never retried.
  if (/moderation|safety|content_policy|blocked/i.test(`${code} ${message}`)) {
    throw new GenError(`${label} declined this prompt: ${message}`, true);
  }
  throw new GenError(
    `${label} answered ${response.status}. ${message}`.trim(),
    false,
    response.status === 429 || response.status >= 500,
  );
}

/** One picture from OpenAI, as PNG bytes. */
export async function openaiImage(
  input: ProviderInput & { prompt: string; size: string; quality: string },
): Promise<Uint8Array> {
  const image = STUDIO_GEN.image.openai;
  const response = await call(
    image.label,
    input,
    `${input.baseUrl ?? OPENAI}/v1/images/generations`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: image.model,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        n: 1,
        output_format: 'png',
      }),
    },
  );
  const answer = (await response.json()) as { data?: { b64_json?: string }[] };
  const data = answer.data?.[0]?.b64_json;
  if (!data) throw new GenError(`${image.label} answered without a picture.`, false, true);
  return new Uint8Array(Buffer.from(data, 'base64'));
}

type InteractionAnswer = {
  id?: string;
  status?: string;
  steps?: {
    type?: string;
    content?: { type?: string; data?: string; uri?: string; mime_type?: string; text?: string }[];
  }[];
};

function outputs(answer: InteractionAnswer) {
  return (answer.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? []);
}

/** The model's words when it answered with text instead of what was asked, usually a refusal. */
function saidInstead(answer: InteractionAnswer): string {
  return outputs(answer)
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join(' ')
    .trim();
}

/** One picture from Gemini, as bytes. */
export async function geminiImage(
  input: ProviderInput & { prompt: string; size: string; aspectRatio: string },
): Promise<Uint8Array> {
  const image = STUDIO_GEN.image.gemini;
  const response = await call(
    image.label,
    input,
    `${input.baseUrl ?? GEMINI}/v1beta/interactions`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': input.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: image.model,
        input: input.prompt,
        response_format: {
          type: 'image',
          mime_type: 'image/png',
          aspect_ratio: input.aspectRatio,
          image_size: input.size,
        },
      }),
    },
  );
  const answer = (await response.json()) as InteractionAnswer;
  const picture = outputs(answer).find((c) => c.type === 'image' && c.data);
  if (!picture?.data) {
    const said = saidInstead(answer);
    throw new GenError(
      said
        ? `${image.label} declined this prompt: ${said}`
        : `${image.label} answered without a picture.`,
      Boolean(said),
    );
  }
  return new Uint8Array(Buffer.from(picture.data, 'base64'));
}

/** A clip Gemini has started: its file (still being prepared) or, for a small one, its bytes. */
export type StartedClip =
  | { kind: 'file'; interactionId: string | null; file: string }
  | { kind: 'inline'; interactionId: string | null; bytes: Uint8Array };

/** Asks Gemini Omni for a clip, delivered as a file to poll and download. */
export async function geminiStartClip(
  input: ProviderInput & { prompt: string; aspectRatio: string },
): Promise<StartedClip> {
  const video = STUDIO_GEN.video.gemini;
  const response = await call(
    video.label,
    input,
    `${input.baseUrl ?? GEMINI}/v1beta/interactions`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': input.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: video.model,
        input: input.prompt,
        response_format: {
          type: 'video',
          aspect_ratio: input.aspectRatio,
          resolution: '720p',
          delivery: 'uri',
        },
        generation_config: { video_config: { task: 'text_to_video' } },
      }),
    },
  );
  const answer = (await response.json()) as InteractionAnswer;
  const clip = outputs(answer).find((c) => c.type === 'video' && (c.uri || c.data));
  if (clip?.uri) {
    const file = /files\/[A-Za-z0-9_-]+/.exec(clip.uri)?.[0];
    if (file) return { kind: 'file', interactionId: answer.id ?? null, file };
  }
  if (clip?.data) {
    return {
      kind: 'inline',
      interactionId: answer.id ?? null,
      bytes: new Uint8Array(Buffer.from(clip.data, 'base64')),
    };
  }
  const said = saidInstead(answer);
  throw new GenError(
    said
      ? `${video.label} declined this prompt: ${said}`
      : `${video.label} answered without a clip.`,
    Boolean(said),
  );
}

/** Where a clip's file stands: still being prepared, ready, or failed. */
export async function geminiClipState(
  input: ProviderInput & { file: string },
): Promise<{ state: 'waiting' | 'ready' | 'failed'; error: string | null }> {
  const response = await call(
    STUDIO_GEN.video.gemini.label,
    input,
    `${input.baseUrl ?? GEMINI}/v1beta/${input.file}`,
    { headers: { 'x-goog-api-key': input.key } },
  );
  const answer = (await response.json()) as { state?: string; error?: { message?: string } };
  if (answer.state === 'ACTIVE') return { state: 'ready', error: null };
  if (answer.state === 'FAILED') {
    return { state: 'failed', error: answer.error?.message ?? 'Gemini could not make the clip.' };
  }
  return { state: 'waiting', error: null };
}

/**
 * Downloads a ready clip to `dest`, carrying on from the bytes already there (a Range request), so
 * a connection that drops, or an app that restarts, loses nothing.
 */
export async function geminiDownloadClip(
  input: ProviderInput & { file: string; dest: string },
): Promise<void> {
  const have = await stat(input.dest).then(
    (s) => s.size,
    () => 0,
  );
  const response = await call(
    STUDIO_GEN.video.gemini.label,
    input,
    `${input.baseUrl ?? GEMINI}/v1beta/${input.file}:download?alt=media`,
    {
      headers: { 'x-goog-api-key': input.key, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
    },
  );
  // A server that ignores the range sends the whole file again: start over rather than append.
  const append = have > 0 && response.status === 206;
  const out = createWriteStream(input.dest, { flags: append ? 'a' : 'w' });
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new GenError('Gemini sent an empty clip.', false, true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
    }
  } catch (error) {
    if (error instanceof GenError || input.signal?.aborted) throw error;
    throw new GenError(
      `The clip download stopped: ${error instanceof Error ? error.message : String(error)}. What arrived is kept.`,
      false,
      true,
    );
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}
