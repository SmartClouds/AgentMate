import type { RelayAfterPlanMode } from './capabilities.js';

/** The permission modes Claude Code reports in hook payloads. */
export const RELAY_PERMISSION_MODES = [
  'default',
  'auto',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;
export type RelayPermissionMode = (typeof RELAY_PERMISSION_MODES)[number];

/** Where a leg is. Planning only happens on a plan-first leg's first session. */
export type LegPhase =
  | 'sizing'
  | 'launching'
  | 'planning'
  | 'executing'
  | 'finishing'
  | 'awaiting-user'
  | 'interrupted'
  | 'failed'
  | 'done';

/** What the gate needs to know about the leg a hook came from. */
export interface GateLegView {
  taskId: string;
  legNo: number;
  phase: LegPhase;
  planFirst: boolean;
  afterPlanMode: RelayAfterPlanMode;
  /** Questions the agent asked (AskUserQuestion) that have not been answered yet. */
  openQuestions: number;
  /** The context is past the guard and the agent has not been told yet. */
  guardDue: boolean;
  contextPercent: number | null;
  /** How many times the stop gate already held this leg. */
  stopBlocks: number;
  handoffRelPath: string;
}

export type RelayHookInput =
  | {
      event: 'PreToolUse' | 'PermissionRequest' | 'PostToolUse';
      tool: string;
      permissionMode?: RelayPermissionMode;
      /**
       * The tool's input as the hook received it. For ExitPlanMode Claude Code injects `plan` and
       * `planFilePath`, and an approval must echo it back whole or it is ignored.
       */
      toolInput?: Record<string, unknown>;
      /** The hook cut the plan short to send it, so it cannot be echoed back. */
      planTruncated?: boolean;
    }
  | {
      event: 'Stop';
      stopHookActive: boolean;
      permissionMode?: RelayPermissionMode;
      /** Main checks the handoff file before asking, so the gate stays pure. */
      handoffFresh: boolean;
    };

/** Facts a hook revealed, which the relay driver feeds to the runner. */
export type RelayGateObservation =
  | { type: 'modeObserved'; mode: RelayPermissionMode }
  | { type: 'hookQuestion' }
  | { type: 'questionAnswered' }
  | { type: 'planPresented'; approvable: boolean }
  | { type: 'planApproved'; mode: RelayAfterPlanMode }
  | { type: 'guardSent' }
  | { type: 'stopBlocked' }
  | { type: 'stopAllowed' };

export interface GateDecision {
  /** The JSON the hook prints, or null to print nothing and leave Claude Code to its default. */
  output: Record<string, unknown> | null;
  observations: RelayGateObservation[];
}

const QUESTIONS_HEADING =
  /^\s*(?:#{1,6}\s+|\*\*)\s*(?:(?:open|unresolved|outstanding)\s+)?questions?\b(?:\s+for\s+(?:you|the user))?[^\n]*$/i;
const ANY_HEADING = /^\s*(?:#{1,6}\s+|\*\*[^*]+\*\*\s*$)/;
/**
 * "None", "N/A", "Nothing" or "No open questions", alone or followed by an explanation, as models
 * write it: "None. The input format is not specified, so I will not validate it." Not "None of".
 */
const NONE_LEAD = /^(?:none|n\/a|nothing|no(?:\s+open)?\s+questions?)(?=$|[\s.,;:!)-])(?!\s+of\b)/i;
const SETTLED = /^(?:resolved|answered)\s*:/i;

function itemText(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s*/, '')
    .trim();
}

/** "None" with no question after it settles the whole section. */
function isNoneLine(line: string): boolean {
  const item = itemText(line);
  return NONE_LEAD.test(item) && !item.includes('?');
}

function isOpenQuestionLine(line: string): boolean {
  const item = itemText(line);
  if (!item || item === '-' || isNoneLine(item) || SETTLED.test(item)) return false;
  return !/^~~.*~~$/.test(item);
}

/**
 * True when a plan has a questions section with something still open in it: a heading or bold
 * label like "Open questions", followed by any line that is not "None", struck through, or marked
 * resolved. A plan that waits on the user is left for the user to approve.
 */
export function hasOpenQuestions(plan: string): boolean {
  const lines = plan.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = QUESTIONS_HEADING.exec(lines[index]);
    if (!match) continue;
    // A bold label can carry its question on the same line: "**Open questions:** the port".
    const inline = lines[index].replace(/^[^*]*\*\*[^*]*\*\*/, '').replace(/^\s*:?\s*/, '');
    if (lines[index].trimStart().startsWith('**') && inline && isOpenQuestionLine(inline)) {
      return true;
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      if (ANY_HEADING.test(lines[next]) || isNoneLine(lines[next])) break;
      if (isOpenQuestionLine(lines[next])) return true;
    }
  }
  return false;
}

/** A handoff counts for this leg only when it was written after the leg started. */
export function isHandoffFresh(
  handoff: { mtimeMs: number } | null,
  mtimeAtStart: number | null,
): boolean {
  if (!handoff) return false;
  return mtimeAtStart === null || handoff.mtimeMs > mtimeAtStart;
}

/** Tokens left free below the model's window, so Claude Code's own compaction never comes first. */
const WINDOW_HEADROOM = 0.8;

/**
 * Where the context guard fires: a share of the leg's budget, and never so close to the model's
 * window that the CLI compacts the conversation before the agent is told to hand off.
 */
export function guardThreshold(input: {
  budget: number;
  share: number;
  window: number | null;
}): number {
  const fromBudget = input.budget * input.share;
  const fromWindow = input.window ? input.window * WINDOW_HEADROOM : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(fromBudget, fromWindow));
}

function planText(input: { toolInput?: Record<string, unknown> }): string {
  const plan = input.toolInput?.plan;
  return typeof plan === 'string' ? plan : '';
}

function planApprovable(
  leg: GateLegView,
  input: { toolInput?: Record<string, unknown>; planTruncated?: boolean },
) {
  const plan = planText(input);
  return (
    leg.planFirst &&
    leg.phase === 'planning' &&
    leg.openQuestions === 0 &&
    plan.trim() !== '' &&
    !input.planTruncated &&
    !hasOpenQuestions(plan)
  );
}

function guardText(leg: GateLegView): string {
  const used = leg.contextPercent === null ? 'most' : `about ${leg.contextPercent}%`;
  return (
    `AgentMate Relay: this session has used ${used} of its context budget for ${leg.taskId}. ` +
    `Finish the step you are on, then rewrite ${leg.handoffRelPath} with outcome: continue and ` +
    `leg: ${leg.legNo}, so a fresh session can carry on from it, and stop.`
  );
}

function stopReason(leg: GateLegView): string {
  return (
    `Before you stop, rewrite ${leg.handoffRelPath} as the Relay guide describes: fill in all ` +
    `five sections and set outcome (done, continue or blocked), tests and leg: ${leg.legNo}. ` +
    'If you need the user to decide something, set outcome: blocked and put the question under ' +
    'Next step. Then stop.'
  );
}

/**
 * Decides what a relay leg's hook answers. Every path that is unsure answers nothing, which leaves
 * Claude Code to do what it would have done without AgentMate.
 */
export function decideRelayGate(leg: GateLegView | null, input: RelayHookInput): GateDecision {
  if (!leg) return { output: null, observations: [] };
  const observations: RelayGateObservation[] = [];
  if (input.permissionMode) observations.push({ type: 'modeObserved', mode: input.permissionMode });

  if (input.event === 'Stop') {
    const hold =
      !input.handoffFresh &&
      !input.stopHookActive &&
      leg.stopBlocks === 0 &&
      (leg.phase === 'executing' || leg.phase === 'finishing') &&
      input.permissionMode !== 'plan';
    if (!hold) return { output: null, observations: [...observations, { type: 'stopAllowed' }] };
    return {
      output: { decision: 'block', reason: stopReason(leg) },
      observations: [...observations, { type: 'stopBlocked' }],
    };
  }

  if (input.tool === 'AskUserQuestion') {
    if (input.event === 'PreToolUse') observations.push({ type: 'hookQuestion' });
    if (input.event === 'PostToolUse') observations.push({ type: 'questionAnswered' });
    return { output: null, observations };
  }

  if (input.tool === 'ExitPlanMode') {
    const approvable = planApprovable(leg, input);
    if (input.event === 'PreToolUse') {
      return {
        output: null,
        observations: [...observations, { type: 'planPresented', approvable }],
      };
    }
    if (input.event === 'PermissionRequest' && approvable) {
      return {
        output: {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              // Claude Code ignores an approval of ExitPlanMode that does not hand its input back.
              updatedInput: input.toolInput,
              updatedPermissions: [
                { type: 'setMode', mode: leg.afterPlanMode, destination: 'session' },
              ],
            },
          },
        },
        observations: [...observations, { type: 'planApproved', mode: leg.afterPlanMode }],
      };
    }
    return { output: null, observations };
  }

  if (input.event === 'PostToolUse' && leg.guardDue && leg.phase === 'executing') {
    return {
      output: {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: guardText(leg) },
      },
      observations: [...observations, { type: 'guardSent' }],
    };
  }
  return { output: null, observations };
}
