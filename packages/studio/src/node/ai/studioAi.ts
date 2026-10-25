import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffortLevel } from '@agentmat/core';
import { type EditProposal, readEditAnswer } from '../../ai/edit/answer.js';
import {
  buildEditRequest,
  buildRepairRequest,
  buildScenarioRequest,
  POINTER_PROMPT,
  REQUEST_FILE,
} from '../../ai/prompts.js';
import {
  type AnswerRead,
  readScenarioAnswer,
  type ScenarioAnswer,
  scenarioToOps,
} from '../../ai/scenario/answer.js';
import type {
  GenerationAttempt,
  GenerationDetail,
  GenerationParams,
  GenerationStage,
  GenerationView,
  RunSettingsInput,
  StartEditInput,
  StartScenarioInput,
  StudioEvent,
} from '../../api.js';
import { type EditOp, OpError } from '../../document/ops.js';
import { type StudioDocument, UNTITLED_TITLE } from '../../document/schema.js';
import type { EditResult, VideoStore } from '../project/videoStore.js';

/**
 * Studio's AI runs: a scenario from a brief, and scenario edits from typed instructions. Each run
 * is a generation record in the video's history with every attempt's request, answer and log kept
 * as blobs, so any result can be traced back to exactly what produced it. The CLI itself is the
 * host's business (`StudioAiHost`); this file decides what to ask, checks what comes back, and
 * repairs a bad answer by sending the problems back up to twice.
 */

export interface AiRunRequest {
  /** Null runs the app's default CLI. */
  cliId: string | null;
  model: string | null;
  effort: EffortLevel | null;
  /** The run's own work folder, holding `request.md`. */
  cwd: string;
  /** The whole request, for CLIs that read their prompt from stdin. */
  prompt: string;
  /** What CLIs that take the prompt as an argument get instead; they read `request.md`. */
  pointerPrompt: string;
  timeoutMs: number;
}

export interface AiRunResult {
  ok: boolean;
  /** The CLI's answer (stdout). */
  text: string;
  /** Its progress output (stderr). */
  log: string;
  /** The CLI that ran, by name. */
  cliName: string | null;
  error?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface StudioAiHost {
  run(
    request: AiRunRequest,
    signal: AbortSignal,
    onLine: (line: string) => void,
  ): Promise<AiRunResult>;
}

export interface StudioAiDeps {
  ai: StudioAiHost | undefined;
  now: () => number;
  newId: () => string;
  notify: (event: StudioEvent) => void;
  /** The open video's store; throws when the video is not open. */
  store: (videoId: string) => VideoStore;
  /** Called after the AI changed the video, as after any edit. */
  afterEdit: (videoId: string, store: VideoStore) => Promise<void>;
  /** Called when a video's run has ended, however it ended. */
  onIdle?: (videoId: string) => void;
  maxRepairs?: number;
  outputFlushMs?: number;
}

const MINUTE = 60_000;
const BASE_TIMEOUT: Record<GenerationStage, number> = { scenario: 10 * MINUTE, edit: 5 * MINUTE };
const EFFORT_TIME: Record<EffortLevel, number> = { low: 1, medium: 1, high: 1.5, xhigh: 2, max: 3 };
const MAX_LINES_PER_EVENT = 200;
const MAX_LINE_CHARS = 2000;
export const WORK_DIR = 'work';

interface Job {
  generationId: string;
  controller: AbortController;
  /** Why the run was stopped: by the user, or because the video closed. */
  stopped: 'user' | 'closed' | null;
  done: Promise<void>;
}

interface Plan<T> {
  stage: GenerationStage;
  instruction: string;
  params: GenerationParams;
  run: RunSettingsInput;
  parentId: string | null;
  request: (doc: StudioDocument) => string;
  read: (text: string, doc: StudioDocument) => AnswerRead<T>;
  accept: (value: T, store: VideoStore, generationId: string) => Promise<void>;
}

export function createStudioAi(deps: StudioAiDeps) {
  const jobs = new Map<string, Job>();
  const maxRepairs = deps.maxRepairs ?? 2;

  const changed = (videoId: string, generationId: string) =>
    deps.notify({ type: 'generation-changed', videoId, generationId });

  /** Batches a run's output lines so a chatty CLI cannot flood the UI with events. */
  function outputStream(videoId: string, generationId: string) {
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending.length === 0) return;
      const lines = pending.slice(-MAX_LINES_PER_EVENT);
      pending = [];
      deps.notify({ type: 'generation-output', videoId, generationId, lines });
    };
    return {
      push(line: string) {
        pending.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);
        timer ??= setTimeout(flush, deps.outputFlushMs ?? 250);
      },
      flush,
    };
  }

  async function execute<T>(videoId: string, job: Job, plan: Plan<T>): Promise<void> {
    const store = deps.store(videoId);
    const id = job.generationId;
    const ai = deps.ai as StudioAiHost;
    const output = outputStream(videoId, id);
    const workDir = join(store.folder, WORK_DIR, id);
    const attempts: GenerationAttempt[] = [];
    const finish = (patch: Parameters<VideoStore['updateGeneration']>[1]) =>
      store.updateGeneration(id, { ...patch, finishedAt: deps.now() });
    const effort = plan.run.effort ?? null;
    const timeoutMs = BASE_TIMEOUT[plan.stage] * (effort ? EFFORT_TIME[effort] : 1);

    try {
      await mkdir(workDir, { recursive: true });
      const original = plan.request(store.document);
      let request = original;
      for (let round = 0; round <= maxRepairs; round++) {
        await writeFile(join(workDir, REQUEST_FILE), request, 'utf8');
        const attempt: GenerationAttempt = {
          requestHash: await store.blobs.put(request),
          outputHash: null,
          logHash: null,
          startedAt: deps.now(),
          finishedAt: null,
          issues: [],
          error: null,
        };
        attempts.push(attempt);
        store.updateGeneration(id, { attempts });
        changed(videoId, id);

        // A cancel that lands while the request is being written has no run to stop yet.
        const result = job.controller.signal.aborted
          ? { ok: false, text: '', log: '', cliName: null, cancelled: true }
          : await ai.run(
              {
                cliId: plan.run.cliId,
                model: plan.run.model ?? null,
                effort,
                cwd: workDir,
                prompt: request,
                pointerPrompt: POINTER_PROMPT,
                timeoutMs,
              },
              job.controller.signal,
              output.push,
            );
        output.flush();
        attempt.finishedAt = deps.now();
        if (result.text) attempt.outputHash = await store.blobs.put(result.text);
        if (result.log) attempt.logHash = await store.blobs.put(result.log);
        const cliName = result.cliName ?? null;

        if (result.cancelled || job.controller.signal.aborted) {
          finish({
            attempts,
            cliName,
            status: job.stopped === 'closed' ? 'interrupted' : 'cancelled',
          });
          return;
        }
        if (!result.ok) {
          attempt.error = result.error ?? 'The CLI did not answer.';
          finish({ attempts, cliName, status: 'failed', error: attempt.error });
          return;
        }
        const read = plan.read(result.text, store.document);
        if (read.ok) {
          // Everything in the work folder is in the blobs by now.
          await rm(workDir, { recursive: true, force: true });
          store.updateGeneration(id, { attempts, cliName });
          await plan.accept(read.value, store, id);
          return;
        }
        attempt.issues = read.issues;
        if (round === maxRepairs) {
          finish({
            attempts,
            cliName,
            status: 'failed',
            error: `The answer still did not fit after ${maxRepairs} repair rounds: ${read.issues[0]}`,
          });
          return;
        }
        store.updateGeneration(id, { attempts, cliName });
        output.push(`The answer did not fit (${read.issues[0]}). Asking for a fix...`);
        request = buildRepairRequest(original, result.text, read.issues);
      }
    } catch (error) {
      finish({
        attempts,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      output.flush();
    }
  }

  async function start<T>(videoId: string, plan: Plan<T>): Promise<GenerationView> {
    const store = deps.store(videoId);
    if (!deps.ai) throw new Error('This copy of Studio cannot run AI CLIs.');
    const busy = jobs.get(videoId);
    if (busy) {
      // A run records its outcome a moment before it lets go of the video; only a live one blocks.
      if (store.generation(busy.generationId)?.status === 'running') {
        throw new Error('An AI run is already working on this video. Wait for it or cancel it.');
      }
      await busy.done;
    }
    const id = deps.newId();
    store.addGeneration({
      id,
      parentId: plan.parentId,
      stage: plan.stage,
      status: 'running',
      cliId: plan.run.cliId,
      cliName: null,
      model: plan.run.model ?? null,
      effort: plan.run.effort ?? null,
      instruction: plan.instruction,
      params: plan.params,
      startedAt: deps.now(),
    });
    const job: Job = {
      generationId: id,
      controller: new AbortController(),
      stopped: null,
      done: Promise.resolve(),
    };
    jobs.set(videoId, job);
    // execute() records its own failures; a store closed under it (a crash) has nowhere to write.
    job.done = execute(videoId, job, plan)
      .catch(() => undefined)
      .finally(() => {
        jobs.delete(videoId);
        changed(videoId, id);
        deps.onIdle?.(videoId);
      });
    changed(videoId, id);
    return store.generation(id) as GenerationView;
  }

  function scenarioPlan(
    input: Omit<StartScenarioInput, 'videoId'>,
    parentId: string | null,
  ): Plan<ScenarioAnswer> {
    return {
      stage: 'scenario',
      instruction: input.brief,
      params: { targetSeconds: input.targetSeconds, styleId: input.styleId },
      run: input.run,
      parentId,
      request: (doc) =>
        buildScenarioRequest({
          brief: input.brief,
          document: doc,
          targetSeconds: input.targetSeconds,
          styleId: input.styleId,
        }),
      read: (text, doc) => readScenarioAnswer(text, doc.language),
      accept: async (answer, store, generationId) => {
        const doc = store.document;
        const ops: EditOp[] = [];
        if (input.styleId !== null && input.styleId !== doc.styleId) {
          ops.push({ op: 'doc.set', field: 'styleId', value: input.styleId });
        }
        ops.push(
          ...scenarioToOps(doc, answer, deps.newId, { keepTitle: doc.title !== UNTITLED_TITLE }),
        );
        const result = store.apply({
          baseSeq: store.seq,
          ops,
          label: 'AI wrote the scenario',
          actor: 'ai',
          generationId,
        });
        store.updateGeneration(generationId, {
          status: 'done',
          resultSeq: result.seq,
          finishedAt: deps.now(),
        });
        await deps.afterEdit(store.manifest.id, store);
      },
    };
  }

  function editPlan(
    input: Omit<StartEditInput, 'videoId'>,
    parentId: string | null,
  ): Plan<EditProposal> {
    return {
      stage: 'edit',
      instruction: input.instruction,
      params: {},
      run: input.run,
      parentId,
      request: (doc) => buildEditRequest({ instruction: input.instruction, document: doc }),
      read: (text, doc) => readEditAnswer(text, doc, deps.newId),
      accept: async (proposal, store, generationId) => {
        store.updateGeneration(generationId, {
          status: 'proposed',
          proposal: { ...proposal, baseSeq: store.seq },
          finishedAt: deps.now(),
        });
      },
    };
  }

  function proposed(videoId: string, generationId: string) {
    const store = deps.store(videoId);
    const generation = store.generation(generationId);
    if (generation?.status !== 'proposed' || !generation.proposal) {
      throw new Error('That proposal is no longer waiting to be applied.');
    }
    return { store, generation, proposal: generation.proposal };
  }

  async function stop(videoId: string, reason: 'user' | 'closed'): Promise<void> {
    const job = jobs.get(videoId);
    if (!job) return;
    job.stopped = reason;
    job.controller.abort();
    await job.done;
  }

  return {
    startScenario: ({ videoId, ...input }: StartScenarioInput) =>
      start(videoId, scenarioPlan(input, null)),

    startEdit: ({ videoId, ...input }: StartEditInput) => start(videoId, editPlan(input, null)),

    /** Runs a finished generation again with the same request and AI picks, as a new record. */
    async retry({ videoId, generationId }: { videoId: string; generationId: string }) {
      const old = deps.store(videoId).generation(generationId);
      if (!old) throw new Error('That AI run is not in this video.');
      if (old.status === 'running') throw new Error('That AI run is still working.');
      const run = { cliId: old.cliId, model: old.model, effort: old.effort };
      if (old.stage === 'edit')
        return start(videoId, editPlan({ instruction: old.instruction, run }, old.id));
      return start(
        videoId,
        scenarioPlan(
          {
            brief: old.instruction,
            targetSeconds: old.params.targetSeconds ?? 60,
            styleId: old.params.styleId ?? null,
            run,
          },
          old.id,
        ),
      );
    },

    async cancel({ videoId, generationId }: { videoId: string; generationId: string }) {
      if (jobs.get(videoId)?.generationId === generationId) await stop(videoId, 'user');
    },

    /** Stops the video's run before the video closes; it is recorded as interrupted. */
    stopForClose: (videoId: string) => stop(videoId, 'closed'),

    isRunning: (videoId: string) => jobs.has(videoId),

    generations: ({ videoId, limit }: { videoId: string; limit: number }) =>
      deps.store(videoId).generations({ limit }),

    async detail({
      videoId,
      generationId,
    }: {
      videoId: string;
      generationId: string;
    }): Promise<GenerationDetail> {
      const store = deps.store(videoId);
      const generation = store.generation(generationId);
      if (!generation) throw new Error('That AI run is not in this video.');
      const read = (hash: string | null) => (hash ? store.blobs.text(hash) : Promise.resolve(null));
      const texts = await Promise.all(
        generation.attempts.map(async (a) => ({
          request: await store.blobs.text(a.requestHash),
          output: await read(a.outputHash),
          log: await read(a.logHash),
        })),
      );
      return { ...generation, texts };
    },

    async applyProposal({
      videoId,
      generationId,
    }: {
      videoId: string;
      generationId: string;
    }): Promise<EditResult> {
      const { store, proposal } = proposed(videoId, generationId);
      let result: EditResult;
      try {
        result = store.apply({
          baseSeq: store.seq,
          ops: proposal.ops,
          label: `AI: ${proposal.summary}`.slice(0, 300),
          actor: 'ai',
          generationId,
        });
      } catch (error) {
        if (error instanceof OpError) {
          throw new Error(
            'The scenario changed since this was proposed, so it no longer fits. Ask again.',
          );
        }
        throw error;
      }
      store.updateGeneration(generationId, { status: 'applied', resultSeq: result.seq });
      await deps.afterEdit(videoId, store);
      changed(videoId, generationId);
      return result;
    },

    async discardProposal({ videoId, generationId }: { videoId: string; generationId: string }) {
      const { store } = proposed(videoId, generationId);
      store.updateGeneration(generationId, { status: 'discarded' });
      changed(videoId, generationId);
    },

    async shutdown() {
      await Promise.all([...jobs.keys()].map((videoId) => stop(videoId, 'closed')));
    },

    /** Forgets a video's run without waiting, as a crash would. Tests only. */
    abandonForTest(videoId: string) {
      const job = jobs.get(videoId);
      if (!job) return;
      jobs.delete(videoId);
      job.stopped = 'closed';
    },
  };
}

export type StudioAi = ReturnType<typeof createStudioAi>;
