/**
 * The text side of the Remote Desktop AI task: the one-line action grammar the AI replies in, how
 * risky an action is, and the prompt that asks for the next one. Nothing here touches Electron or
 * a live session. Coordinates are always in screenshot pixels.
 */

import { comboKeys } from './rdpKeys';
import { isRiskyCommand } from './shellCommand';

export type RdpAction =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'double-click'; x: number; y: number }
  | { kind: 'right-click'; x: number; y: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'scroll'; x: number; y: number; direction: 'up' | 'down'; amount: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; combo: string }
  | { kind: 'wait'; ms: number };

export type RdpReply =
  | RdpAction
  | { kind: 'finished'; message: string }
  | { kind: 'needs-input'; message: string };

const DEFAULT_SCROLL = 3;
const MAX_SCROLL = 20;
const MAX_WAIT_MS = 10_000;
/** Same budget as the SSH runner: enough to see what was tried, small enough to stay cheap. */
const TRANSCRIPT_TAIL_CHARS = 6000;

/** One action verb at the start of a line, optionally wrapped in backticks. */
const ACTION_LINE =
  /^\s*`*\s*(DOUBLE[_-]?CLICK|RIGHT[_-]?CLICK|CLICK|MOVE|DRAG|SCROLL|TYPE|KEY|WAIT)\b:?(.*)$/gim;

/** Non-negative numbers, rounded. Null when any is missing, negative or not a number. */
function numbers(text: string, count: number): number[] | null {
  const parts = text.replace(/[(),]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== count) return null;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return values.map(Math.round);
}

function unescapeTyped(text: string): string {
  return text.replace(/\\(["\\nt])/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

function parseAction(verb: string, rest: string): RdpAction | null {
  const name = verb.toUpperCase().replace(/[_-]/g, '');
  const args = rest.trim();
  switch (name) {
    case 'CLICK':
    case 'DOUBLECLICK':
    case 'RIGHTCLICK':
    case 'MOVE': {
      const point = numbers(args, 2);
      if (!point) return null;
      const kind =
        name === 'CLICK'
          ? 'click'
          : name === 'DOUBLECLICK'
            ? 'double-click'
            : name === 'RIGHTCLICK'
              ? 'right-click'
              : 'move';
      return { kind, x: point[0] ?? 0, y: point[1] ?? 0 };
    }
    case 'DRAG': {
      const points = numbers(args, 4);
      if (!points) return null;
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = points;
      return { kind: 'drag', x1, y1, x2, y2 };
    }
    case 'SCROLL': {
      const match = args.match(
        /^\(?\s*([\d.-]+)[\s,]+([\d.-]+)\s*\)?\s+(up|down)(?:\s+([\d.-]+))?$/i,
      );
      if (!match) return null;
      const point = numbers(`${match[1]} ${match[2]}`, 2);
      const amount = match[4] === undefined ? [DEFAULT_SCROLL] : numbers(match[4], 1);
      if (!point || !amount) return null;
      return {
        kind: 'scroll',
        x: point[0] ?? 0,
        y: point[1] ?? 0,
        direction: (match[3] ?? '').toLowerCase() === 'up' ? 'up' : 'down',
        amount: Math.min(Math.max(amount[0] ?? DEFAULT_SCROLL, 1), MAX_SCROLL),
      };
    }
    case 'TYPE': {
      // Unquoted text is too easily prose ("Type the name in the box"), which must never be typed.
      const match = args.match(/^"((?:[^"\\]|\\.)*)"$/s);
      const text = match ? unescapeTyped(match[1] ?? '') : '';
      return text ? { kind: 'type', text } : null;
    }
    case 'KEY': {
      const combo = args.replace(/\s*\+\s*/g, '+').toLowerCase();
      if (!combo || /\s/.test(combo)) return null;
      return { kind: 'key', combo };
    }
    case 'WAIT': {
      const ms = numbers(args.replace(/ms$/i, ''), 1);
      if (!ms) return null;
      return { kind: 'wait', ms: Math.min(ms[0] ?? 0, MAX_WAIT_MS) };
    }
    default:
      return null;
  }
}

/**
 * Reads the AI's reply. Models wrap the line in prose, backticks or a code fence, so like
 * parseModelReply for SSH, any line counts and an action wins over FINISHED, which wins over
 * NEEDS_INPUT. A line that only starts like a verb ("Click the OK button") is skipped rather than
 * read as a broken action.
 */
export function parseRdpReply(text: string): RdpReply | null {
  for (const match of text.matchAll(ACTION_LINE)) {
    const rest = (match[2] ?? '').replace(/`+\s*$/, '');
    const action = parseAction(match[1] ?? '', rest);
    if (action) return action;
  }
  const finishedMatch = text.match(/^\s*`*\s*FINISHED:?\s*(.*?)`*\s*$/im);
  if (finishedMatch) return { kind: 'finished', message: (finishedMatch[1] ?? '').trim() };
  const needsInputMatch = text.match(/^\s*`*\s*NEEDS_INPUT:\s*(.+?)`*\s*$/im);
  if (needsInputMatch) return { kind: 'needs-input', message: (needsInputMatch[1] ?? '').trim() };
  return null;
}

function escapeTyped(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** The action in the grammar the AI writes, which parseRdpReply reads back to the same action. */
export function formatRdpAction(action: RdpAction): string {
  switch (action.kind) {
    case 'click':
      return `CLICK ${action.x} ${action.y}`;
    case 'double-click':
      return `DOUBLE_CLICK ${action.x} ${action.y}`;
    case 'right-click':
      return `RIGHT_CLICK ${action.x} ${action.y}`;
    case 'move':
      return `MOVE ${action.x} ${action.y}`;
    case 'drag':
      return `DRAG ${action.x1} ${action.y1} ${action.x2} ${action.y2}`;
    case 'scroll':
      return `SCROLL ${action.x} ${action.y} ${action.direction} ${action.amount}`;
    case 'type':
      return `TYPE "${escapeTyped(action.text)}"`;
    case 'key':
      return `KEY ${action.combo}`;
    case 'wait':
      return `WAIT ${action.ms}`;
  }
}

/**
 * Shortcuts that reach outside the window being worked in (Start, Run, the power user menu, Task
 * Manager, the secure attention screen), close it, or delete without the Recycle Bin. Right-hand
 * modifiers count as the left ones.
 */
const RISKY_COMBOS = [
  ['win'],
  ['win', 'r'],
  ['win', 'x'],
  ['alt', 'f4'],
  ['ctrl', 'alt', 'delete'],
  ['ctrl', 'shift', 'esc'],
  ['shift', 'delete'],
  ['delete'],
];

const SIDE_KEYS: Record<string, string> = { rctrl: 'ctrl', ralt: 'alt', rshift: 'shift' };

function isRiskyCombo(combo: string): boolean {
  const keys = comboKeys(combo);
  if (!keys) return false;
  const pressed = new Set(keys.map((key) => SIDE_KEYS[key] ?? key));
  return RISKY_COMBOS.some(
    (risky) => risky.length === pressed.size && risky.every((key) => pressed.has(key)),
  );
}

/**
 * Whether `approve-risky` mode stops for this action. All typed text does: it can land in a
 * terminal or the Run box as easily as in a text field. Pointer actions never do.
 */
export function isRiskyRdpAction(action: RdpAction): boolean {
  if (action.kind === 'type') return true;
  if (action.kind === 'key') return isRiskyCombo(action.combo);
  return false;
}

/** A warning to show next to an action awaiting approval, when there is more to say than "risky". */
export function riskyReason(action: RdpAction): string | undefined {
  if (action.kind === 'type' && isRiskyCommand(action.text)) {
    return 'The text looks like a destructive command.';
  }
  if (action.kind === 'key' && isRiskyCombo(action.combo)) {
    return `${action.combo} can close windows, delete files or open system tools.`;
  }
  return undefined;
}

export type RdpImageMode = 'flag' | 'mention' | 'read-tool' | 'api';

export interface RdpPromptInput {
  task: string;
  /** What the user told the AI after starting the task, oldest first. */
  followUps?: string[];
  /** What happened so far, one line per step, oldest first. */
  transcript: string;
  frameWidth: number;
  frameHeight: number;
  /** How the screenshot reaches the AI, which decides what it may do with its own tools. */
  imageMode: RdpImageMode;
}

/**
 * An agent CLI would otherwise use its own tools, which act on this machine rather than the remote
 * desktop. Claude Code needs exactly one of them to see the screenshot.
 */
function preamble(mode: RdpImageMode): string {
  if (mode === 'read-tool') {
    return (
      'Use the Read tool only to look at ./frame.png. Do not use any other tool, do not read or ' +
      'edit other files.\n\n'
    );
  }
  if (mode === 'api') return '';
  return (
    'Do not use any tools, do not read or edit local files, and do not run anything yourself. ' +
    'The screenshot is attached. Actions only happen when you reply in the format below.\n\n'
  );
}

/**
 * What the user said after starting the run, as a block right under the task. It goes in every
 * prompt rather than the transcript, whose start is cut once the task runs long.
 */
function followUpBlock(followUps: string[] | undefined): string {
  if (!followUps?.length) return '';
  const lines = followUps.map((text) => `- ${text.replace(/\n/g, '\n  ')}`);
  return `\n\nThe user added these while you were working, oldest first. They take priority over anything earlier, so change course if one asks for it:\n${lines.join('\n')}`;
}

export function buildRdpPrompt(input: RdpPromptInput): string {
  const { transcript, frameWidth, frameHeight } = input;
  const tail =
    transcript.length > TRANSCRIPT_TAIL_CHARS
      ? `…(earlier steps truncated)…${transcript.slice(-TRANSCRIPT_TAIL_CHARS)}`
      : transcript || '(no actions yet)';
  return `${preamble(input.imageMode)}You are operating a remote desktop through screenshots and mouse and keyboard actions, on behalf of a user who is watching it live.

User's task: "${input.task}"${followUpBlock(input.followUps)}

The screenshot is ${frameWidth} x ${frameHeight} pixels. Every coordinate you give is in that screenshot, with (0,0) at the top-left corner.

Reply with EXACTLY one of these lines, and nothing else:
CLICK x y
DOUBLE_CLICK x y
RIGHT_CLICK x y
MOVE x y
DRAG x1 y1 x2 y2
SCROLL x y up|down [lines, default 3]
TYPE "text" (use \\n for Enter, \\t for Tab, \\" for a quote)
KEY combo (e.g. enter, ctrl+s, alt+tab, win)
WAIT ms
FINISHED: <one short sentence summarizing what was accomplished>
NEEDS_INPUT: <a short question for the user>

Rules:
- Exactly one action per reply. You will get a new screenshot after it runs.
- Prefer keyboard shortcuts when they are reliable.
- Click into a text field before typing into it.
- If the screen did not change after your last action, try something else instead of repeating it.
- When the task is done, reply FINISHED.
- Never use NEEDS_INPUT to ask for a password unless the task truly cannot go on without one.

Transcript so far (most recent last):
${tail}`;
}
