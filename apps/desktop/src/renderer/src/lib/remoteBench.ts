import type { QualitySample } from './qualityGovernor';
import { describeEncoderSupport } from './rtcCodecs';

/**
 * Benchmark instrumentation for the remote-desktop pipeline.
 *
 * The transports report their own truth. WebRTC's `getStats()` is the
 * authoritative source for bitrate, framerate and drops, and the main process
 * reports its own CPU/RSS, so a run needs no external profiler. Samples are
 * buffered in a ring and exported as NDJSON.
 *
 * Deliberately inert until `startBenchmark()` is called: an always-on sampler
 * would itself distort the CPU numbers it reports.
 *
 * Drive it from the renderer devtools console:
 *   __runovaBench.start('before-webrtc/video-playback')
 *   … run the workload for 60s …
 *   __runovaBench.stop()      // prints a summary
 *   __runovaBench.export()    // downloads the raw NDJSON
 */

const MAX_SAMPLES = 4000;
const PROCESS_SAMPLE_MS = 1000;

export interface HostBenchSample {
  kind: 'host';
  at: number;
  peerId: string;
  level: string;
  fps: number;
  targetBitrate: number;
  availableBitrate: number | null;
  rttMs: number | null;
  lossRatio: number;
  framesDropped: number;
  limitation: string | null;
  codec: string | null;
  /** Derived from the bytesSent delta between samples. */
  kbps: number;
}

export interface ControllerBenchSample {
  kind: 'controller';
  at: number;
  codec: string | null;
  width: number;
  height: number;
  fps: number;
  framesDropped: number;
  packetsLost: number;
  jitter: number;
  rttMs: number | null;
  kbps: number;
}

export interface ProcessBenchSample {
  kind: 'process';
  at: number;
  /** Main-process CPU percentage, as reported by Electron. */
  mainCpu: number;
  /** Main-process resident set size, bytes. */
  mainMemory: number;
  /** Renderer JS heap, bytes. Chromium-only, absent elsewhere. */
  rendererHeap: number | null;
}

export type BenchSample = HostBenchSample | ControllerBenchSample | ProcessBenchSample;

interface ControllerInput {
  codec: string | null;
  width: number;
  height: number;
  fps: number;
  bytesReceived: number;
  framesDropped: number;
  packetsLost: number;
  jitter: number;
  rttMs: number | null;
}

let running = false;
let label = '';
let startedAt = 0;
let samples: BenchSample[] = [];
let processTimer: number | null = null;
const lastBytes = new Map<string, { bytes: number; at: number }>();

function push(sample: BenchSample): void {
  if (!running) return;
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

/** kbps between this byte counter reading and the previous one. */
function rate(key: string, bytes: number, at: number): number {
  const prev = lastBytes.get(key);
  lastBytes.set(key, { bytes, at });
  if (!prev || at <= prev.at) return 0;
  return Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (at - prev.at)));
}

export function recordHostSample(peerId: string, sample: QualitySample): void {
  if (!running) return;
  const at = Date.now();
  push({
    kind: 'host',
    at,
    peerId,
    level: sample.level,
    fps: sample.framesPerSecond,
    targetBitrate: sample.targetBitrate,
    availableBitrate: sample.availableBitrate,
    rttMs: sample.rttMs,
    lossRatio: sample.lossRatio,
    framesDropped: sample.framesDropped,
    limitation: sample.limitation,
    codec: sample.codec,
    kbps: rate(`host:${peerId}`, sample.bytesSent, at),
  });
}

export function recordControllerSample(input: ControllerInput): void {
  if (!running) return;
  const at = Date.now();
  push({
    kind: 'controller',
    at,
    codec: input.codec,
    width: input.width,
    height: input.height,
    fps: input.fps,
    framesDropped: input.framesDropped,
    packetsLost: input.packetsLost,
    jitter: input.jitter,
    rttMs: input.rttMs,
    kbps: rate('controller', input.bytesReceived, at),
  });
}

async function sampleProcess(): Promise<void> {
  if (!running) return;
  try {
    const main = await window.runova.remote.benchSample();
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    push({
      kind: 'process',
      at: Date.now(),
      mainCpu: main.cpu,
      mainMemory: main.memory,
      rendererHeap: perf.memory?.usedJSHeapSize ?? null,
    });
  } catch {
    // Sampling is best-effort; a missed tick doesn't invalidate the run.
  }
}

export function startBenchmark(runLabel: string): void {
  samples = [];
  lastBytes.clear();
  label = runLabel;
  startedAt = Date.now();
  running = true;
  processTimer = window.setInterval(() => void sampleProcess(), PROCESS_SAMPLE_MS);
  // Which encoders are hardware-backed decides how to read every other number
  // in the run, so it is recorded alongside them.
  void describeEncoderSupport().then((encoders) => {
    // biome-ignore lint/suspicious/noConsole: the console IS this tool's UI
    console.info(`[bench] started "${runLabel}" · encoders: ${encoders}`);
  });
}

export interface BenchSummary {
  label: string;
  durationSec: number;
  sampleCount: number;
  host: Record<string, number | string | null> | null;
  controller: Record<string, number | string | null> | null;
  process: Record<string, number | null> | null;
}

export function stopBenchmark(): BenchSummary {
  running = false;
  if (processTimer !== null) window.clearInterval(processTimer);
  processTimer = null;

  const host = samples.filter((s): s is HostBenchSample => s.kind === 'host');
  const controller = samples.filter((s): s is ControllerBenchSample => s.kind === 'controller');
  const process = samples.filter((s): s is ProcessBenchSample => s.kind === 'process');

  const summary: BenchSummary = {
    label,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    sampleCount: samples.length,
    host: host.length
      ? {
          medianKbps: median(host.map((s) => s.kbps)),
          p95Kbps: percentile(
            host.map((s) => s.kbps),
            95,
          ),
          medianFps: median(host.map((s) => s.fps)),
          medianRttMs: median(host.map((s) => s.rttMs ?? 0)),
          medianLossPct: round(median(host.map((s) => s.lossRatio)) * 100, 2),
          totalFramesDropped: host.reduce((sum, s) => sum + s.framesDropped, 0),
          codec: host[host.length - 1]?.codec ?? null,
          finalLevel: host[host.length - 1]?.level ?? null,
        }
      : null,
    controller: controller.length
      ? {
          medianKbps: median(controller.map((s) => s.kbps)),
          p95Kbps: percentile(
            controller.map((s) => s.kbps),
            95,
          ),
          medianFps: median(controller.map((s) => s.fps)),
          medianRttMs: median(controller.map((s) => s.rttMs ?? 0)),
          resolution: `${controller[controller.length - 1]?.width}x${controller[controller.length - 1]?.height}`,
          totalFramesDropped: controller[controller.length - 1]?.framesDropped ?? 0,
          codec: controller[controller.length - 1]?.codec ?? null,
        }
      : null,
    process: process.length
      ? {
          medianMainCpuPct: round(median(process.map((s) => s.mainCpu)), 2),
          p95MainCpuPct: round(
            percentile(
              process.map((s) => s.mainCpu),
              95,
            ),
            2,
          ),
          medianMainMemoryMb: round(median(process.map((s) => s.mainMemory)) / 1024 / 1024, 1),
          medianRendererHeapMb: round(
            median(process.map((s) => s.rendererHeap ?? 0)) / 1024 / 1024,
            1,
          ),
        }
      : null,
  };
  // biome-ignore lint/suspicious/noConsole: the console IS this tool's UI
  console.info(`[bench] stopped "${label}"`, summary);
  return summary;
}

/** Downloads the raw samples so runs can be diffed outside the app. */
export function exportBenchmark(): void {
  const lines = samples.map((s) => JSON.stringify(s)).join('\n');
  const blob = new Blob([lines], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `runova-bench-${label.replace(/[^\w.-]+/g, '_')}-${startedAt}.ndjson`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

declare global {
  interface Window {
    __runovaBench: {
      start: (label: string) => void;
      stop: () => BenchSummary;
      export: () => void;
    };
  }
}

window.__runovaBench = {
  start: startBenchmark,
  stop: stopBenchmark,
  export: exportBenchmark,
};
