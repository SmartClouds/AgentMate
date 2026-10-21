import type { HandoffSectionKey } from './types.js';

/** Folder, under the docs folder, that holds the task files. */
export const RELAY_TASKS_DIR = 'tasks';
/** Folder, under the tasks folder, that holds one handoff per task. */
export const RELAY_HANDOFFS_DIR = 'handoffs';
/** The guide AgentMate writes into the tasks folder so any agent can follow the format. */
export const RELAY_GUIDE_FILE = 'RELAY.md';

export const DEFAULT_RELAY_BUDGET = 200_000;
/** The budgets the pickers offer. A task file may still name any other number. */
export const RELAY_BUDGET_CHOICES = [100_000, 200_000, 400_000, 1_000_000] as const;

const TASK_ID = /^T\d{3,}$/;
const TASK_FILE = /^(T\d{3,})(?:-[^/\\]*)?\.md$/;
const SLUG_MAX = 48;

export function isRelayTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '');
}

/** `T001-parse-the-format.md`, or just `T001.md` when the title has nothing ascii to slug. */
export function taskFileName(id: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}

/** The id a task file is named after, or null for anything that is not a task file. */
export function taskIdFromFileName(name: string): string | null {
  return TASK_FILE.exec(name)?.[1] ?? null;
}

/** The id after the highest one in use, at least three digits wide. */
export function nextTaskId(ids: Iterable<string>): string {
  let highest = 0;
  for (const id of ids) {
    if (isRelayTaskId(id)) highest = Math.max(highest, Number(id.slice(1)));
  }
  return `T${String(highest + 1).padStart(3, '0')}`;
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function tasksFolderRelPath(docsFolder: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR);
}

export function taskRelPath(docsFolder: string, file: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, file);
}

export function handoffRelPath(docsFolder: string, taskId: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_HANDOFFS_DIR, `${taskId}.md`);
}

export function guideRelPath(docsFolder: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_GUIDE_FILE);
}

/** Reads `120000`, `120k`, `1.5M` or `120,000`. Anything else is null. */
export function parseTokenCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.replace(/[,_\s]/g, ''));
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const scale = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** `200K`, `1.5M`, `950`. */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${oneDecimal(count / 1_000_000)}M`;
  if (count >= 1_000) return `${oneDecimal(count / 1_000)}K`;
  return String(Math.round(count));
}

export interface HandoffSectionSpec {
  key: HandoffSectionKey;
  heading: string;
  /** What the section is for, as the guide and the prompts describe it. */
  hint: string;
}

/** The five parts of a handoff, in the order the template writes them. */
export const HANDOFF_SECTIONS: readonly HandoffSectionSpec[] = [
  { key: 'purpose', heading: 'Purpose', hint: 'What the task is for, in one or two sentences.' },
  {
    key: 'done',
    heading: 'Done so far',
    hint: 'What is finished and working, with the files and tests that prove it.',
  },
  {
    key: 'decisions',
    heading: 'Decisions',
    hint: 'Choices made and why, so the next session does not reopen them.',
  },
  {
    key: 'rejected',
    heading: 'Tried and rejected',
    hint: 'Approaches that were tried or ruled out, and why. Write "None." if there were none.',
  },
  {
    key: 'next',
    heading: 'Next step',
    hint: 'The exact next action. For a blocked task, the question the user must answer.',
  },
];

/** A fresh handoff, as the first session of a task finds it. */
export function renderHandoffTemplate(task: { id: string; title: string }): string {
  const sections = HANDOFF_SECTIONS.map(
    (section) => `## ${section.heading}\n\n<!-- ${section.hint} -->\n`,
  ).join('\n');
  return `---
task: ${task.id}
outcome: continue
tests: not-run
leg: 0
updated:
---

${sections}`;
}

/**
 * The guide that lives next to the tasks. Prompts point at it instead of repeating the rules, so
 * each session spends its context on the work.
 */
export function relayGuideMarkdown(docsFolder: string): string {
  const tasks = `${tasksFolderRelPath(docsFolder)}/`;
  const handoffs = `${tasks}${RELAY_HANDOFFS_DIR}/`;
  const sections = HANDOFF_SECTIONS.map(
    (section) => `- \`## ${section.heading}\`: ${section.hint}`,
  ).join('\n');
  return `# Relay

This project's work is split into tasks that each fit one AI coding session. AgentMate runs them
one after another, each in a fresh session, and every session leaves a handoff that the next one
reads first. This file is the format. AgentMate wrote it; keep it as it is.

## Files

- \`${tasks}T001-short-slug.md\`: one task per file, named after its id.
- \`${handoffs}T001.md\`: the handoff for that task, written by the session working on it.

## Task files

Each task file starts with YAML front matter:

\`\`\`yaml
id: T001            # T and at least three digits, never reused
title: Short imperative title
status: todo        # todo | in-progress | testing | done | blocked
epic: E01           # optional group label
order: 1            # optional, breaks ties between tasks that are ready together
depends: [T000]     # ids that must be done first
estimate: 90000     # context tokens one session should need
budget: 200000      # context tokens one session may use
specs: [docs/epics/01-example.md]
\`\`\`

The body has \`## Goal\`, \`## Scope\`, \`## Acceptance criteria\` (a checkbox per criterion) and
\`## Test plan\`.

AgentMate sets \`status\`. A session working on a task never edits its status or its spec; it
reports through the handoff.

### Sizing

A task must fit in one session under its budget, counting everything the session reads: the task,
the handoffs it depends on, the specs, the code it opens, and the output of the commands it runs.
Aim for an \`estimate\` of at most 60% of the budget. Split anything larger into tasks that each
end with something testable.

## Handoffs

Before a session stops, it writes \`${handoffs}<id>.md\` with this front matter:

\`\`\`yaml
task: T001
outcome: done       # done | continue | blocked
tests: passed       # passed | failed | not-run
leg: 1              # the session number the prompt gave you
updated: 2026-01-31T12:00:00Z
\`\`\`

and these sections, all of them filled in:

${sections}

Outcomes:

- \`outcome: done\`: every acceptance criterion is met and the tests pass.
- \`outcome: continue\`: the work is not finished. Use it when your context nears the budget, or
  when the prompt tells you the budget is reached. Finish the current small step, write the
  handoff so a new session can carry on without rereading everything, then stop.
- \`outcome: blocked\`: you need the user. Put the question under \`## Next step\` and stop.

Rewrite the handoff as a whole each time, so it always describes the task as it stands now. Keep
it short: the next session reads it first, and every line costs its context.
`;
}
