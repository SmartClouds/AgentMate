import { tmpdir } from 'node:os';
import { buildRunAssessmentPrompt, parseRunAssessment, runArgsFor } from '@agentmat/core';
import { ipcMain } from 'electron';
import type {
  AiProvider,
  AskAiHistoryMessage,
  AskAiInput,
  AskAiResult,
  AskCliInput,
  AskCliResult,
  AssessRunInput,
  AssessRunResult,
  OllamaConnectionTest,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { store } from '../store';

/** True for the DOMException fetch throws when its AbortSignal fires. */
function isAbortError(error: unknown): boolean {
  return (error as Error | undefined)?.name === 'AbortError';
}

/** True for the DOMException fetch throws when an AbortSignal.timeout() runs out. */
function isTimeoutError(error: unknown): boolean {
  return (error as Error | undefined)?.name === 'TimeoutError';
}

/**
 * How long an ask() may go without an answer. A stalled connection otherwise holds the
 * request (and every spinner waiting on it) open for as long as the socket survives.
 * Ollama gets longer because a local model can take minutes to load and answer on CPU.
 */
const ASK_TIMEOUT_MS: Record<AiProvider, number> = {
  openai: 3 * 60_000,
  gemini: 3 * 60_000,
  ollama: 10 * 60_000,
};

async function askOpenAi(
  model: string,
  prompt: string,
  history: AskAiHistoryMessage[],
  signal?: AbortSignal,
  images: string[] = [],
  system?: string,
): Promise<string> {
  const settings = await store.getSettings();
  const apiKey = settings.openaiApiKey?.trim();
  if (!apiKey) throw new Error('Set an OpenAI API key in Settings first.');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...history.map((h) => ({ role: h.role, content: h.content })),
        {
          role: 'user',
          content:
            images.length > 0
              ? [
                  { type: 'text', text: prompt },
                  ...images.map((png) => ({
                    type: 'image_url',
                    image_url: { url: `data:image/png;base64,${png}` },
                  })),
                ]
              : prompt,
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = `OpenAI request failed with status ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Response body wasn't JSON, fall back to the generic status message.
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? '';
}

/** Falls back to the saved server, then to the local default, and drops any trailing slashes. */
function normalizeOllamaUrl(saved: string, override?: string): string {
  return (override?.trim() || saved || 'http://localhost:11434').replace(/\/+$/, '');
}

async function ollamaBaseUrl(override?: string): Promise<string> {
  const settings = await store.getSettings();
  return normalizeOllamaUrl(settings.ollamaBaseUrl, override);
}

async function askOllama(
  model: string,
  prompt: string,
  history: AskAiHistoryMessage[],
  signal?: AbortSignal,
  images: string[] = [],
  system?: string,
): Promise<string> {
  const settings = await store.getSettings();
  const baseUrl = normalizeOllamaUrl(settings.ollamaBaseUrl);
  if (!model) throw new Error('Choose an Ollama model first.');

  const numCtx = settings.ollamaContextLength;
  const keepAlive = settings.ollamaKeepAlive?.trim();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: prompt, ...(images.length > 0 ? { images } : {}) },
        ],
        stream: false,
        // Omitted keys let Ollama keep its own defaults, so only send what the user set.
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
        ...(numCtx && numCtx > 0 ? { options: { num_ctx: numCtx } } : {}),
      }),
      signal,
    });
  } catch (error) {
    // A cancelled or timed-out request must not be reported as an unreachable server.
    if (isAbortError(error) || isTimeoutError(error)) throw error;
    throw new Error(`Could not reach Ollama at ${baseUrl}. Is it running?`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Ollama request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

async function askGemini(
  model: string,
  prompt: string,
  history: AskAiHistoryMessage[],
  signal?: AbortSignal,
  images: string[] = [],
  system?: string,
): Promise<string> {
  const settings = await store.getSettings();
  const apiKey = settings.geminiApiKey?.trim();
  if (!apiKey) throw new Error('Set a Gemini API key in Settings first.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      contents: [
        ...history.map((h) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }],
        })),
        {
          role: 'user',
          parts: [
            { text: prompt },
            ...images.map((png) => ({ inline_data: { mime_type: 'image/png', data: png } })),
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = `Gemini request failed with status ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Response body wasn't JSON, fall back to the generic status message.
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

async function listGeminiModels(): Promise<string[]> {
  const settings = await store.getSettings();
  const apiKey = settings.geminiApiKey?.trim();
  if (!apiKey) throw new Error('Set a Gemini API key in Settings first.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = `Gemini request failed with status ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Response body wasn't JSON, fall back to the generic status message.
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  return (data.models ?? [])
    .filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name as string).replace(/^models\//, ''))
    .sort();
}

async function listOllamaModels(baseUrlOverride?: string): Promise<string[]> {
  const baseUrl = await ollamaBaseUrl(baseUrlOverride);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`Could not reach Ollama at ${baseUrl}. Is it running?`);
  }
  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

/** Probes a server for the Settings "Test connection" button, reporting failures instead of throwing. */
async function testOllamaConnection(baseUrlOverride?: string): Promise<OllamaConnectionTest> {
  const baseUrl = await ollamaBaseUrl(baseUrlOverride);

  let version: string | undefined;
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return { ok: false, error: `Ollama answered with status ${response.status}.` };
    }
    const data = (await response.json()) as { version?: string };
    version = data.version;
  } catch {
    return { ok: false, error: `Could not reach Ollama at ${baseUrl}. Is it running?` };
  }

  try {
    const models = await listOllamaModels(baseUrl);
    return { ok: true, version, modelCount: models.length };
  } catch (error) {
    return { ok: false, version, error: (error as Error).message };
  }
}

/**
 * Shared by the Ask AI IPC handler and other features (e.g. git branch/commit suggestions).
 * `images` are PNG screenshots, base64 without the `data:` prefix, attached to the prompt; the
 * model has to be one that can see images. `system` is an instruction that frames the whole
 * conversation, sent the way each provider expects one rather than as part of the question.
 */
export async function runAiPrompt(
  provider: AiProvider,
  model: string,
  prompt: string,
  history: AskAiHistoryMessage[] = [],
  signal?: AbortSignal,
  images: string[] = [],
  system?: string,
): Promise<string> {
  if (provider === 'openai') return askOpenAi(model, prompt, history, signal, images, system);
  if (provider === 'gemini') return askGemini(model, prompt, history, signal, images, system);
  return askOllama(model, prompt, history, signal, images, system);
}

/** A sizing answer is one short JSON object; a CLI still busy after this has gone astray. */
const ASSESS_RUN_TIMEOUT_MS = 120000;

/**
 * Asks the default AI CLI (Settings, then any installed headless-capable CLI) to size a
 * generated prompt. It runs from the temp dir rather than a project folder: the CLI only
 * needs the prompt text, and an agent started inside a repo tends to read files first,
 * which costs time and tokens for no better answer.
 */
export async function assessRun(input: AssessRunInput): Promise<AssessRunResult> {
  const result = await runHeadlessCliPrompt(buildRunAssessmentPrompt(input), tmpdir(), {
    requestId: input.requestId,
    timeoutMs: ASSESS_RUN_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      ok: false,
      cliName: result.cliName,
      error: result.error,
      cancelled: result.cancelled,
    };
  }
  const assessment = parseRunAssessment(result.text, input.targetAI);
  if (!assessment) {
    return {
      ok: false,
      cliName: result.cliName,
      error: `${result.cliName ?? 'The CLI'} answered, but not with a usable assessment. Try again.`,
    };
  }
  return { ok: true, assessment, cliName: result.cliName };
}

/**
 * A written-out prompt is a long answer, and a high effort setting can spend minutes thinking
 * before the first word. Five minutes covers that with room to spare.
 */
const ASK_CLI_TIMEOUT_MS = 5 * 60_000;

/**
 * Answers a one-off prompt with the CLI, model and effort the user picked. Strict, so a missing
 * CLI fails with a clear message instead of quietly answering with a different one (whose model
 * flags wouldn't fit). Runs from the temp dir for the same reason assessRun() does.
 */
export async function askCli(input: AskCliInput): Promise<AskCliResult> {
  const result = await runHeadlessCliPrompt(input.prompt, tmpdir(), {
    requestId: input.requestId,
    preferredCliId: input.cliId,
    strictCli: true,
    runArgs: runArgsFor(input.cliId, input.modelId, input.effort),
    timeoutMs: ASK_CLI_TIMEOUT_MS,
  });
  return {
    ok: result.ok,
    text: result.ok ? result.text : '',
    cliName: result.cliName,
    error: result.error,
    cancelled: result.cancelled,
    timedOut: result.timedOut,
  };
}

/** In-flight requests that carried a requestId, so the renderer can abort them. */
const inFlightRequests = new Map<string, AbortController>();

export function registerAiHandlers(): void {
  ipcMain.handle(IPC.ai.ask, async (_event, input: AskAiInput): Promise<AskAiResult> => {
    const controller = new AbortController();
    // runAiPrompt treats anything that isn't OpenAI or Gemini as Ollama, and so does this.
    const timeoutMs = ASK_TIMEOUT_MS[input.provider] ?? ASK_TIMEOUT_MS.ollama;
    if (input.requestId) inFlightRequests.set(input.requestId, controller);
    try {
      const text = await runAiPrompt(
        input.provider,
        input.model,
        input.prompt,
        input.history ?? [],
        AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      );
      return { ok: true, text };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, text: '', cancelled: true, error: 'Request cancelled.' };
      }
      if (isTimeoutError(error)) {
        const minutes = Math.round(timeoutMs / 60_000);
        return {
          ok: false,
          text: '',
          error: `No answer after ${minutes} minutes, so the request was stopped. Check your connection and try again.`,
        };
      }
      return { ok: false, text: '', error: (error as Error).message };
    } finally {
      if (input.requestId) inFlightRequests.delete(input.requestId);
    }
  });

  ipcMain.handle(IPC.ai.cancel, (_event, requestId: string): boolean => {
    const controller = inFlightRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlightRequests.delete(requestId);
    return true;
  });

  ipcMain.handle(
    IPC.ai.listOllamaModels,
    (_event, baseUrl?: string): Promise<string[]> => listOllamaModels(baseUrl),
  );
  ipcMain.handle(
    IPC.ai.testOllama,
    (_event, baseUrl?: string): Promise<OllamaConnectionTest> => testOllamaConnection(baseUrl),
  );
  ipcMain.handle(IPC.ai.listGeminiModels, (): Promise<string[]> => listGeminiModels());
  ipcMain.handle(
    IPC.ai.assessRun,
    (_event, input: AssessRunInput): Promise<AssessRunResult> => assessRun(input),
  );
  ipcMain.handle(IPC.ai.cancelAssessRun, (_event, requestId: string): boolean =>
    cancelHeadlessPrompt(requestId),
  );
  ipcMain.handle(
    IPC.ai.askCli,
    (_event, input: AskCliInput): Promise<AskCliResult> => askCli(input),
  );
  ipcMain.handle(IPC.ai.cancelAskCli, (_event, requestId: string): boolean =>
    cancelHeadlessPrompt(requestId),
  );
}
