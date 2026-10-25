import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  assemblyArgs,
  assemblyGraph,
  chunkArgs,
  type FfmpegCapabilities,
} from '../../render/ffmpeg.js';
import type { PlannedScene, RenderPlan } from '../../render/plan.js';
import { sceneUrl } from '../../scenes/url.js';
import type { SceneFrame, SceneFrameSource } from '../scenes/check.js';
import {
  countFrames,
  FfmpegError,
  type FfmpegTools,
  probeVideo,
  RenderCancelledError,
  startTool,
} from './ffmpegTool.js';

/**
 * One render, start to finish: capture each scene's frames into lossless chunks, then join the
 * scenes into the finished file. Chunks are kept in the cache under a key made from everything
 * that shows in their frames, so a resumed render, or a render after changing one scene, captures
 * only what it does not already have. A chunk is renamed into place only after its frames are
 * counted, so a chunk file that exists is a whole one.
 */

export interface RenderFrameHost {
  /** A scene window that draws at the output size. */
  open(input: {
    width: number;
    height: number;
    scale: number;
    allowedHosts: readonly string[];
  }): SceneFrameSource;
  /** What the scene windows use now, in bytes, if the host can tell. */
  memoryBytes?(): Promise<number>;
}

export type RenderPhase = 'capture' | 'encode';

export interface RenderProgress {
  phase: RenderPhase;
  /** Frames captured (or found in the cache) so far, then frames encoded. */
  done: number;
  total: number;
}

export interface RenderJobInput {
  plan: RenderPlan;
  tools: FfmpegTools;
  capabilities: FfmpegCapabilities;
  /** A hardware encoder that passed a test encode, or null for the software one. */
  hardware: string | null;
  frames: RenderFrameHost;
  allowedHosts: readonly string[];
  /** This video's chunk cache (`<cache>/<videoId>/scenes`). */
  cacheDir: string;
  /** Scratch files for this render: concat lists, the graph. */
  workDir: string;
  /** The finished file. Written beside itself first, renamed when checked. */
  output: string;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  /** Open a fresh scene window after this many chunks, so a leaking scene cannot grow forever. */
  recycleEveryChunks?: number;
  /** Open a fresh window when the scene windows use more than this. */
  memoryCapBytes?: number;
  readyTimeoutMs?: number;
}

export interface RenderJobResult {
  output: string;
  frames: number;
  capturedChunks: number;
  reusedChunks: number;
  /** Times a scene window was replaced for using too much memory. */
  recycledForMemory: number;
}

/** The folder a scene's chunks live in, named from what shows in them. */
export function sceneCacheDir(cacheDir: string, scene: PlannedScene): string {
  return join(cacheDir, createHash('sha256').update(scene.cacheInputs).digest('hex').slice(0, 40));
}

export function chunkFile(dir: string, index: number): string {
  return join(dir, `chunk-${String(index).padStart(4, '0')}.mkv`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

type Exit = { ok: true } | { ok: false; error: unknown };

/** Throws what ffmpeg's exit says, after its input closed under us. */
async function failedExit(exited: Promise<Exit>): Promise<never> {
  const result = await exited;
  throw result.ok ? new Error('ffmpeg stopped reading frames.') : result.error;
}

export interface WriteChunkInput {
  tools: FfmpegTools;
  output: string;
  width: number;
  height: number;
  fps: number;
  count: number;
  /** The chunk's frame `i`, 0-based. */
  frame(i: number): Promise<SceneFrame>;
  signal?: AbortSignal;
}

/**
 * Pipes `count` frames into ffmpeg as one lossless chunk. A frame is asked for only when ffmpeg
 * has taken the one before, so memory stays at a frame or two however long the scene is.
 */
export async function writeChunk(input: WriteChunkInput): Promise<void> {
  throwIfCancelled(input.signal);
  await mkdir(dirname(input.output), { recursive: true });
  const temp = `${input.output.slice(0, -extname(input.output).length)}.part.mkv`;
  const first = await input.frame(0);
  const run = startTool(
    input.tools.ffmpeg,
    chunkArgs({
      width: input.width,
      height: input.height,
      input: { width: first.width, height: first.height },
      fps: input.fps,
      output: temp,
    }),
    { stdin: true, signal: input.signal },
  );
  const stdin = run.stdin;
  if (!stdin) throw new Error('ffmpeg has no input.');
  // A failure while writing is reported by `done`, which says what ffmpeg printed.
  const exited: Promise<Exit> = run.done.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    for (let i = 0; i < input.count; i++) {
      throwIfCancelled(input.signal);
      const frame = i === 0 ? first : await input.frame(i);
      if (frame.width !== first.width || frame.height !== first.height) {
        throw new Error(
          `The scene window changed size mid-chunk (${first.width}x${first.height} to ${frame.width}x${frame.height}).`,
        );
      }
      // Once ffmpeg has gone, its pipe only says "EOF" or "EPIPE"; how ffmpeg exited says why.
      if (stdin.destroyed) await failedExit(exited);
      if (!stdin.write(frame.bitmap)) {
        const result = await Promise.race([
          once(stdin, 'drain').then(
            () => null,
            () => null,
          ),
          exited,
        ]);
        if (result && !result.ok) throw result.error;
        if (stdin.destroyed) await failedExit(exited);
      }
    }
    stdin.end();
    const result = await exited;
    if (!result.ok) throw result.error;
    await fsyncFile(temp);
    const frames = await countFrames(input.tools, temp);
    if (frames !== input.count) {
      throw new FfmpegError(
        `A chunk came out with ${frames} frames instead of ${input.count}.`,
        '',
        0,
      );
    }
    await rename(temp, input.output);
  } catch (error) {
    run.kill();
    await exited;
    await rm(temp, { force: true });
    throw input.signal?.aborted ? new RenderCancelledError() : error;
  }
}

/** A concat demuxer list. Paths are quoted, with any quote in them escaped as the demuxer reads it. */
export function concatList(files: readonly string[]): string {
  return `${files.map((f) => `file '${f.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}

export async function runRenderJob(input: RenderJobInput): Promise<RenderJobResult> {
  const { plan, signal } = input;
  const recycleEvery = input.recycleEveryChunks ?? 15;
  const total = plan.captureFrames;
  let done = 0;
  let capturedChunks = 0;
  let reusedChunks = 0;
  let recycledForMemory = 0;
  const report = (phase: RenderPhase, value: number, of: number) =>
    input.onProgress?.({ phase, done: value, total: of });

  const sceneLists: string[] = [];
  await mkdir(input.workDir, { recursive: true });
  for (const scene of plan.scenes) {
    const dir = sceneCacheDir(input.cacheDir, scene);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'inputs.json'), scene.cacheInputs);
    const files: string[] = [];
    let source: SceneFrameSource | null = null;
    let chunksSinceOpen = 0;
    const closeSource = async () => {
      const open = source;
      source = null;
      chunksSinceOpen = 0;
      await open?.close().catch(() => undefined);
    };
    try {
      for (const chunk of scene.chunks) {
        throwIfCancelled(signal);
        const file = chunkFile(dir, chunk.index);
        files.push(file);
        if (await exists(file)) {
          reusedChunks += 1;
          done += chunk.count;
          report('capture', done, total);
          continue;
        }
        if (!source) {
          source = input.frames.open({
            width: plan.design.width,
            height: plan.design.height,
            scale: plan.scale,
            allowedHosts: input.allowedHosts,
          });
          await source.open(sceneUrl(scene.treeHash, scene.config));
          if (!(await source.waitReady(input.readyTimeoutMs ?? 15_000))) {
            throw new Error(
              `Scene ${scene.position} did not get ready to draw. Check it in the scene panel.`,
            );
          }
          // The first frame a page draws can lag behind what it was asked for; it is thrown away.
          await source.frame(chunk.from / plan.fps);
        }
        const open: SceneFrameSource = source;
        const before = done;
        await writeChunk({
          tools: input.tools,
          output: file,
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          count: chunk.count,
          signal,
          frame: async (i) => {
            const frame = await open.frame((chunk.from + i) / plan.fps);
            done = before + i + 1;
            report('capture', done, total);
            return frame;
          },
        });
        capturedChunks += 1;
        chunksSinceOpen += 1;
        const overCap =
          input.memoryCapBytes !== undefined &&
          input.frames.memoryBytes !== undefined &&
          (await input.frames.memoryBytes()) > input.memoryCapBytes;
        if (overCap) recycledForMemory += 1;
        if (overCap || chunksSinceOpen >= recycleEvery) await closeSource();
      }
    } catch (error) {
      const problems = source ? (source as SceneFrameSource).problems() : [];
      await closeSource();
      if (error instanceof RenderCancelledError || signal?.aborted)
        throw new RenderCancelledError();
      const detail = problems.length ? ` ${problems.join(' ')}` : '';
      throw new Error(
        `Scene ${scene.position} could not be drawn: ${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }
    await closeSource();
    const list = join(input.workDir, `scene-${scene.position}.txt`);
    await writeFile(list, concatList(files));
    sceneLists.push(list);
  }

  throwIfCancelled(signal);
  const graphFile = join(input.workDir, 'graph.txt');
  await writeFile(graphFile, assemblyGraph(plan));
  const ext = extname(input.output);
  const temp = `${input.output.slice(0, -ext.length)}.part${ext}`;
  await mkdir(dirname(input.output), { recursive: true });
  report('encode', 0, plan.totalFrames);
  try {
    await startTool(
      input.tools.ffmpeg,
      assemblyArgs({
        plan,
        sceneLists,
        graphFile,
        output: temp,
        version: input.capabilities.version,
        hardware: input.hardware,
      }),
      {
        signal,
        onProgress: (p) => {
          if (p.frame !== null)
            report('encode', Math.min(p.frame, plan.totalFrames), plan.totalFrames);
        },
      },
    ).done;
    const facts = await probeVideo(input.tools, temp);
    const problems: string[] = [];
    if (Math.abs(facts.frames - plan.totalFrames) > 1)
      problems.push(`${facts.frames} frames instead of ${plan.totalFrames}`);
    if (facts.width !== plan.width || facts.height !== plan.height)
      problems.push(`${facts.width}x${facts.height} instead of ${plan.width}x${plan.height}`);
    if (!facts.audioCodec) problems.push('no sound track');
    if (problems.length)
      throw new Error(`The finished file came out wrong: ${problems.join(', ')}.`);
    await fsyncFile(temp);
    await rename(temp, input.output);
  } catch (error) {
    await rm(temp, { force: true });
    throw signal?.aborted ? new RenderCancelledError() : error;
  }
  report('encode', plan.totalFrames, plan.totalFrames);
  await rm(input.workDir, { recursive: true, force: true });
  return {
    output: input.output,
    frames: plan.totalFrames,
    capturedChunks,
    reusedChunks,
    recycledForMemory,
  };
}
