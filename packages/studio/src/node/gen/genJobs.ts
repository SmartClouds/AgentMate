import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GenJobView, GenRequest, StudioEvent } from '../../api.js';
import { confirmsEstimate, genEstimate, normalizeGenRequest } from '../../gen/estimate.js';
import { JsonStore } from '../settings/jsonStore.js';
import {
  GenError,
  geminiClipState,
  geminiDownloadClip,
  geminiImage,
  geminiStartClip,
  openaiImage,
} from './providers.js';

/**
 * Generated pictures and clips (E38), one job each, kept in `generations.json` so a clip the
 * provider is still preparing, or one half downloaded, is picked up again after a restart. Every
 * job starts only with the person's confirmation of its estimate, and records the prompt, the
 * model and the price with what it made (or why the provider declined).
 */

export interface GenJobsDeps {
  dataDir: string;
  keys(): Promise<{ openai?: string | null; gemini?: string | null }>;
  fetch: typeof fetch;
  baseUrl?: string;
  /** This video's folder for finished files waiting to be imported. */
  cacheDir(videoId: string): Promise<string>;
  /** Puts a finished file into the video's media; null while the video is not open. */
  importFile(videoId: string, file: string): Promise<{ hash: string; name: string } | null>;
  notify(event: StudioEvent): void;
  newId(): string;
  now(): number;
  pollMs?: number;
  /** How long a clip may take to be ready before the job gives up. */
  maxWaitMs?: number;
}

const recordSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  kind: z.enum(['image', 'video']),
  engine: z.enum(['openai', 'gemini']),
  model: z.string(),
  prompt: z.string(),
  size: z.string().optional(),
  quality: z.enum(['low', 'medium', 'high']).optional(),
  aspectRatio: z.string().optional(),
  estimateUsd: z.number(),
  status: z.enum(['running', 'done', 'failed', 'refused', 'interrupted', 'cancelled']),
  stage: z.enum(['request', 'waiting', 'download', 'import']).nullable(),
  /** The provider's file for a clip, saved before polling so a restart can carry on. */
  file: z.string().nullable(),
  /** Where the finished file is until it is imported. */
  output: z.string(),
  mediaHash: z.string().nullable(),
  mediaName: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  resumed: z.boolean(),
});
type GenRecord = z.infer<typeof recordSchema>;
const fileSchema = z.object({ version: z.literal(1), jobs: z.array(recordSchema) });

class Cancelled extends Error {}

function view(job: GenRecord): GenJobView {
  return {
    id: job.id,
    videoId: job.videoId,
    kind: job.kind,
    engine: job.engine,
    model: job.model,
    prompt: job.prompt,
    status: job.status,
    stage: job.status === 'running' || job.stage === 'import' ? job.stage : null,
    estimateUsd: job.estimateUsd,
    mediaHash: job.mediaHash,
    mediaName: job.mediaName,
    error: job.error,
    createdAt: job.createdAt,
    endedAt: job.endedAt,
    resumed: job.resumed,
  };
}

export function createGenJobs(deps: GenJobsDeps) {
  const store = new JsonStore(
    join(deps.dataDir, 'generations.json'),
    fileSchema,
    () => ({ version: 1 as const, jobs: [] }),
    deps.now,
  );
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Set while the app quits: jobs stop where they are and carry on after the restart. */
  let stopping = false;
  const pollMs = deps.pollMs ?? 5000;
  const maxWaitMs = deps.maxWaitMs ?? 30 * 60_000;

  async function update(id: string, patch: Partial<GenRecord>): Promise<GenRecord> {
    let next: GenRecord | undefined;
    await store.mutate((file) => {
      const job = file.jobs.find((j) => j.id === id);
      if (!job) return;
      Object.assign(job, patch);
      next = { ...job };
    });
    if (!next) throw new Error('That generation is not there any more.');
    deps.notify({ type: 'gen-changed', videoId: next.videoId, jobId: id });
    return next;
  }

  async function key(engine: 'openai' | 'gemini'): Promise<string> {
    const keys = await deps.keys();
    const value = keys[engine]?.trim();
    if (!value) {
      throw new GenError(
        engine === 'openai'
          ? 'Add an OpenAI API key in Settings > AI first.'
          : 'Add a Gemini API key in Settings > AI first.',
      );
    }
    return value;
  }

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Cancelled());
        },
        { once: true },
      );
    });

  async function importNow(job: GenRecord): Promise<GenRecord> {
    const imported = await deps.importFile(job.videoId, job.output);
    if (!imported) {
      // The video is closed; the file waits, and opening the video brings it in.
      return update(job.id, { status: 'done', stage: 'import', endedAt: deps.now() });
    }
    await rm(job.output, { force: true });
    return update(job.id, {
      status: 'done',
      stage: null,
      mediaHash: imported.hash,
      mediaName: imported.name,
      endedAt: deps.now(),
    });
  }

  async function work(start: GenRecord, signal: AbortSignal): Promise<void> {
    let job = start;
    const input = async () => ({
      key: await key(job.engine),
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      signal,
    });
    await mkdir(join(job.output, '..'), { recursive: true });
    if (job.stage === 'request') {
      if (job.kind === 'image') {
        const bytes =
          job.engine === 'openai'
            ? await openaiImage({
                ...(await input()),
                prompt: job.prompt,
                size: job.size ?? '1024x1024',
                quality: job.quality ?? 'medium',
              })
            : await geminiImage({
                ...(await input()),
                prompt: job.prompt,
                size: job.size ?? '1K',
                aspectRatio: job.aspectRatio ?? '16:9',
              });
        await writeFile(job.output, bytes);
        job = await update(job.id, { stage: 'import' });
      } else {
        const started = await geminiStartClip({
          ...(await input()),
          prompt: job.prompt,
          aspectRatio: job.aspectRatio ?? '16:9',
        });
        if (started.kind === 'inline') {
          await writeFile(job.output, started.bytes);
          job = await update(job.id, { stage: 'import' });
        } else {
          job = await update(job.id, { stage: 'waiting', file: started.file });
        }
      }
    }
    if (job.stage === 'waiting') {
      const since = deps.now();
      for (;;) {
        if (signal.aborted) throw new Cancelled();
        try {
          const state = await geminiClipState({ ...(await input()), file: job.file as string });
          if (state.state === 'ready') break;
          if (state.state === 'failed')
            throw new GenError(state.error ?? 'Gemini could not make the clip.');
        } catch (error) {
          // A dropped connection while waiting is waited out; anything else ends the job.
          if (!(error instanceof GenError) || !error.retryable) throw error;
        }
        if (deps.now() - since > maxWaitMs) {
          throw new GenError('Gemini took too long to make the clip.');
        }
        await sleep(pollMs, signal);
      }
      job = await update(job.id, { stage: 'download' });
    }
    if (job.stage === 'download') {
      const part = `${job.output}.part`;
      for (let attempt = 0; ; attempt++) {
        try {
          await geminiDownloadClip({ ...(await input()), file: job.file as string, dest: part });
          break;
        } catch (error) {
          if (signal.aborted) throw new Cancelled();
          if (!(error instanceof GenError) || !error.retryable || attempt >= 5) throw error;
          await sleep(pollMs * (attempt + 1), signal);
        }
      }
      await rename(part, job.output);
      job = await update(job.id, { stage: 'import' });
    }
    if (job.stage === 'import') await importNow(job);
  }

  function launch(job: GenRecord): void {
    const controller = new AbortController();
    const done = work(job, controller.signal)
      .catch(async (error: unknown) => {
        if (stopping) return;
        if (error instanceof Cancelled || controller.signal.aborted) {
          await update(job.id, { status: 'cancelled', stage: null, endedAt: deps.now() });
          return;
        }
        const refused = error instanceof GenError && error.refused;
        await update(job.id, {
          status: refused ? 'refused' : 'failed',
          stage: null,
          error: error instanceof Error ? error.message : String(error),
          endedAt: deps.now(),
        });
      })
      .catch(() => undefined)
      .finally(() => running.delete(job.id));
    running.set(job.id, { controller, done });
  }

  return {
    estimate(request: GenRequest) {
      return genEstimate(request);
    },

    /** Starts a generation the person confirmed at `confirmedUsd`; nothing is sent otherwise. */
    async start(
      input: GenRequest & { videoId: string; confirmedUsd: number },
    ): Promise<GenJobView> {
      const request = normalizeGenRequest(input);
      if (!confirmsEstimate(request, input.confirmedUsd)) {
        throw new Error(
          'The price changed since you confirmed it. Look at the estimate and confirm again.',
        );
      }
      const estimate = genEstimate(request);
      const id = deps.newId();
      const count = (await store.read()).jobs.filter(
        (j) => j.videoId === input.videoId && j.kind === request.kind,
      ).length;
      const name = `Generated ${request.kind === 'image' ? 'picture' : 'clip'} ${count + 1}.${request.kind === 'image' ? 'png' : 'mp4'}`;
      const record: GenRecord = {
        id,
        videoId: input.videoId,
        kind: request.kind,
        engine: request.engine,
        model: estimate.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        aspectRatio: request.aspectRatio || undefined,
        estimateUsd: estimate.usd,
        status: 'running',
        stage: 'request',
        file: null,
        output: join(await deps.cacheDir(input.videoId), 'gen', id, name),
        mediaHash: null,
        mediaName: null,
        error: null,
        createdAt: deps.now(),
        endedAt: null,
        resumed: false,
      };
      await store.mutate((file) => {
        file.jobs.push(record);
      });
      deps.notify({ type: 'gen-changed', videoId: record.videoId, jobId: id });
      launch(record);
      return view(record);
    },

    async jobs(videoId: string): Promise<GenJobView[]> {
      return (await store.read()).jobs
        .filter((j) => j.videoId === videoId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(view);
    },

    async cancel(jobId: string): Promise<void> {
      running.get(jobId)?.controller.abort();
      await running.get(jobId)?.done;
    },

    /**
     * After a restart: clips that were waiting or downloading carry on; a request that was cut off
     * before the provider answered is marked interrupted (it may have billed, so it is not sent again).
     */
    async resumeAfterStart(): Promise<void> {
      for (const job of (await store.read()).jobs) {
        if (job.status !== 'running' || running.has(job.id)) continue;
        if (job.stage === 'request') {
          await update(job.id, {
            status: 'interrupted',
            stage: null,
            error:
              'Runova closed before the provider answered. It may still have billed for it; generate again if you want it.',
            endedAt: deps.now(),
          });
          continue;
        }
        launch(await update(job.id, { resumed: true }));
      }
    },

    /** Imports what finished while this video was closed. */
    async importPending(videoId: string): Promise<void> {
      for (const job of (await store.read()).jobs) {
        if (job.videoId === videoId && job.status === 'done' && job.stage === 'import') {
          await importNow(job).catch(() => undefined);
        }
      }
    },

    /** Resolves when every running job has ended. Tests and shutdown. */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()].map((r) => r.done));
    },

    /** Stops polling and downloading without marking anything; a restart carries on. */
    async shutdown(): Promise<void> {
      stopping = true;
      const pending = [...running.values()];
      for (const r of pending) r.controller.abort();
      await Promise.all(pending.map((r) => r.done));
    },
  };
}

export type GenJobs = ReturnType<typeof createGenJobs>;
