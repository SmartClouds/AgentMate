/**
 * Relay (E26): tasks sized to fit one agent session, run one after another, each session handing
 * the next a written baton. Tasks and handoffs are Markdown files in the project (the SDD source of
 * truth); these are the shapes the app reads them into.
 */

export const RELAY_TASK_STATUSES = ['todo', 'in-progress', 'testing', 'done', 'blocked'] as const;
/** A task's column on the board. The app writes it; agents only ever write handoffs. */
export type RelayTaskStatus = (typeof RELAY_TASK_STATUSES)[number];

export const RELAY_OUTCOMES = ['done', 'continue', 'blocked'] as const;
/**
 * How a session left its task: finished, out of context budget (a fresh session picks it up from
 * the handoff), or stuck on something only the user can answer.
 */
export type RelayOutcome = (typeof RELAY_OUTCOMES)[number];

export const RELAY_TEST_RESULTS = ['passed', 'failed', 'not-run'] as const;
export type RelayTestResult = (typeof RELAY_TEST_RESULTS)[number];

export type HandoffSectionKey = 'purpose' | 'done' | 'decisions' | 'rejected' | 'next';

/** Something in a file that was read past rather than trusted. Shown on the card. */
export interface RelayIssue {
  field: string;
  message: string;
}

export interface RelayTask {
  id: string;
  title: string;
  status: RelayTaskStatus;
  /** A group label such as `E02`, used for the card's color and the board filter. */
  epic: string | null;
  order: number | null;
  depends: string[];
  /** The planner's guess at the context one session needs. Advisory; the live meter decides. */
  estimate: number | null;
  /** Context tokens one session may use on this task. Null means the relay's default. */
  budget: number | null;
  /** The docs this task implements, relative to the project. */
  specs: string[];
  /** File name inside the tasks folder. */
  file: string;
  /** Everything after the front matter. */
  body: string;
  acceptance: { checked: number; total: number };
  issues: RelayIssue[];
}

/** What a planner (or the user) fills in for a new task file. */
export interface RelayTaskDraft {
  id: string;
  title: string;
  status?: RelayTaskStatus;
  epic?: string | null;
  order?: number | null;
  depends?: string[];
  estimate?: number | null;
  budget?: number | null;
  specs?: string[];
  goal?: string;
  scope?: string;
  acceptance?: string[];
  testPlan?: string;
}

export interface RelayHandoff {
  taskId: string;
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  leg: number | null;
  updated: string | null;
  sections: Record<HandoffSectionKey, string>;
  /** Sections that are absent or empty, in template order. */
  missingSections: HandoffSectionKey[];
  issues: RelayIssue[];
}
