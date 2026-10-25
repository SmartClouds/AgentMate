import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STUDIO_TTS } from '@agentmat/core';
import type { NarrationJobView, StudioEvent } from '../../api.js';
import { applyOps, type EditOp } from '../../document/ops.js';
import type { StudioDocument } from '../../document/schema.js';
import { flicksToSeconds, samplesToFlicks } from '../../time/flicks.js';
import { splitCaptions } from '../../timeline/captions.js';
import { overlapsOnTrack, sceneBlocks, trackFor } from '../../timeline/layout.js';
import {
  captionClipsFromTimes,
  narratedLength,
  narrationClip,
  narrationClipId,
} from '../../timeline/narration.js';
import { speechChunks, timeLines, type WordTiming, wordsByLength } from '../../voice/text.js';
import {
  formatVoiceRef,
  parseVoiceRef,
  RECORDED_VOICE,
  type VoiceRef,
} from '../../voice/voices.js';
import { parseWav } from '../../voice/wav.js';
import type { VideoStore } from '../project/videoStore.js';
import { type FfmpegTools, runTool } from '../render/ffmpegTool.js';
import { concatList } from '../render/renderJob.js';
import { type EngineKeys, speak, TtsError } from './engines.js';

/**
 * Narration for a video's scenes. Each scene's text is cut into pieces and spoken by the chosen
 * engine; every finished piece is kept in the cache under what it is (engine, voice, model, text),
 * so a run cut short by a crash, a cancel or a restart speaks only what is still missing. The
 * pieces are joined at 48 kHz mono, stored in the video, and placed on the voice track in one edit
 * that also fits the scene to the voice when the scene follows its narration.
 */

export interface NarratorDeps {
  tools(): Promise<FfmpegTools | null>;
  keys(): Promise<EngineKeys>;
  fetch: typeof fetch;
  /** Sends every engine's requests here instead (the e2e fake servers). */
  baseUrl?: string;
  /** This video's narration cache folder. */
  cacheDir(videoId: string): Promise<string>;
  /** The open video's store; throws when the video is not open. */
  store(videoId: string): VideoStore;
  afterEdit(videoId: string, store: VideoStore): Promise<void>;
  notify(event: StudioEvent): void;
  newId(): string;
  now(): number;
  /** Waits between tries after a rate limit or a server error. */
  retryDelaysMs?: readonly number[];
}

export interface Narrator {
  speak(input: { videoId: string; sceneIds: string[]; voiceRef: string }): NarrationJobView;
  jobs(videoId: string): NarrationJobView[];
  cancel(videoId: string, jobId: string): void;
  /** Puts a recording (any format ffmpeg reads) on a scene as its narration. */
  placeRecording(input: {
    videoId: string;
    sceneId: string;
    file: string;
  }): Promise<StudioDocument>;
  /** Captions for a scene from its narration, timed by the voice when there is one. */
  captionScene(input: { videoId: string; sceneId: string }): Promise<StudioDocument>;
  /** Resolves when the video's run has ended (closing a video waits for it). */
  idle(videoId: string): Promise<void>;
  shutdown(): Promise<void>;
}

const NARRATION_RATE = 48_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class Cancelled extends Error {}

export function createNarrator(deps: NarratorDeps): Narrator {
  const jobs = new Map<string, NarrationJobView[]>();
  const running = new Map<
    string,
    { job: NarrationJobView; controller: AbortController; done: Promise<void> }
  >();
  const delays = deps.retryDelaysMs ?? [1000, 4000, 10_000];

  const changed = (job: NarrationJobView) =>
    deps.notify({ type: 'narration-changed', videoId: job.videoId, jobId: job.id });

  async function requireTools(): Promise<FfmpegTools> {
    const tools = await deps.tools();
    if (!tools)
      throw new Error(
        'Narration needs ffmpeg, which is not installed yet. Install it from Agent Tools, Dev Setup (Studio).',
      );
    return tools;
  }

  /** One piece, spoken now or found already spoken; retried after a rate limit or server error. */
  async function piece(
    dir: string,
    ref: VoiceRef,
    text: string,
    lang: string,
    keys: EngineKeys,
    signal: AbortSignal,
  ) {
    const model = STUDIO_TTS[ref.engine].model ?? '';
    const key = createHash('sha256')
      .update(JSON.stringify([ref.engine, ref.voice, model, lang, text]))
      .digest('hex')
      .slice(0, 40);
    const wav = join(dir, `${key}.wav`);
    const wordsFile = join(dir, `${key}.words.json`);
    if (await exists(wav)) {
      const words = (await exists(wordsFile))
        ? (JSON.parse(await readFile(wordsFile, 'utf8')) as WordTiming[])
        : null;
      return { wav, words, reused: true };
    }
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new Cancelled();
      try {
        const spoken = await speak({
          engine: ref.engine,
          voice: ref.voice,
          text,
          lang,
          keys,
          fetch: deps.fetch,
          signal,
          baseUrl: deps.baseUrl,
        });
        if (spoken.words) await writeFile(wordsFile, JSON.stringify(spoken.words));
        const temp = `${wav}.part`;
        await writeFile(temp, spoken.wav);
        await rename(temp, wav);
        return { wav, words: spoken.words, reused: false };
      } catch (error) {
        if (signal.aborted) throw new Cancelled();
        const delay = delays[attempt];
        if (!(error instanceof TtsError) || !error.retryable || delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** The pieces joined into one 48 kHz mono WAV, with the words of each piece moved to its place. */
  async function join_(
    tools: FfmpegTools,
    dir: string,
    pieces: { wav: string; words: WordTiming[] | null; text: string }[],
    out: string,
  ) {
    const list = join(dir, `join-${deps.newId()}.txt`);
    await writeFile(list, concatList(pieces.map((p) => p.wav)));
    try {
      await runTool(tools.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-ar',
        String(NARRATION_RATE),
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        out,
      ]);
    } finally {
      await rm(list, { force: true });
    }
    const words: WordTiming[] = [];
    let offset = 0;
    for (const p of pieces) {
      const seconds = parseWav(await readFile(p.wav)).seconds;
      const own = p.words ?? wordsByLength(p.text, seconds);
      words.push(...own.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })));
      offset += seconds;
    }
    return words;
  }

  /**
   * Stores a 48 kHz WAV in the video and puts it on the scene as its narration: one edit that
   * replaces the scene's earlier narration, fits the scene to it when it follows its narration,
   * and places the clip at the scene's start.
   */
  async function place(
    videoId: string,
    sceneId: string,
    wavFile: string,
    words: WordTiming[],
    voiceRef: string,
    name: string,
  ) {
    const store = deps.store(videoId);
    const info = parseWav(await readFile(wavFile));
    const length = samplesToFlicks(info.frames, info.sampleRate);
    const { hash, bytes } = await store.blobs.putFile(wavFile);
    store.addMedia({
      hash,
      name,
      kind: 'audio',
      info: {
        duration: length,
        width: null,
        height: null,
        fps: null,
        hasAudio: true,
        hasVideo: false,
      },
      bytes,
      importedAt: deps.now(),
    });
    store.setNarrationWords(hash, await store.blobs.put(JSON.stringify(words)));
    const doc = store.document;
    const index = doc.scenario.scenes.findIndex((s) => s.id === sceneId);
    const scene = doc.scenario.scenes[index];
    if (!scene) throw new Error('That scene is not in the video any more.');
    const voiceTrack = trackFor(doc, 'voice');
    if (!voiceTrack) throw new Error('The video has no voice track.');
    const ops: EditOp[] = [];
    const earlier = narrationClip(doc, sceneId);
    if (earlier) ops.push({ op: 'clip.remove', clipId: earlier.id });
    const patch: { voiceRef: string; targetDuration?: number } = { voiceRef };
    if (scene.timing === 'narration')
      patch.targetDuration = narratedLength(info.seconds, doc.renderSettings.fps);
    ops.push({ op: 'scene.update', sceneId, patch });
    const fitted = applyOps(doc, ops).document;
    const start = sceneBlocks(fitted).find((b) => b.sceneId === sceneId)?.start ?? 0;
    ops.push({
      op: 'clip.add',
      clip: {
        id: narrationClipId(sceneId, 'voice', deps.newId()),
        trackId: voiceTrack.id,
        start,
        duration: length,
        source: { type: 'media', hash, in: 0, out: length },
        transitionIn: null,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
      },
    });
    const result = store.apply({
      baseSeq: store.seq,
      ops,
      label: `Narrated scene ${index + 1}`,
      actor: 'system',
    });
    await deps.afterEdit(videoId, store);
    return result.document;
  }

  async function run(job: NarrationJobView, ref: VoiceRef, signal: AbortSignal) {
    const tools = await requireTools();
    const keys = await deps.keys();
    const dir = await deps.cacheDir(job.videoId);
    await mkdir(dir, { recursive: true });
    const doc = deps.store(job.videoId).document;
    const plans = job.sceneIds.map((sceneId) => {
      const scene = doc.scenario.scenes.find((s) => s.id === sceneId);
      return {
        sceneId,
        text: scene?.narration.trim() ?? '',
        position: doc.scenario.scenes.findIndex((s) => s.id === sceneId) + 1,
      };
    });
    job.skipped = plans.filter((p) => !p.text).map((p) => p.sceneId);
    const chunked = plans
      .filter((p) => p.text)
      .map((p) => ({ ...p, chunks: speechChunks(p.text, doc.language) }));
    job.total = chunked.reduce((sum, p) => sum + p.chunks.length, 0);
    changed(job);
    for (const plan of chunked) {
      job.sceneId = plan.sceneId;
      const pieces: { wav: string; words: WordTiming[] | null; text: string }[] = [];
      for (const text of plan.chunks) {
        const spoken = await piece(dir, ref, text, doc.language, keys, signal);
        pieces.push({ ...spoken, text });
        job.done += 1;
        if (spoken.reused) job.reused += 1;
        changed(job);
      }
      if (signal.aborted) throw new Cancelled();
      const out = join(dir, `scene-${deps.newId()}.wav`);
      try {
        const words = await join_(tools, dir, pieces, out);
        await place(
          job.videoId,
          plan.sceneId,
          out,
          words,
          formatVoiceRef(ref),
          `Narration, scene ${plan.position}.wav`,
        );
      } finally {
        await rm(out, { force: true });
      }
    }
  }

  return {
    speak({ videoId, sceneIds, voiceRef }) {
      const ref = parseVoiceRef(voiceRef);
      if (!ref) throw new Error('Pick one of the offered voices.');
      if (running.has(videoId))
        throw new Error('This video is already being narrated. Wait for it, or cancel it.');
      deps.store(videoId);
      const job: NarrationJobView = {
        id: deps.newId(),
        videoId,
        voiceRef,
        sceneIds: [...sceneIds],
        status: 'running',
        done: 0,
        total: 0,
        sceneId: null,
        skipped: [],
        reused: 0,
        error: null,
        startedAt: deps.now(),
        endedAt: null,
      };
      jobs.set(videoId, [job, ...(jobs.get(videoId) ?? [])]);
      const controller = new AbortController();
      const done = run(job, ref, controller.signal)
        .then(() => {
          job.status = 'done';
        })
        .catch((error: unknown) => {
          job.status =
            error instanceof Cancelled || controller.signal.aborted ? 'cancelled' : 'failed';
          if (job.status === 'failed')
            job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.sceneId = null;
          job.endedAt = deps.now();
          running.delete(videoId);
          changed(job);
        });
      running.set(videoId, { job, controller, done });
      return { ...job };
    },

    jobs(videoId) {
      return (jobs.get(videoId) ?? []).map((j) => ({
        ...j,
        sceneIds: [...j.sceneIds],
        skipped: [...j.skipped],
      }));
    },

    cancel(videoId, jobId) {
      const current = running.get(videoId);
      if (current?.job.id === jobId) current.controller.abort();
    },

    async placeRecording({ videoId, sceneId, file }) {
      const tools = await requireTools();
      const store = deps.store(videoId);
      const scene = store.document.scenario.scenes.find((s) => s.id === sceneId);
      if (!scene) throw new Error('That scene is not in the video any more.');
      const dir = await deps.cacheDir(videoId);
      await mkdir(dir, { recursive: true });
      const out = join(dir, `recording-${deps.newId()}.wav`);
      try {
        await runTool(tools.ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          file,
          '-vn',
          '-ar',
          String(NARRATION_RATE),
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          out,
        ]);
        const seconds = parseWav(await readFile(out)).seconds;
        const position = store.document.scenario.scenes.indexOf(scene) + 1;
        return await place(
          videoId,
          sceneId,
          out,
          wordsByLength(scene.narration, seconds),
          RECORDED_VOICE,
          `Recording, scene ${position}.wav`,
        );
      } finally {
        await rm(out, { force: true });
      }
    },

    async captionScene({ videoId, sceneId }) {
      const store = deps.store(videoId);
      const doc = store.document;
      const index = doc.scenario.scenes.findIndex((s) => s.id === sceneId);
      const scene = doc.scenario.scenes[index];
      const block = sceneBlocks(doc).find((b) => b.sceneId === sceneId);
      const textTrack = trackFor(doc, 'text');
      if (!scene || !block || !textTrack)
        throw new Error('That scene is not in the video any more.');
      const lines = splitCaptions(scene.narration, doc.language);
      if (lines.length === 0) throw new Error(`Scene ${index + 1} has no narration to caption.`);
      if (overlapsOnTrack(doc, textTrack.id, block.start, block.duration)) {
        throw new Error(`There are captions over scene ${index + 1} already; remove them first.`);
      }
      const voice = narrationClip(doc, sceneId);
      const wordsHash =
        voice?.source.type === 'media' ? store.narrationWords(voice.source.hash) : null;
      const words = wordsHash
        ? (JSON.parse(await store.blobs.text(wordsHash)) as WordTiming[])
        : null;
      const seconds = flicksToSeconds(block.duration);
      const timed = timeLines(lines, words ?? wordsByLength(lines.join(' '), seconds));
      const clips = captionClipsFromTimes({
        lines: timed,
        lang: doc.language,
        sceneId,
        sceneStart: voice?.start ?? block.start,
        trackId: textTrack.id,
        fps: doc.renderSettings.fps,
        newId: deps.newId,
      });
      const result = store.apply({
        baseSeq: store.seq,
        ops: clips.map((clip) => ({ op: 'clip.add', clip })),
        label: words
          ? `Captioned scene ${index + 1} from its voice`
          : `Captioned scene ${index + 1}`,
      });
      await deps.afterEdit(videoId, store);
      return result.document;
    },

    async idle(videoId) {
      await running.get(videoId)?.done;
    },

    async shutdown() {
      for (const { controller } of running.values()) controller.abort();
      await Promise.all([...running.values()].map((r) => r.done));
    },
  };
}
