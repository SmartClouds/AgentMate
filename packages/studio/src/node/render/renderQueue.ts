import { access, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  RenderEstimateView,
  RenderJobView,
  RenderStatus,
  RenderToolsView,
  StudioEvent,
} from '../../api.js';
import { RENDER_STATUSES } from '../../api.js';
import { CODECS, type StudioDocument } from '../../document/schema.js';
import {
  codecProblem,
  containerFor,
  type FfmpegCapabilities,
  hardwareCandidates,
} from '../../render/ffmpeg.js';
import {
  buildRenderPlan,
  estimateRender,
  type PlanOptions,
  type RenderPlan,
} from '../../render/plan.js';
import { safeFolderName } from '../../text/names.js';
import { nonCommercialNarration } from '../../voice/voices.js';
import { BlobStore } from '../blobs/blobStore.js';
import { JsonStore } from '../settings/jsonStore.js';
import { pruneSceneCache } from './cachePrune.js';
import {
  encoderWorks,
  FfmpegError,
  type FfmpegTools,
  probeFfmpeg,
  RenderCancelledError,
  type ToolCommand,
} from './ffmpegTool.js';
import { type RenderFrameHost, type RenderProgress, runRenderJob } from './renderJob.js';

/**
 * The render queue: one render at a time, kept in `renders.json` so it outlives the app. A render
 * the app stopped in the middle of is picked up again on the next start (unless the user turned
 * that off), and since its finished chunks are in the cache, it carries on where it was.
 */

export interface StudioRenderHost {
  /** ffmpeg and ffprobe where this machine has them; null for one that is missing. */
  tools(): Promise<{ ffmpeg: ToolCommand | null; ffprobe: ToolCommand | null }>;
  frames: RenderFrameHost;
}

export interface StudioRenderDeps {
  host: StudioRenderHost | undefined;
  dataDir: string;
  now: () => number;
  newId: () => string;
  notify: (event: StudioEvent) => void;
  /** Where the video is, and what it is called, from the library. */
  video: (videoId: string) => Promise<{ folder: string; title: string }>;
  /** The cache root (`<userData>/studio-cache` unless moved) and its size cap. */
  cache: () => Promise<{ dir: string; capBytes: number }>;
  autoResume: () => Promise<boolean>;
  /** Lets the scene server find this video's code while its render runs, closed or not. */
  serveTrees: (videoId: string, folder: string) => () => void;
  /** Changes whenever the runtime or the fonts do, so old chunks are not reused with new ones. */
  runtimeVersion: () => Promise<string>;
  /** Free bytes on the volume holding a path; null when it cannot be told. */
  freeBytes?: (path: string) => Promise<number | null>;
  memoryCapBytes?: number;
  recycleEveryChunks?: number;
  progressIntervalMs?: number;
}

/** What the plan needs besides the document: the imported files and the caption page. */
export type PlanInputs = Pick<PlanOptions, 'media' | 'captionTree'>;

export interface StudioRender {
  tools(): Promise<RenderToolsView>;
  estimate(input: {
    videoId: string;
    document: StudioDocument;
    planInputs?: PlanInputs;
  }): Promise<RenderEstimateView>;
  start(input: {
    videoId: string;
    document: StudioDocument;
    allowedHosts: readonly string[];
    fileName?: string;
    planInputs?: PlanInputs;
  }): Promise<RenderJobView>;
  jobs(videoId?: string): Promise<RenderJobView[]>;
  cancel(jobId: string): Promise<void>;
  retry(jobId: string): Promise<RenderJobView>;
  remove(jobId: string): Promise<void>;
  /** Whether a render of this video is waiting or running. */
  busy(videoId: string): Promise<boolean>;
  /** Picks up renders the app stopped in the middle of. Called once, when the app starts. */
  resumeAfterStart(): Promise<void>;
  /** Stops the running render as a crash would, so the next start resumes it. */
  shutdown(): Promise<void>;
  /** Resolves when nothing is queued or running. Tests only. */
  idle(): Promise<void>;
}

/** Less than this free and a render cannot finish, whatever the estimate says. */
const MIN_FREE_BYTES = 512 * 1024 * 1024;

const jobSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  title: z.string(),
  fileName: z.string(),
  folder: z.string(),
  /** Where the finished file goes. */
  target: z.string(),
  status: z.enum(RENDER_STATUSES),
  phase: z.enum(['capture', 'encode']).nullable(),
  done: z.number(),
  total: z.number(),
  // Written by this code only; a hand-edited file that breaks it fails that render, nothing more.
  plan: z.custom<RenderPlan>((value) => typeof value === 'object' && value !== null),
  allowedHosts: z.array(z.string()),
  output: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  resumed: z.boolean(),
  reusedChunks: z.number(),
  capturedChunks: z.number(),
  hardware: z.string().nullable(),
  // Added in E37; older renders have none.
  nonCommercial: z.array(z.string()).default([]),
});
type JobRecord = z.infer<typeof jobSchema>;
const fileSchema = z.object({ version: z.literal(1), jobs: z.array(jobSchema) });
type RendersFile = z.infer<typeof fileSchema>;

function view(job: JobRecord): RenderJobView {
  return {
    id: job.id,
    videoId: job.videoId,
    title: job.title,
    fileName: job.fileName,
    status: job.status,
    phase: job.phase,
    done: job.done,
    total: job.total,
    settings: job.plan.settings,
    width: job.plan.width,
    height: job.plan.height,
    frames: job.plan.totalFrames,
    durationSeconds: job.plan.totalFrames / job.plan.fps,
    output: job.output,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    resumed: job.resumed,
    reusedChunks: job.reusedChunks,
    capturedChunks: job.capturedChunks,
    hardware: job.hardware,
    nonCommercial: job.nonCommercial,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Free bytes on the volume of `path`, asking its nearest existing parent. */
export async function freeBytesAt(path: string): Promise<number | null> {
  let at = path;
  for (;;) {
    try {
      const info = await statfs(at);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function defaultFileName(document: StudioDocument): string {
  const { aspect, resolution } = document.renderSettings;
  return safeFolderName(`${document.title} ${aspect.replace(':', 'x')} ${resolution}`, 'video');
}

const NOT_INSTALLED =
  'ffmpeg is not installed. Install it from Agent Tools, Dev Setup (Studio), then try again.';

export function createStudioRender(deps: StudioRenderDeps): StudioRender {
  const store = new JsonStore<RendersFile>(
    join(deps.dataDir, 'renders.json'),
    fileSchema,
    () => ({ version: 1, jobs: [] }),
    deps.now,
  );
  const freeBytes = deps.freeBytes ?? freeBytesAt;
  const progressMs = deps.progressIntervalMs ?? 250;
  /** Capabilities per ffmpeg path; one probe a run is plenty. */
  const capabilities = new Map<string, Promise<FfmpegCapabilities>>();
  /** Whether each hardware encoder passed its test encode. */
  const encoderChecks = new Map<string, Promise<boolean>>();
  let running: {
    id: string;
    controller: AbortController;
    stopping: boolean;
    done: Promise<void>;
  } | null = null;
  let idleWaiters: (() => void)[] = [];

  const changed = (job: Pick<JobRecord, 'id' | 'videoId'>) =>
    deps.notify({ type: 'render-changed', jobId: job.id, videoId: job.videoId });

  async function update(id: string, change: (job: JobRecord) => void): Promise<JobRecord> {
    let found: JobRecord | undefined;
    await store.mutate((file) => {
      found = file.jobs.find((j) => j.id === id);
      if (found) change(found);
    });
    if (!found) throw new Error('That render is not in the list any more.');
    changed(found);
    return found;
  }

  async function job(id: string): Promise<JobRecord> {
    const found = (await store.read()).jobs.find((j) => j.id === id);
    if (!found) throw new Error('That render is not in the list any more.');
    return found;
  }

  async function resolveTools(): Promise<{
    tools: FfmpegTools | null;
    ffmpeg: boolean;
    ffprobe: boolean;
  }> {
    const paths = deps.host ? await deps.host.tools() : { ffmpeg: null, ffprobe: null };
    const tools =
      paths.ffmpeg && paths.ffprobe ? { ffmpeg: paths.ffmpeg, ffprobe: paths.ffprobe } : null;
    return { tools, ffmpeg: !!paths.ffmpeg, ffprobe: !!paths.ffprobe };
  }

  function capabilitiesOf(tools: FfmpegTools): Promise<FfmpegCapabilities> {
    const key = JSON.stringify(tools.ffmpeg);
    let caps = capabilities.get(key);
    if (!caps) {
      caps = probeFfmpeg(tools);
      capabilities.set(key, caps);
      caps.catch(() => capabilities.delete(key));
    }
    return caps;
  }

  async function pickHardware(tools: FfmpegTools, plan: RenderPlan, caps: FfmpegCapabilities) {
    if (!plan.settings.hwEncode) return null;
    for (const encoder of hardwareCandidates(plan.settings.codec, caps)) {
      let works = encoderChecks.get(encoder);
      if (!works) {
        works = encoderWorks(tools, encoder);
        encoderChecks.set(encoder, works);
      }
      if (await works) return encoder;
    }
    return null;
  }

  function wakeIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function execute(record: JobRecord, controller: AbortController): Promise<void> {
    const { tools } = await resolveTools();
    if (!tools) throw new Error(NOT_INSTALLED);
    const caps = await capabilitiesOf(tools);
    const problem = codecProblem(record.plan.settings.codec, caps);
    if (problem) throw new Error(problem);
    const cache = await deps.cache();
    for (const [where, path] of [
      ['the cache folder', cache.dir],
      ['the video folder', record.folder],
    ] as const) {
      const free = await freeBytes(path);
      if (free !== null && free < MIN_FREE_BYTES) {
        throw new Error(`There is not enough free space on ${where} (${gb(free)} left) to render.`);
      }
    }
    const videoCache = join(cache.dir, record.videoId, 'scenes');
    const blobs = BlobStore.forVideo(record.folder);
    const hardware = await pickHardware(tools, record.plan, caps);
    const release = deps.serveTrees(record.videoId, record.folder);
    let lastNotify = 0;
    let lastSave = Date.now();
    const onProgress = (p: RenderProgress) => {
      const at = Date.now();
      const finished = p.done === p.total;
      if (finished || at - lastNotify >= progressMs) {
        lastNotify = at;
        deps.notify({ type: 'render-progress', jobId: record.id, videoId: record.videoId, ...p });
      }
      if (finished || at - lastSave >= 2000) {
        lastSave = at;
        void store
          .mutate((file) => {
            const found = file.jobs.find((j) => j.id === record.id);
            if (found) Object.assign(found, { phase: p.phase, done: p.done, total: p.total });
          })
          .catch(() => undefined);
      }
    };
    const run = (encoder: string | null) =>
      runRenderJob({
        plan: record.plan,
        tools,
        capabilities: caps,
        hardware: encoder,
        frames: (deps.host as StudioRenderHost).frames,
        allowedHosts: record.allowedHosts,
        mediaPath: (hash) => blobs.path(hash),
        cacheDir: videoCache,
        workDir: join(cache.dir, record.videoId, `render-${record.id}`),
        output: record.target,
        signal: controller.signal,
        onProgress,
        memoryCapBytes: deps.memoryCapBytes,
        recycleEveryChunks: deps.recycleEveryChunks,
      });
    try {
      let result: Awaited<ReturnType<typeof runRenderJob>>;
      let used = hardware;
      try {
        result = await run(hardware);
      } catch (error) {
        // A GPU encoder that passed its test can still fail on a real video (driver limits on
        // size or level). The frames are cached, so the software encoder only redoes the join.
        if (!hardware || !(error instanceof FfmpegError) || controller.signal.aborted) throw error;
        used = null;
        result = await run(null);
      }
      const finished = await update(record.id, (j) => {
        Object.assign(j, {
          status: 'done' satisfies RenderStatus,
          phase: null,
          done: j.total,
          output: result.output,
          endedAt: deps.now(),
          reusedChunks: result.reusedChunks,
          capturedChunks: result.capturedChunks,
          hardware: used,
        });
      });
      deps.notify({
        type: 'render-finished',
        jobId: finished.id,
        videoId: finished.videoId,
        fileName: finished.fileName,
        ok: true,
        error: null,
      });
    } finally {
      release();
    }
    const keep = new Set(record.plan.scenes.map((s) => s.cacheInputs));
    await pruneSceneCache(cache.dir, cache.capBytes, keep).catch(() => undefined);
  }

  function kick(): void {
    if (running) return;
    void (async () => {
      const next = (await store.read()).jobs.find((j) => j.status === 'queued');
      if (!next || running) {
        if (!running) wakeIdle();
        return;
      }
      const controller = new AbortController();
      const current = { id: next.id, controller, stopping: false, done: Promise.resolve() };
      running = current;
      current.done = (async () => {
        try {
          const record = await update(next.id, (j) => {
            Object.assign(j, {
              status: 'running' satisfies RenderStatus,
              startedAt: deps.now(),
              endedAt: null,
              error: null,
              phase: 'capture',
              done: 0,
            });
          });
          await execute(record, controller);
        } catch (error) {
          if (current.stopping) {
            // The app is closing: the record stays "running", which the next start resumes.
          } else if (error instanceof RenderCancelledError || controller.signal.aborted) {
            await update(next.id, (j) => {
              Object.assign(j, { status: 'cancelled', phase: null, endedAt: deps.now() });
            }).catch(() => undefined);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            const failed = await update(next.id, (j) => {
              Object.assign(j, {
                status: 'failed',
                phase: null,
                error: message,
                endedAt: deps.now(),
              });
            }).catch(() => null);
            if (failed) {
              deps.notify({
                type: 'render-finished',
                jobId: failed.id,
                videoId: failed.videoId,
                fileName: failed.fileName,
                ok: false,
                error: message,
              });
            }
          }
        } finally {
          running = null;
          if (!current.stopping) kick();
          else wakeIdle();
        }
      })();
    })();
  }

  return {
    async tools() {
      const { tools, ffmpeg, ffprobe } = await resolveTools();
      const codecs = Object.fromEntries(
        CODECS.map((c) => [c, NOT_INSTALLED]),
      ) as RenderToolsView['codecs'];
      if (!tools)
        return { ffmpeg: { found: ffmpeg, version: null }, ffprobe: { found: ffprobe }, codecs };
      try {
        const caps = await capabilitiesOf(tools);
        for (const codec of CODECS) codecs[codec] = codecProblem(codec, caps);
        return { ffmpeg: { found: true, version: caps.version }, ffprobe: { found: true }, codecs };
      } catch (error) {
        const message = `ffmpeg is installed but did not answer: ${error instanceof Error ? error.message : String(error)}`;
        for (const codec of CODECS) codecs[codec] = message;
        return { ffmpeg: { found: true, version: null }, ffprobe: { found: true }, codecs };
      }
    },

    async estimate({ videoId, document, planInputs }) {
      const result = buildRenderPlan(document, {
        runtimeVersion: await deps.runtimeVersion(),
        ...planInputs,
      });
      if (!result.ok) return result;
      const estimate = estimateRender(result.plan);
      const warnings: string[] = [];
      const { folder } = await deps.video(videoId);
      const cache = await deps.cache();
      const cacheFree = await freeBytes(cache.dir);
      if (cacheFree !== null && cacheFree < estimate.cacheBytes) {
        warnings.push(
          `The cache folder may run out of space: this render can use about ${gb(estimate.cacheBytes)} there and ${gb(cacheFree)} is free.`,
        );
      }
      const outFree = await freeBytes(folder);
      if (outFree !== null && outFree < estimate.outputBytes) {
        warnings.push(
          `The video folder may run out of space: the file can be about ${gb(estimate.outputBytes)} and ${gb(outFree)} is free.`,
        );
      }
      return {
        ok: true,
        width: result.plan.width,
        height: result.plan.height,
        frames: result.plan.totalFrames,
        ...estimate,
        warnings,
        fileName: defaultFileName(document),
        extension: containerFor(result.plan.settings.codec),
      };
    },

    async start({ videoId, document, allowedHosts, fileName, planInputs }) {
      if (!deps.host) throw new Error('Rendering is not available here.');
      const result = buildRenderPlan(document, {
        runtimeVersion: await deps.runtimeVersion(),
        ...planInputs,
      });
      if (!result.ok) throw new Error(result.problems.join(' '));
      const { folder, title } = await deps.video(videoId);
      const base = safeFolderName(fileName ?? defaultFileName(document), 'video');
      const ext = containerFor(result.plan.settings.codec);
      const taken = new Set(
        (await store.read()).jobs.filter((j) => !j.output).map((j) => j.target),
      );
      let target = join(folder, 'renders', `${base}.${ext}`);
      for (let n = 2; taken.has(target) || (await exists(target)); n++) {
        target = join(folder, 'renders', `${base} (${n}).${ext}`);
      }
      const record: JobRecord = {
        id: deps.newId(),
        videoId,
        title,
        fileName: target.slice(join(folder, 'renders').length + 1),
        folder,
        target,
        status: 'queued',
        phase: null,
        done: 0,
        total: result.plan.captureFrames,
        plan: result.plan,
        allowedHosts: [...allowedHosts],
        output: null,
        error: null,
        createdAt: deps.now(),
        startedAt: null,
        endedAt: null,
        resumed: false,
        reusedChunks: 0,
        capturedChunks: 0,
        hardware: null,
        nonCommercial: nonCommercialNarration(document.scenario.scenes.map((s) => s.voiceRef)),
      };
      await store.mutate((file) => {
        file.jobs.push(record);
      });
      changed(record);
      kick();
      return view(record);
    },

    async jobs(videoId) {
      const { jobs } = await store.read();
      return jobs
        .filter((j) => !videoId || j.videoId === videoId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(view);
    },

    async cancel(jobId) {
      const found = await job(jobId);
      if (running?.id === jobId) {
        running.controller.abort();
        await running.done;
        return;
      }
      if (found.status === 'queued' || found.status === 'interrupted') {
        await update(jobId, (j) => {
          Object.assign(j, { status: 'cancelled', endedAt: deps.now() });
        });
      }
    },

    async retry(jobId) {
      const found = await job(jobId);
      if (found.status === 'queued' || found.status === 'running' || found.status === 'done') {
        return view(found);
      }
      const record = await update(jobId, (j) => {
        Object.assign(j, {
          status: 'queued',
          error: null,
          endedAt: null,
          resumed: false,
          phase: null,
        });
      });
      kick();
      return view(record);
    },

    async remove(jobId) {
      const found = await job(jobId);
      if (found.status === 'queued' || found.status === 'running') {
        throw new Error('Cancel the render before removing it from the list.');
      }
      await store.mutate((file) => {
        file.jobs = file.jobs.filter((j) => j.id !== jobId);
      });
      changed(found);
    },

    async busy(videoId) {
      const { jobs } = await store.read();
      return jobs.some(
        (j) => j.videoId === videoId && (j.status === 'queued' || j.status === 'running'),
      );
    },

    async resumeAfterStart() {
      const resume = await deps.autoResume();
      const touched: JobRecord[] = [];
      await store.mutate((file) => {
        for (const j of file.jobs) {
          if (j.status !== 'running') continue;
          touched.push(j);
          if (resume) Object.assign(j, { status: 'queued', resumed: true, phase: null });
          else
            Object.assign(j, {
              status: 'interrupted',
              phase: null,
              error: 'Runova stopped during this render. Resume it to carry on where it was.',
            });
        }
      });
      for (const j of touched) {
        changed(j);
        if (resume) {
          deps.notify({
            type: 'render-resumed',
            jobId: j.id,
            videoId: j.videoId,
            fileName: j.fileName,
          });
        }
      }
      kick();
    },

    async shutdown() {
      const current = running;
      if (!current) return;
      current.stopping = true;
      current.controller.abort();
      await Promise.race([current.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    },

    idle() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        if (!running) kick();
      });
    },
  };
}
