import type {
  AwaitReason,
  LegPhase,
  ProposalEntry,
  RelayAfterPlanMode,
  RelayFinished,
  RelayHandoff,
  RelayIssue,
  RelayLegRecord,
  RelayOptions,
  RelayOutcome,
  RelayProposal,
  RelayRunChoice,
  RelayTask,
  RelayTaskOverride,
  RelayTaskStatus,
  RelayTestResult,
  RelayTrigger,
} from '@agentmat/core';

/**
 * Relay (E26): the contract between main, the preload and the renderer. Task and handoff files live
 * in the project; main reads them, runs the relays and owns `relay.json` in userData. Only ids and
 * plain data cross the boundary, never a command line.
 */

/** A project's relay choices: the run choice for every task, per-task overrides and options. */
export interface RelayProjectSettings {
  /** Project-relative docs folder whose `tasks/` holds the board. */
  docsFolder: string;
  defaults: RelayRunChoice;
  overrides: Record<string, RelayTaskOverride>;
  options: RelayOptions;
}

export type RelaySettingsPatch = Partial<Omit<RelayProjectSettings, 'options' | 'defaults'>> & {
  defaults?: Partial<RelayRunChoice>;
  options?: Partial<RelayOptions>;
};

/** What the board shows of a handoff without opening it. */
export interface RelayHandoffSummary {
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  leg: number | null;
  updated: string | null;
  missingSections: RelayHandoff['missingSections'];
  /** The Next step section, trimmed for a card. */
  next: string;
}

/** A task as the board lists it: the parsed file without its body. */
export type RelayTaskCard = Omit<RelayTask, 'body'> & {
  handoff: RelayHandoffSummary | null;
  /** Sessions run on this task so far, across relays and single runs. */
  legCount: number;
  /**
   * The most context each of those sessions held, oldest first, to set against the estimate.
   * Sessions with no reading (quiet detection, a CLI without a transcript) are left out.
   */
  legPeaks: number[];
};

export interface RelayBoard {
  projectId: string;
  docsFolder: string;
  /** The tasks folder exists. When false the board offers to start one. */
  exists: boolean;
  guidePresent: boolean;
  tasks: RelayTaskCard[];
  /** Task ids in run order. */
  order: string[];
  cycles: string[][];
  missing: { taskId: string; dependsOn: string }[];
  /** Problems with the folder as a whole, such as two files with one id. */
  issues: RelayIssue[];
  settings: RelayProjectSettings;
  /** The relay running, waiting or paused on this project, if any. */
  active: RelayRunView | null;
}

export interface RelayTaskDetail {
  task: RelayTask;
  handoff: RelayHandoff | null;
  /** The raw handoff file, for the baton view. */
  handoffText: string | null;
  legs: RelayLegRecord[];
}

/** The live state of a relay's current leg, for the track, the fuel ring and the status bar. */
export interface RelayLegView {
  legId: string;
  taskId: string;
  legNo: number;
  phase: LegPhase;
  tabId: string | null;
  choice: RelayRunChoice;
  planFirst: boolean;
  startedAt: number;
  contextTokens: number | null;
  peakContextTokens: number | null;
  budget: number;
  /** Where the context guard fires, when the CLI has one. */
  guardAt: number | null;
  awaiting: { reason: AwaitReason; message: string } | null;
}

export interface RelayRunView {
  id: string;
  projectId: string;
  status: 'waiting' | 'running' | 'paused' | 'done' | 'cancelled';
  trigger: RelayTrigger;
  /** "Starts when T004 is done", worded in main. */
  triggerText: string;
  queue: string[];
  finished: RelayFinished[];
  current: RelayLegView | null;
  pauseReason: string | null;
  options: RelayOptions;
  createdAt: number;
}

export interface RelayStartInput {
  projectId: string;
  /** Run only these tasks (any status), in dependency order. */
  only?: string[];
  /** Start at this task and run what follows it. */
  from?: string;
  trigger: RelayTrigger;
  /** Changes for this relay only, on top of the project's settings. */
  options?: Partial<RelayOptions>;
  defaults?: Partial<RelayRunChoice>;
}

export type RelayStartResult = { ok: true; run: RelayRunView } | { ok: false; error: string };

/** A single task run in a new session, started by hand: the prompt to paste and the run choice. */
export interface RelaySingleRun {
  prompt: string;
  choice: RelayRunChoice;
  planFirst: boolean;
  legNo: number;
}

export interface RelayPlannerInput {
  /** Lets cancelPlanner(requestId) stop the run. */
  requestId: string;
  projectId: string;
  cliId?: string | null;
  model?: string | null;
  effort?: string | null;
  budget?: number;
}

export interface RelayDecomposeInput extends RelayPlannerInput {
  request: string;
}

export interface RelayReviseInput extends RelayPlannerInput {
  note?: string;
}

/** Catching up a project already under way: what is done, half done and left, as tasks. */
export interface RelayCatchUpInput extends RelayPlannerInput {
  /** Put finished work on the board as done tasks. */
  recordDone: boolean;
  /** What the user says about the project, such as where its plan is. */
  note?: string;
}

export type RelayPlannerResult =
  | {
      ok: true;
      proposal: RelayProposal;
      /** What the proposal would do, with the ids it would really get. */
      entries: ProposalEntry[];
      cliName: string | null;
    }
  | { ok: false; error: string; cancelled?: boolean };

export interface RelayApplyResult {
  written: string[];
  removed: string[];
  warnings: string[];
}

/** A proposal an agent sent through the MCP bridge, waiting for the user in the app. */
export interface RelayMcpProposal {
  id: string;
  projectId: string;
  projectName: string;
  /** The task whose session sent it, when a relay leg did. */
  fromTaskId: string | null;
  proposal: RelayProposal;
  entries: ProposalEntry[];
  receivedAt: number;
}

export interface RelayChangedEvent {
  projectId: string;
  /** What changed: the files, the run, or both. */
  reason: 'files' | 'run' | 'settings';
}

export interface RelayContextEvent {
  projectId: string;
  tabId: string;
  taskId: string;
  tokens: number;
  budget: number;
  guardAt: number | null;
}

/** Main asks the renderer to show a leg's session as a tab of its project's workspace. */
export interface RelayLegTabEvent {
  projectId: string;
  tabId: string;
  legId: string;
  cliId: string;
  title: string;
  runLabel?: string;
  cwd: string;
}

export interface RelayCloseTabEvent {
  projectId: string;
  tabId: string;
}

export type { RelayAfterPlanMode, RelayTaskStatus };
