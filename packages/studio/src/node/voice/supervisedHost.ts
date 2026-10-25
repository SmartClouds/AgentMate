import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PYTHON_UTF8 } from './localProcess.js';

/**
 * A long-lived helper process that answers one JSON line with another (the OmniVoice sidecar):
 * started on first use, ready once it says so, given one job at a time, with a watchdog per job.
 * If it dies, only the job it was doing fails, and the next job starts it again. Left idle, it is
 * stopped, which frees the graphics card's memory for everything else.
 */

export interface SupervisedHostOptions {
  command: string;
  args: readonly string[];
  /** Loading a model can take a while, the first time especially. */
  readyTimeoutMs: number;
  idleShutdownMs: number;
  /** What the process is called in messages ("OmniVoice"). */
  name: string;
  /** Lines it prints that are not answers: its log. */
  onLog?: (line: string) => void;
  env?: Record<string, string>;
}

export interface HostJob {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class HostError extends Error {
  constructor(
    message: string,
    /** The process died or hung, as opposed to refusing this one job. */
    readonly crashed: boolean,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

type Answer = Record<string, unknown> & { id?: number; ok?: boolean; error?: string };

export class SupervisedHost {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending: {
    id: number;
    child: ChildProcess;
    resolve: (a: Answer) => void;
    reject: (e: Error) => void;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times it has been started, for tests and the log. */
  starts = 0;

  constructor(private readonly options: SupervisedHostOptions) {}

  /** Sends one job and waits for its answer; jobs run one after another. */
  request(message: Record<string, unknown>, job: HostJob): Promise<Answer> {
    const run = this.queue.then(() => this.run(message, job));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the process now, failing the job it is on. */
  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.stdin?.write(`${JSON.stringify({ op: 'quit' })}\n`);
    } catch {
      // Already gone.
    }
    const killer = setTimeout(() => child.kill(), 2000);
    await exited;
    clearTimeout(killer);
  }

  get running(): boolean {
    return this.child !== null;
  }

  private start(): Promise<void> {
    const { options } = this;
    this.starts += 1;
    const child = spawn(options.command, [...options.args], {
      env: { ...process.env, ...PYTHON_UTF8, ...options.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // Writing to a process that just died fails here rather than as an unhandled error.
    child.stdin?.on('error', () => undefined);
    let markReady: () => void = () => undefined;
    let failStart: (e: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failStart = reject;
    });
    const timer = setTimeout(() => {
      failStart(new HostError(`${options.name} took too long to start.`, true));
      child.kill();
    }, options.readyTimeoutMs);
    let isReady = false;
    let fatal: string | null = null;

    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      let answer: Answer;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        options.onLog?.(line);
        return;
      }
      if (answer.type === 'ready') {
        isReady = true;
        clearTimeout(timer);
        markReady();
      } else if (answer.type === 'fatal') {
        fatal = String(answer.error ?? 'it could not start');
        options.onLog?.(fatal);
      } else if (this.pending?.child === child && answer.id === this.pending.id) {
        const { resolve } = this.pending;
        this.pending = null;
        resolve(answer);
      }
    });
    createInterface({ input: child.stderr as NodeJS.ReadableStream }).on('line', (line) =>
      options.onLog?.(line),
    );
    const gone = (detail: string) => {
      clearTimeout(timer);
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      const why = fatal ?? detail;
      if (!isReady) failStart(new HostError(`${options.name} could not start: ${why}`, true));
      // Only the job this process was doing; one already moved on to a new process is not its.
      if (this.pending?.child === child) {
        const { reject } = this.pending;
        this.pending = null;
        reject(new HostError(`${options.name} stopped unexpectedly (${why}).`, true));
      }
    };
    child.on('error', (error) => gone(error.message));
    child.on('exit', (code, signal) => gone(signal ? `signal ${signal}` : `exit code ${code}`));
    return ready;
  }

  /** Ends a process mid-job; the next job starts a fresh one without waiting for it to exit. */
  private discard(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.ready = null;
    }
    child.kill();
  }

  private async run(message: Record<string, unknown>, job: HostJob): Promise<Answer> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (job.signal?.aborted) throw new HostError('Stopped.', false);
    if (!this.child || !this.ready) this.ready = this.start();
    await this.ready;
    const child = this.child as ChildProcess;
    const id = this.nextId++;
    try {
      return await new Promise<Answer>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          job.signal?.removeEventListener('abort', onAbort);
          this.pending = null;
        };
        // A job that hangs holds the model hostage: the process goes, and the next job restarts it.
        const timer = setTimeout(() => {
          finish();
          reject(new HostError(`${this.options.name} took too long and was restarted.`, true));
          this.discard(child);
        }, job.timeoutMs);
        const onAbort = () => {
          finish();
          reject(new HostError('Stopped.', false));
          this.discard(child);
        };
        job.signal?.addEventListener('abort', onAbort, { once: true });
        this.pending = {
          id,
          child,
          resolve: (answer) => {
            finish();
            resolve(answer);
          },
          reject: (error) => {
            finish();
            reject(error);
          },
        };
        child.stdin?.write(`${JSON.stringify({ ...message, id })}\n`);
      });
    } finally {
      this.idleTimer = setTimeout(() => void this.stop(), this.options.idleShutdownMs);
      this.idleTimer.unref?.();
    }
  }
}
