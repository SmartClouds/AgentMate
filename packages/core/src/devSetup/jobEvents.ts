import type { InstallIntent } from './recipes.js';
import type { DevInstallPhase, DevItemId, DevItemJob } from './types.js';

/**
 * The installer reports what it is doing as a stream of small events. The page folds them into one
 * state with `applyJobEvent`, so a window opened halfway through a run, or a late event from a run
 * that has already ended, still ends up showing the truth.
 */

export type DevJobEvent =
  /** A run begins, or more steps are added to one that is already going. Absent intent is install. */
  | { type: 'plan'; jobId: string; steps: DevItemId[]; intent?: InstallIntent }
  | { type: 'started'; jobId: string; itemId: DevItemId }
  | {
      type: 'progress';
      jobId: string;
      itemId: DevItemId;
      phase?: DevInstallPhase;
      /** 0 to 1, or null for "no percentage". Leave out to keep the last one. */
      fraction?: number | null;
      detail?: string | null;
    }
  | { type: 'log'; jobId: string; itemId: DevItemId; line: string }
  | {
      type: 'finished';
      jobId: string;
      itemId: DevItemId;
      result: 'installed' | 'failed' | 'cancelled';
      message?: string;
      exitCode?: number | null;
      /** The tool is in place but the machine needs a restart before it fully works. */
      restartAdvised?: boolean;
    }
  | { type: 'done'; jobId: string; cancelled: boolean };

export interface DevJobState {
  jobId: string | null;
  running: boolean;
  /** Items in this run that are queued or installing, plus failures that have not been retried. */
  items: Record<DevItemId, DevItemJob>;
  /** Every step of the run, in order, finished or not. */
  order: DevItemId[];
  /** The steps that installed during this run. */
  completed: DevItemId[];
  logs: Record<DevItemId, string[]>;
  current: DevItemId | null;
  restartAdvised: boolean;
  /** What the run that began this state was for. Absent means install. */
  intent?: InstallIntent;
  /** The last run ended because it was cancelled. Unset while a run is going. */
  cancelled?: boolean;
}

export const EMPTY_JOB_STATE: DevJobState = {
  jobId: null,
  running: false,
  items: {},
  order: [],
  completed: [],
  logs: {},
  current: null,
  restartAdvised: false,
};

/** A long install can print thousands of lines; the log keeps the most recent. */
export const MAX_LOG_LINES = 500;

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** The intent a step was planned with, to carry onto each later state of the same step. */
function intentOf(job: DevItemJob | undefined): { intent?: InstallIntent } {
  return job?.intent ? { intent: job.intent } : {};
}

export function applyJobEvent(state: DevJobState, event: DevJobEvent): DevJobState {
  if (event.type === 'plan') return applyPlan(state, event);
  // Anything else belongs to the run in progress. Events for another run, or arriving after the
  // run ended, are late and must not bring a finished state back to life.
  if (event.jobId !== state.jobId || !state.running) return state;

  switch (event.type) {
    case 'started':
      return {
        ...state,
        current: event.itemId,
        items: {
          ...state.items,
          [event.itemId]: {
            status: 'installing',
            phase: 'preparing',
            fraction: null,
            ...intentOf(state.items[event.itemId]),
          },
        },
      };

    case 'progress': {
      const existing = state.items[event.itemId];
      if (existing?.status !== 'installing') return state;
      const phase = event.phase ?? existing.phase ?? 'installing';
      const samePhase = phase === existing.phase;
      let fraction = event.fraction === undefined ? (existing.fraction ?? null) : event.fraction;
      // A bar that steps back within a phase looks broken, so within one it only moves forward.
      if (
        samePhase &&
        fraction !== null &&
        existing.fraction != null &&
        fraction < existing.fraction
      ) {
        fraction = existing.fraction;
      }
      const detail =
        event.detail === undefined ? (samePhase ? existing.detail : undefined) : event.detail;
      const next: DevItemJob = { status: 'installing', phase, fraction, ...intentOf(existing) };
      if (detail) next.detail = detail;
      return { ...state, items: { ...state.items, [event.itemId]: next } };
    }

    case 'log': {
      const lines = [...(state.logs[event.itemId] ?? []), event.line];
      const kept = lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines;
      return { ...state, logs: { ...state.logs, [event.itemId]: kept } };
    }

    case 'finished': {
      const current = state.current === event.itemId ? null : state.current;
      if (event.result === 'installed') {
        return {
          ...state,
          current,
          items: withoutKey(state.items, event.itemId),
          completed: [...state.completed, event.itemId],
          restartAdvised: state.restartAdvised || event.restartAdvised === true,
        };
      }
      if (event.result === 'cancelled') {
        return { ...state, current, items: withoutKey(state.items, event.itemId) };
      }
      return {
        ...state,
        current,
        items: {
          ...state.items,
          [event.itemId]: {
            status: 'failed',
            message: event.message,
            exitCode: event.exitCode ?? null,
            ...intentOf(state.items[event.itemId]),
          },
        },
      };
    }

    case 'done': {
      // Whatever never got its turn is dropped. A failure stays, so the row can offer a retry.
      const items = Object.fromEntries(
        Object.entries(state.items).filter(([, job]) => job.status === 'failed'),
      );
      return { ...state, running: false, current: null, items, cancelled: event.cancelled };
    }
  }
}

function applyPlan(state: DevJobState, event: Extract<DevJobEvent, { type: 'plan' }>): DevJobState {
  // More steps for the run that is going: add the new ones and leave the rest as they are.
  if (state.running && state.jobId === event.jobId) {
    const items = { ...state.items };
    const logs = { ...state.logs };
    for (const id of event.steps) {
      const status = items[id]?.status;
      // Already waiting or running is left alone, so planning it twice cannot queue it twice.
      if (status === 'queued' || status === 'installing') continue;
      // A failure being retried is a new attempt: it queues now and starts a fresh log.
      if (status === 'failed') delete logs[id];
      items[id] = { status: 'queued', ...(event.intent ? { intent: event.intent } : {}) };
    }
    return { ...state, items, logs, order: [...new Set([...state.order, ...event.steps])] };
  }

  // A new run. Failures from the last one stay until their item is planned again.
  const planned = new Set(event.steps);
  const carried = Object.entries(state.items).filter(
    ([id, job]) => job.status === 'failed' && !planned.has(id),
  );
  const items: Record<DevItemId, DevItemJob> = Object.fromEntries(carried);
  for (const id of event.steps) {
    items[id] = { status: 'queued', ...(event.intent ? { intent: event.intent } : {}) };
  }
  const logs = Object.fromEntries(
    Object.entries(state.logs).filter(([id]) => carried.some(([carriedId]) => carriedId === id)),
  );
  return {
    jobId: event.jobId,
    running: true,
    items,
    order: [...new Set(event.steps)],
    completed: [],
    logs,
    current: null,
    restartAdvised: false,
    ...(event.intent ? { intent: event.intent } : {}),
  };
}

/** How far through the whole run it is, from 0 to 1, counting the current step's own progress. */
export function overallFraction(state: DevJobState): number {
  const total = state.order.length;
  if (total === 0) return 0;
  const currentJob = state.current ? state.items[state.current] : undefined;
  const partial = currentJob?.status === 'installing' ? (currentJob.fraction ?? 0) : 0;
  return Math.min(1, Math.max(0, (state.completed.length + partial) / total));
}

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'g');
const BAR_GLYPH = /[█░▒▓■□]/;
const SPINNER = /^[-\\|/]+$/;

/**
 * One line of installer output, ready for a log, or null when it is only noise. winget redraws a
 * spinner and a block-character bar many times a second, and a log full of those is unreadable.
 */
export function cleanInstallerLine(line: string): string | null {
  const text = line.replace(ANSI, '').trim();
  if (!text) return null;
  if (BAR_GLYPH.test(text) || SPINNER.test(text)) return null;
  return text;
}

const UNIT_BYTES: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const SIZES = /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/i;
const PERCENT = /(\d{1,3})\s*%/;

/** How far along a line says the download or install is, if it says. */
export function parseInstallerProgress(line: string): { fraction: number; detail: string } | null {
  const sizes = SIZES.exec(line);
  if (sizes) {
    const [, doneText = '', doneUnit = '', totalText = '', totalUnit = ''] = sizes;
    const done = Number(doneText);
    const total = Number(totalText);
    const unitDone = doneUnit.toUpperCase();
    const unitTotal = totalUnit.toUpperCase();
    if (total > 0) {
      const ratio =
        unitDone === unitTotal
          ? done / total
          : (done * (UNIT_BYTES[unitDone] ?? 1)) / (total * (UNIT_BYTES[unitTotal] ?? 1));
      return {
        fraction: Math.min(1, ratio),
        detail: `${doneText} ${unitDone} of ${totalText} ${unitTotal}`,
      };
    }
  }
  const percent = PERCENT.exec(line);
  if (percent?.[1]) {
    const value = Number(percent[1]);
    return { fraction: Math.min(100, value) / 100, detail: `${value}%` };
  }
  return null;
}

export interface WingetExit {
  /** `already` and `restart` still count as the tool being there; the check afterwards decides. */
  kind: 'already' | 'restart' | 'failure';
  message: string;
}

const BUSY = 'Another installer is running. Wait for it to finish, then try again.';
const CANCELLED = 'The install was cancelled.';
const RESTART = 'Installed. Restart your computer to finish.';

/**
 * Codes from Microsoft's winget return-code table, plus the Windows Installer codes that pass
 * through from the package's own installer. winget's own codes are 0x8A15xxxx.
 */
const WINGET_EXITS = new Map<number, WingetExit>([
  [0x8a150061 | 0, { kind: 'already', message: 'Already installed.' }],
  [0x8a15010d | 0, { kind: 'already', message: 'Already installed.' }],
  [0x8a15002b | 0, { kind: 'already', message: 'Already up to date.' }],
  [0x8a150109 | 0, { kind: 'restart', message: RESTART }],
  [0x8a15010b | 0, { kind: 'restart', message: RESTART }],
  [3010, { kind: 'restart', message: RESTART }],
  [
    0x8a15010a | 0,
    { kind: 'failure', message: 'Restart your computer, then try the install again.' },
  ],
  [0x8a150102 | 0, { kind: 'failure', message: BUSY }],
  [1618, { kind: 'failure', message: BUSY }],
  [0x8a150101 | 0, { kind: 'failure', message: 'Close the app that is using it, then try again.' }],
  [0x8a15010c | 0, { kind: 'failure', message: CANCELLED }],
  [1602, { kind: 'failure', message: CANCELLED }],
  [0x8a150010 | 0, { kind: 'failure', message: 'There is no installer for this computer.' }],
  [0x8a150014 | 0, { kind: 'failure', message: 'winget could not find this package.' }],
  [
    0x8a150008 | 0,
    {
      kind: 'failure',
      message: 'The download failed. Check your internet connection and try again.',
    },
  ],
  [
    0x8a150107 | 0,
    {
      kind: 'failure',
      message: 'The download failed. Check your internet connection and try again.',
    },
  ],
  [
    0x8a150011 | 0,
    {
      kind: 'failure',
      message: 'The download did not match its checksum, so it was not installed.',
    },
  ],
]);

/**
 * What a winget exit code means in a sentence a person can use. Null for success or no code.
 * Windows reports these as unsigned numbers and Node as either, so both forms are accepted.
 */
export function explainWingetExit(code: number | null): WingetExit | null {
  if (code === null || code === 0) return null;
  const signed = code | 0;
  const known = WINGET_EXITS.get(signed);
  if (known) return known;
  const shown = signed < 0 ? `0x${(signed >>> 0).toString(16).toUpperCase()}` : String(signed);
  return { kind: 'failure', message: `winget could not finish (code ${shown}).` };
}

/**
 * Which stage an installer line says it has reached, for the word under a row ("Downloading",
 * "Installing"). It reads what winget, Homebrew and npm print; a line that gives no hint is null,
 * and the row keeps the last stage it had.
 */
export function phaseFromInstallerLine(line: string): DevInstallPhase | null {
  if (/verified installer hash/i.test(line)) return 'verifying';
  if (/^(==>\s*)?(Fetching|Downloading)\b/i.test(line) || /^npm http fetch\b/i.test(line)) {
    return 'downloading';
  }
  if (
    /^Starting package install/i.test(line) ||
    /^==>\s*(Pouring|Installing|Upgrading)\b/i.test(line) ||
    /^added \d+ packages?\b/i.test(line)
  ) {
    return 'installing';
  }
  if (/^Found\b/i.test(line) || /licensed to you/i.test(line)) return 'preparing';
  return null;
}
