import type { FilesErrorCode } from '@shared/deployFilesErrors';
import type {
  FilesConflictChoice,
  FilesPlanNotice,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
} from '@shared/deployFilesTypes';
import { create } from 'zustand';

/**
 * Deploys to FTP and SFTP sites (E23), per site. A run keeps going in main when the page is left,
 * and a Deploy on save run starts with nobody on the page, so the review, the progress and the
 * outcome live here and the Deploy page and a project's Deploy tab both pick them up.
 */

export interface FilesRunSample {
  /** When the event arrived here; progress events carry no time of their own. */
  at: number;
  bytes: number;
}

/** What the user chose in the review, kept with the plan it is about. */
export interface FilesReview {
  plan: FilesPlanView;
  conflicts: Record<string, FilesConflictChoice>;
  firstDeploy: 'adoptSameSize' | 'overwrite' | null;
  /** Paths from `plan.missingOnServer` to send again. */
  reupload: string[];
  /** A retry of failed files: only these paths go. Null for everything ticked. */
  only: string[] | null;
}

/** Notes from the check that did not need a choice, shown with the outcome. */
export interface FilesRunNotes {
  notices: FilesPlanNotice[];
  drift: string[];
}

export interface FilesProblem {
  message: string;
  code: FilesErrorCode | null;
}

export interface FilesSiteRun {
  /** Asking the server what changed there, before a deploy. */
  planning: boolean;
  review: FilesReview | null;
  /** The deploy call is out and no progress has come yet. */
  starting: boolean;
  progress: FilesProgressEvent | null;
  startedAt: number | null;
  /** The last few progress readings, for the speed and the time left. */
  samples: FilesRunSample[];
  result: FilesRunResult | null;
  notes: FilesRunNotes | null;
  /** Why the check or the deploy call failed. */
  problem: FilesProblem | null;
  /**
   * Paths the user unticked in the changes list. Kept here rather than in the panel, so leaving
   * the Changes section (or opening the site from a project) never sends what was unticked.
   */
  deselected: ReadonlySet<string>;
  /** "Review the changes" was pressed and the panel has not taken it yet; taken once. */
  startRequested: boolean;
}

export const EMPTY_SITE_RUN: FilesSiteRun = Object.freeze({
  planning: false,
  review: null,
  starting: false,
  progress: null,
  startedAt: null,
  samples: [],
  result: null,
  notes: null,
  problem: null,
  deselected: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  startRequested: false,
}) as FilesSiteRun;

/** How far back the readings for the speed go, whatever the rate the events come at. */
const SAMPLE_WINDOW_MS = 5000;

/**
 * The readings of the last few seconds, and always the two newest, so a run that reports seldom
 * still has a speed.
 */
function recentSamples(samples: FilesRunSample[], now: number): FilesRunSample[] {
  const from = samples.findIndex((sample) => now - sample.at <= SAMPLE_WINDOW_MS);
  const start = from < 0 ? samples.length : from;
  return samples.slice(Math.min(start, Math.max(0, samples.length - 2)));
}

interface DeployFilesRunState {
  runs: Record<string, FilesSiteRun>;
  setPlanning: (siteId: string, planning: boolean) => void;
  /** Keeps a fresh plan, with every deleted-on-server conflict set to send this computer's copy. */
  setReview: (siteId: string, plan: FilesPlanView, only: string[] | null) => void;
  chooseConflicts: (siteId: string, choices: Record<string, FilesConflictChoice>) => void;
  chooseFirstDeploy: (siteId: string, choice: 'adoptSameSize' | 'overwrite') => void;
  setReupload: (siteId: string, paths: string[]) => void;
  clearReview: (siteId: string) => void;
  setProblem: (siteId: string, problem: FilesProblem | null) => void;
  setDeselected: (siteId: string, deselected: ReadonlySet<string>) => void;
  /** Asks the site's panel to check the server, like the needs-review notice does. */
  requestStart: (siteId: string) => void;
  /** Takes a pending request; true only for the first taker. */
  takeStartRequest: (siteId: string) => boolean;
  /** The deploy call is going out: the review is done with. */
  begin: (siteId: string, notes: FilesRunNotes | null) => void;
  failStart: (siteId: string, problem: FilesProblem) => void;
  progress: (event: FilesProgressEvent) => void;
  /** Takes a run's outcome; false when it was already taken (from the event or the call). */
  finish: (result: FilesRunResult) => boolean;
  dismissResult: (siteId: string) => void;
  forget: (siteId: string) => void;
}

export const useDeployFilesRunStore = create<DeployFilesRunState>((set, get) => {
  const patch = (siteId: string, change: (run: FilesSiteRun) => Partial<FilesSiteRun>): void =>
    set((state) => {
      const run = state.runs[siteId] ?? EMPTY_SITE_RUN;
      return { runs: { ...state.runs, [siteId]: { ...run, ...change(run) } } };
    });
  const patchReview = (siteId: string, change: (review: FilesReview) => Partial<FilesReview>) =>
    patch(siteId, (run) =>
      run.review ? { review: { ...run.review, ...change(run.review) } } : {},
    );

  return {
    runs: {},
    setPlanning: (siteId, planning) =>
      patch(siteId, () => (planning ? { planning, problem: null } : { planning })),
    setReview: (siteId, plan, only) =>
      patch(siteId, () => ({
        planning: false,
        problem: null,
        review: {
          plan,
          conflicts: Object.fromEntries(
            plan.changes
              .filter((change) => change.conflict === 'deletedOnServer')
              .map((change) => [change.path, 'overwrite' as const]),
          ),
          firstDeploy: plan.firstDeploy ? 'adoptSameSize' : null,
          reupload: [],
          only,
        },
      })),
    chooseConflicts: (siteId, choices) =>
      patchReview(siteId, (review) => ({ conflicts: { ...review.conflicts, ...choices } })),
    chooseFirstDeploy: (siteId, firstDeploy) => patchReview(siteId, () => ({ firstDeploy })),
    setReupload: (siteId, reupload) => patchReview(siteId, () => ({ reupload })),
    clearReview: (siteId) => patch(siteId, () => ({ review: null, planning: false })),
    setProblem: (siteId, problem) => patch(siteId, () => ({ problem, planning: false })),
    setDeselected: (siteId, deselected) => patch(siteId, () => ({ deselected })),
    requestStart: (siteId) => patch(siteId, () => ({ startRequested: true })),
    takeStartRequest: (siteId) => {
      if (!get().runs[siteId]?.startRequested) return false;
      patch(siteId, () => ({ startRequested: false }));
      return true;
    },
    begin: (siteId, notes) =>
      patch(siteId, () => ({
        review: null,
        planning: false,
        problem: null,
        starting: true,
        progress: null,
        result: null,
        startedAt: Date.now(),
        samples: [],
        notes,
      })),
    failStart: (siteId, problem) =>
      patch(siteId, () => ({ starting: false, progress: null, samples: [], problem })),
    progress: (event) =>
      patch(event.siteId, (run) => {
        // A late event from the run whose outcome is already in.
        if (run.result?.runId === event.runId) return {};
        const now = Date.now();
        // A run this page did not start (Deploy on save), or the next one after an outcome.
        const fresh = !run.starting && run.progress?.runId !== event.runId;
        const samples = fresh ? [] : run.samples;
        return {
          // A run that started elsewhere (Deploy on save) makes an open review stale, and the
          // notes of an earlier run from here are not about it.
          ...(fresh ? { review: null, planning: false, notes: null } : {}),
          starting: false,
          result: null,
          progress: event,
          startedAt: fresh ? now : (run.startedAt ?? now),
          samples: recentSamples([...samples, { at: now, bytes: event.bytesDone }], now),
        };
      }),
    finish: (result) => {
      const run = get().runs[result.siteId];
      if (run?.result?.runId === result.runId) return false;
      patch(result.siteId, () => ({
        result,
        progress: null,
        starting: false,
        samples: [],
      }));
      return true;
    },
    dismissResult: (siteId) => patch(siteId, () => ({ result: null, notes: null })),
    forget: (siteId) =>
      set((state) => {
        const { [siteId]: _gone, ...rest } = state.runs;
        return { runs: rest };
      }),
  };
});

/** The run of one site, or the shared empty one, so a component re-renders only for its site. */
export function selectSiteRun(siteId: string) {
  return (state: DeployFilesRunState): FilesSiteRun => state.runs[siteId] ?? EMPTY_SITE_RUN;
}

/** True while a deploy is on its way or running. */
export function isRunActive(run: FilesSiteRun): boolean {
  return run.starting || run.progress !== null;
}
