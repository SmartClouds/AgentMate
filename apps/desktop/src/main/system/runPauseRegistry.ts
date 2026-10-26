import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunPauseReason } from '@runova/core';
import type { TerminalPauseChange, TerminalPauseResult } from '../../shared/apiTypes';
import type { ProcessSuspender } from './processSuspend';

/**
 * Which terminal sessions are frozen, and the only way in and out of that state. Every pause
 * and resume of one session goes through a queue, so a double click or the auto pause racing
 * a click never freezes a tree twice: Windows counts suspends, and a tree frozen twice stays
 * frozen after one resume.
 *
 * The list is kept on disk because the terminal host can outlive main (a crash, a dev restart),
 * and a run nobody remembers freezing could never be resumed.
 */

export interface PausedRun {
  sessionId: string;
  /** The shell's pid when it was frozen, to tell it apart from a new shell with the same id. */
  pid: number;
  /** Everything frozen, in the order it was frozen (shell first). */
  pids: number[];
  names: string[];
  pausedAt: number;
  reason: RunPauseReason;
}

interface SavedFile {
  version: 1;
  runs: PausedRun[];
}

const SHELL_NAMES = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
  'fish',
  'nu',
  'cmd',
  'powershell',
  'pwsh',
]);
const DOCKER_CLIENTS = /^(docker|docker-compose|com\.docker\.cli)$/i;

/** True when everything frozen besides the shell is a Docker client, so no real work stopped. */
function onlyDockerClients(names: readonly string[]): boolean {
  const work = names
    .map((name) => name.replace(/\.exe$/i, ''))
    .filter((name) => !SHELL_NAMES.has(name.toLowerCase()));
  return work.length > 0 && work.every((name) => DOCKER_CLIENTS.test(name));
}

function isPausedRun(value: unknown): value is PausedRun {
  const run = value as PausedRun | null;
  return (
    typeof run?.sessionId === 'string' &&
    Number.isInteger(run.pid) &&
    Array.isArray(run.pids) &&
    run.pids.every((pid) => Number.isInteger(pid)) &&
    Array.isArray(run.names) &&
    typeof run.pausedAt === 'number' &&
    (run.reason === 'user' || run.reason === 'agent')
  );
}

export interface RunPauseRegistryOptions {
  suspender: Pick<ProcessSuspender, 'suspendTree' | 'resumePids'>;
  /** Where the list is kept; null keeps it in memory only. */
  file: string | null;
  now?: () => number;
  onChange?: (change: TerminalPauseChange) => void;
}

export class RunPauseRegistry {
  private readonly runs = new Map<string, PausedRun>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: RunPauseRegistryOptions) {}

  get(sessionId: string): PausedRun | undefined {
    return this.runs.get(sessionId);
  }

  list(): PausedRun[] {
    return [...this.runs.values()];
  }

  pause(sessionId: string, pid: number, reason: RunPauseReason): Promise<TerminalPauseResult> {
    return this.queued(sessionId, async () => {
      const existing = this.runs.get(sessionId);
      if (existing) {
        // The user's pause wins over the agent's, so it is never resumed behind their back.
        if (reason === 'user' && existing.reason === 'agent') {
          existing.reason = 'user';
          this.changed(existing);
        }
        return this.outcome(existing, { processCount: existing.pids.length });
      }
      const result = await this.options.suspender.suspendTree(pid);
      if (result.pids.length === 0) {
        return {
          ...this.outcome(undefined, { processCount: 0, failedCount: result.failed.length }),
          ok: false,
          error: result.failed[0]?.reason ?? 'nothing to pause',
        };
      }
      const run: PausedRun = {
        sessionId,
        pid,
        pids: result.pids,
        names: result.names,
        pausedAt: this.now(),
        reason,
      };
      this.runs.set(sessionId, run);
      this.changed(run);
      return {
        ...this.outcome(run, {
          processCount: result.pids.length,
          failedCount: result.failed.length,
        }),
        containersOnly: onlyDockerClients(result.names),
      };
    });
  }

  resume(sessionId: string): Promise<TerminalPauseResult> {
    return this.queued(sessionId, async () => {
      const run = this.runs.get(sessionId);
      if (!run) return this.outcome(undefined, { processCount: 0 });
      const result = await this.options.suspender.resumePids(run.pids);
      if (result.pids.length === 0 && result.failed.length > 0) {
        return {
          ...this.outcome(run, { processCount: 0, failedCount: result.failed.length }),
          ok: false,
          error: result.failed[0]?.reason ?? 'could not resume',
        };
      }
      this.runs.delete(sessionId);
      this.changed(undefined, sessionId);
      return this.outcome(undefined, {
        processCount: result.pids.length,
        failedCount: result.failed.length,
      });
    });
  }

  /**
   * Drops a session whose shell ended or is being killed, and returns what it had frozen so a
   * caller on posix can continue those processes (a stopped process only acts on SIGHUP once it
   * runs again).
   */
  forget(sessionId: string): PausedRun | undefined {
    const run = this.runs.get(sessionId);
    if (!run) return undefined;
    this.runs.delete(sessionId);
    this.changed(undefined, sessionId);
    return run;
  }

  /** Reads the list kept by a previous main, keeping only runs whose shell is still the same. */
  async load(alive: readonly { sessionId: string; pid: number }[]): Promise<void> {
    this.runs.clear();
    const { file } = this.options;
    if (!file) return;
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(file, 'utf-8'));
    } catch {
      saved = null;
    }
    const pidOf = new Map(alive.map((session) => [session.sessionId, session.pid]));
    const runs = (saved as SavedFile | null)?.runs;
    for (const run of Array.isArray(runs) ? runs : []) {
      if (isPausedRun(run) && pidOf.get(run.sessionId) === run.pid)
        this.runs.set(run.sessionId, run);
    }
    this.save();
  }

  /** Resolves once everything changed so far is on disk. */
  flush(): Promise<void> {
    return this.saving;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private queued<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(sessionId, next);
    void next
      .finally(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  private outcome(
    run: PausedRun | undefined,
    counts: { processCount: number; failedCount?: number },
  ): TerminalPauseResult {
    return {
      ok: true,
      paused: run !== undefined,
      reason: run?.reason ?? null,
      pausedAt: run?.pausedAt ?? null,
      processCount: counts.processCount,
      failedCount: counts.failedCount ?? 0,
      containersOnly: false,
    };
  }

  private changed(run: PausedRun | undefined, sessionId = run?.sessionId ?? ''): void {
    this.options.onChange?.({
      sessionId,
      paused: run !== undefined,
      reason: run?.reason ?? null,
      pausedAt: run?.pausedAt ?? null,
    });
    this.save();
  }

  private save(): void {
    const { file } = this.options;
    if (!file) return;
    const body: SavedFile = { version: 1, runs: this.list() };
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(body), 'utf-8');
      })
      .catch(() => undefined);
  }
}
