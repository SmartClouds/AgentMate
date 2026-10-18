import type { SpeechModelProgress, TranscribeAudioResult } from '../../shared/apiTypes';
import type { HostProcess } from '../apiClient/hostClient';
import { type MainToHost, parseHostMessage, type SpeechJobInput } from './speechHostProtocol';

/**
 * Main's side of the utility process that runs Whisper. The model loads and decodes
 * synchronously, for minutes on the large one, and in main that froze every window until it was
 * done ("Not Responding"). In a process of its own it can take as long as it likes, and main
 * stays in charge: a host that crashes, or goes quiet for far longer than the recording could
 * need, fails that one recording and is replaced, and the app never waits on it.
 *
 * The host is started on the first recording, shared by every one after that, and stopped once
 * nothing has used it for a while, which also gives back the gigabyte the large model holds.
 */

export interface SpeechHostOptions {
  spawn: () => HostProcess;
  onProgress: (progress: SpeechModelProgress) => void;
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** How long a recording may go without a word from the host before it is given up on. */
  deadlineMs?: (input: SpeechJobInput) => number;
}

export interface SpeechHost {
  transcribe(jobId: string, input: SpeechJobInput): Promise<TranscribeAudioResult>;
  /** Drops a recording. One the host is working on right now stops the host, freeing the CPU. */
  cancel(jobId: string): void;
  /** Whether the host has this model in memory, so the next recording skips loading it. */
  isModelLoaded(hubId: string): boolean;
  shutdown(): void;
}

interface Job {
  jobId: string;
  input: SpeechJobInput;
  resolve: (result: TranscribeAudioResult) => void;
  sent: boolean;
}

const READY_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const SAMPLE_RATE = 16_000;

/**
 * Loading the large model alone can take a minute on a busy machine, and decoding runs at around
 * two seconds per second of speech on a laptop CPU. Five times that leaves room for slower ones.
 * Download progress resets the clock, so a slow first download is never cut off by it.
 */
export function defaultDeadlineMs(input: SpeechJobInput): number {
  const seconds = input.samples.length / SAMPLE_RATE;
  return 3 * 60_000 + Math.ceil(seconds * 10_000);
}

export const SPEECH_TIMEOUT_MESSAGE =
  'Transcription took too long and was stopped. Try a shorter recording, or a smaller speech model in Settings.';
export const SPEECH_CRASH_MESSAGE = 'The speech engine stopped unexpectedly. Try again.';
export const SPEECH_START_MESSAGE = 'The speech engine did not start. Try again.';
export const SPEECH_CANCELLED_MESSAGE = 'Transcription cancelled.';

function failed(error: string): TranscribeAudioResult {
  return { ok: false, text: '', error };
}

export function createSpeechHost(options: SpeechHostOptions): SpeechHost {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;

  let host: HostProcess | null = null;
  let ready = false;
  let loadedModelId: string | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const jobs = new Map<string, Job>();

  /** The host works through recordings in the order they were sent, so this is the busy one. */
  function inFlight(): Job | undefined {
    for (const job of jobs.values()) if (job.sent) return job;
    return undefined;
  }

  function settle(jobId: string, result: TranscribeAudioResult): void {
    const job = jobs.get(jobId);
    if (!job) return;
    jobs.delete(jobId);
    job.resolve(result);
  }

  function send(message: MainToHost): void {
    host?.postMessage(message);
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }

  /** Restarts the clock on the recording the host is busy with, or stops it when there is none. */
  function armWatchdog(): void {
    watchdog = clearTimer(watchdog);
    const current = inFlight();
    if (!current) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      settle(current.jobId, failed(SPEECH_TIMEOUT_MESSAGE));
      restart();
    }, deadlineMs(current.input));
  }

  function scheduleIdle(): void {
    idleTimer = clearTimer(idleTimer);
    if (jobs.size > 0) return;
    idleTimer = setTimeout(() => {
      if (jobs.size === 0) stopHost();
    }, idleTimeoutMs);
  }

  function stopHost(): void {
    readyTimer = clearTimer(readyTimer);
    idleTimer = clearTimer(idleTimer);
    watchdog = clearTimer(watchdog);
    const current = host;
    host = null;
    ready = false;
    loadedModelId = null;
    // Whatever the old host had been given is lost with it and goes to the next one.
    for (const job of jobs.values()) job.sent = false;
    current?.kill();
  }

  /** Replaces the host, and hands the recordings still waiting to the new one. */
  function restart(): void {
    stopHost();
    if (jobs.size > 0) {
      ensureHost();
      flush();
    } else {
      scheduleIdle();
    }
  }

  function flush(): void {
    if (!ready) return;
    for (const job of jobs.values()) {
      if (job.sent) continue;
      job.sent = true;
      send({ type: 'transcribe', jobId: job.jobId, ...job.input });
    }
    if (!watchdog) armWatchdog();
  }

  function ensureHost(): void {
    idleTimer = clearTimer(idleTimer);
    if (host) return;

    let child: HostProcess;
    try {
      child = options.spawn();
    } catch {
      for (const jobId of [...jobs.keys()]) settle(jobId, failed(SPEECH_START_MESSAGE));
      return;
    }
    host = child;
    ready = false;
    readyTimer = setTimeout(() => {
      if (host !== child || ready) return;
      stopHost();
      for (const jobId of [...jobs.keys()]) settle(jobId, failed(SPEECH_START_MESSAGE));
      scheduleIdle();
    }, readyTimeoutMs);

    child.on('message', (raw) => {
      if (host !== child) return;
      const message = parseHostMessage(raw);
      if (!message) return;
      switch (message.type) {
        case 'ready':
          ready = true;
          readyTimer = clearTimer(readyTimer);
          flush();
          break;
        case 'progress':
          if (!jobs.has(message.jobId)) return;
          armWatchdog();
          options.onProgress({ percent: message.percent, file: message.file });
          break;
        case 'done': {
          const job = jobs.get(message.jobId);
          if (!job) return;
          if (message.ok) {
            loadedModelId = job.input.model.hubId;
            settle(message.jobId, { ok: true, text: message.text });
          } else {
            settle(message.jobId, failed(message.error));
          }
          armWatchdog();
          scheduleIdle();
          break;
        }
      }
    });

    child.on('exit', () => {
      if (host !== child) return;
      // The recording it was working on is the likeliest cause, so only that one fails. The
      // ones behind it get a fresh host.
      const current = inFlight();
      if (current) settle(current.jobId, failed(SPEECH_CRASH_MESSAGE));
      host = null;
      restart();
    });
  }

  return {
    transcribe(jobId, input) {
      const done = new Promise<TranscribeAudioResult>((resolve) => {
        jobs.set(jobId, { jobId, input, resolve, sent: false });
      });
      ensureHost();
      flush();
      return done;
    },
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) return;
      const busy = inFlight() === job;
      settle(jobId, failed(SPEECH_CANCELLED_MESSAGE));
      if (busy) {
        // Decoding cannot be interrupted from outside, only ended with the process.
        restart();
      } else {
        if (job.sent) send({ type: 'cancel', jobId });
        scheduleIdle();
      }
    },
    isModelLoaded(hubId) {
      return host !== null && loadedModelId === hubId;
    },
    shutdown() {
      stopHost();
      for (const jobId of [...jobs.keys()]) settle(jobId, failed(SPEECH_CANCELLED_MESSAGE));
    },
  };
}
