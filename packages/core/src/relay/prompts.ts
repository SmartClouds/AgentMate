import {
  formatTokenCount,
  guideRelPath,
  handoffRelPath,
  taskRelPath,
  tasksFolderRelPath,
} from './format.js';
import { TIGHT_ESTIMATE_SHARE } from './graph.js';
import type { RelayTaskStatus } from './types.js';

export interface LegPromptInput {
  task: { id: string; title: string; file: string };
  docsFolder: string;
  legNo: number;
  continuation: boolean;
  budget: number;
  /** Direct dependencies only: their handoffs are worth reading, the rest of the chain is not. */
  dependsOn: string[];
  commitPerTask: boolean;
  /** The AgentMate relay MCP server is available to this session. */
  mcp: boolean;
  planFirst: boolean;
}

/**
 * Claude Code gets the leg prompt as a command-line argument, and Windows PowerShell 5.1 splits
 * the arguments it hands a native program at any double quote inside them. So the prompt holds
 * none, and a title's own quotes and line breaks are softened.
 */
function commandLineSafe(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/**
 * The prompt that starts one session on one task. It points at files instead of quoting them, so
 * it stays short (it may travel as a command-line argument) and every session reads the current
 * version of the task and its handoff.
 */
export function buildLegPrompt(input: LegPromptInput): string {
  const { task, docsFolder, legNo } = input;
  const handoff = handoffRelPath(docsFolder, task.id);
  const read = [
    `- ${taskRelPath(docsFolder, task.file)} (the task)`,
    `- ${handoff} (its handoff${input.continuation ? ', which says where the last session stopped' : '. When it already records work, build on it from its Next step'})`,
    ...input.dependsOn.map(
      (id) => `- ${handoffRelPath(docsFolder, id)} (handoff of ${id}, which this task builds on)`,
    ),
  ];
  const lines = [
    `AgentMate Relay: task ${task.id} (${commandLineSafe(task.title)}), session ${legNo}.`,
    '',
    `Read ${guideRelPath(docsFolder)} first and follow it. Then read:`,
    ...read,
    '',
  ];
  if (input.continuation) {
    lines.push(
      'An earlier session ran out of context budget. Carry on from the Next step in the handoff and do not redo finished work.',
    );
  }
  if (input.planFirst) {
    lines.push(
      'Start by planning. If anything needs my decision, list it under an Open questions heading in the plan instead of guessing. Leave that heading out when nothing does.',
    );
  }
  lines.push(
    'Work test-first: a failing test for each acceptance criterion, then the code, then a refactor with the tests green.',
    `This session may use ${formatTokenCount(input.budget)} tokens of context. When you near it, or AgentMate says it is reached, finish the current step, write the handoff with outcome: continue and stop.`,
    `Before you stop, rewrite ${handoff}: all five sections, outcome, tests and leg: ${legNo}.`,
  );
  if (input.commitPerTask) {
    lines.push(
      `When the task is done and its tests pass, commit only the files this task changed (never git add -A), with a message that starts with ${task.id}:.`,
    );
  }
  if (input.mcp) lines.push('Call the agentmate_relay finish_leg tool as your very last action.');
  lines.push('Do not edit the task file itself; AgentMate keeps its status.');
  return lines.join('\n');
}

/** The JSON a planner answers with. Both decomposing and revising use it. */
export const RELAY_PROPOSAL_SHAPE = `{
  "summary": "one or two sentences on what you planned",
  "add": [
    {
      "id": "T014",
      "title": "Short imperative title",
      "epic": "E01 or null",
      "depends": ["T013"],
      "estimate": 90000,
      "specs": ["docs/epics/01-example.md"],
      "goal": "What the task achieves",
      "scope": "What it touches and what it leaves alone",
      "acceptance": ["One checkable criterion per entry"],
      "testPlan": "The tests that prove it"
    }
  ],
  "change": [{ "id": "T004", "title": "Only the fields that change" }],
  "split": [{ "id": "T005", "into": [{ "id": "T015", "title": "First part" }] }],
  "remove": [{ "id": "T009", "reason": "Why it is no longer needed" }]
}`;

function sizingRules(budget: number): string {
  const ceiling = formatTokenCount(Math.round(budget * TIGHT_ESTIMATE_SHARE));
  return `Every task runs in its own fresh AI coding session that may use at most ${formatTokenCount(budget)} tokens of context. That covers everything the session reads: the task, the specs and code it opens, and the output of the commands and tests it runs. Give each task an "estimate" of that context in tokens and keep it at or under ${ceiling}. Split anything larger. Every task must end with something that can be tested.`;
}

export interface DecomposeInput {
  projectName: string;
  request: string;
  docsFolder: string;
  budget: number;
  firstId: string;
  existing: { id: string; title: string; status: RelayTaskStatus }[];
}

/** Asks a planner to break a request into context-sized tasks. Answered as JSON, nothing written. */
export function buildDecomposeRequest(input: DecomposeInput): string {
  const board =
    input.existing.length > 0
      ? input.existing.map((task) => `- ${task.id} ${task.title} (${task.status})`).join('\n')
      : '- none yet';
  return `You are planning work for the project "${input.projectName}". Look at the repository to understand it, but do not change any file.

Break the request below into tasks for AgentMate Relay, which runs them one after another.

${sizingRules(input.budget)}

Number the new tasks from ${input.firstId} upward, in the order they should run. Use "depends" for tasks that must be done first, including tasks already on the board. Link the docs a task implements under "specs" (paths relative to the repository; the task files live in ${tasksFolderRelPath(input.docsFolder)}/).

Tasks already on the board:
${board}

The request:
"""
${input.request.trim()}
"""

Answer with only the JSON below, filling in "add" and leaving the other lists empty. No prose before or after it.

${RELAY_PROPOSAL_SHAPE}`;
}

export interface ReviseInput {
  projectName: string;
  docsFolder: string;
  budget: number;
  firstId: string;
  tasks: {
    id: string;
    title: string;
    status: RelayTaskStatus;
    depends: string[];
    estimate: number | null;
  }[];
  note?: string;
}

/**
 * Asks a planner to bring the tasks back in line with the project's docs (the SDD source). It may
 * add, change, split and remove tasks, but never touch one that is done.
 */
export function buildReviseRequest(input: ReviseInput): string {
  const board = input.tasks
    .map((task) => {
      const depends = task.depends.length > 0 ? ` depends ${task.depends.join(', ')}` : '';
      const estimate =
        task.estimate !== null ? `, estimate ${formatTokenCount(task.estimate)}` : '';
      return `- ${task.id} ${task.title} [${task.status}]${depends}${estimate}`;
    })
    .join('\n');
  const note = input.note?.trim()
    ? `\nWhat the user wants changed:\n"""\n${input.note.trim()}\n"""\n`
    : '';
  return `You are revising the task plan of the project "${input.projectName}". Read the docs in ${input.docsFolder}/ (the specs are the source of truth) and the task files in ${tasksFolderRelPath(input.docsFolder)}/, and look at the code where it helps. Do not change any file.

Compare the tasks with the docs and propose what should change so the tasks deliver exactly what the docs describe:
- add tasks for work the docs ask for that no task covers;
- change tasks whose text no longer matches the docs;
- split tasks that are too big for one session;
- remove tasks the docs no longer need.

${sizingRules(input.budget)}

Rules:
- Never change, split or remove a task that is done.
- Keep the ids of the tasks you change. Number new tasks, including the parts of a split, from ${input.firstId} upward.
- In "change", give only the fields that change.
- When nothing needs to change, answer with empty lists.

The board now:
${board}
${note}
Answer with only the JSON below. No prose before or after it.

${RELAY_PROPOSAL_SHAPE}`;
}

/** The proposal shape for catching up: new tasks may be finished, and may carry a handoff. */
export const CATCH_UP_PROPOSAL_SHAPE = `{
  "summary": "two or three sentences: where the project stands and what is left",
  "add": [
    {
      "id": "T001",
      "title": "Short imperative title",
      "status": "done or todo",
      "epic": "E01 or null",
      "depends": [],
      "estimate": 90000,
      "specs": ["docs/epics/01-example.md"],
      "goal": "What the task achieves",
      "scope": "What it touches and what it leaves alone",
      "acceptance": ["One checkable criterion per entry"],
      "testPlan": "The tests that prove it",
      "handoff": {
        "done": "What already exists and works, with the files and tests that show it",
        "decisions": "Choices already made in the code that later work must respect",
        "rejected": "Approaches the history shows were dropped, or None.",
        "next": "For unfinished work, the exact next action"
      }
    }
  ],
  "change": [{ "id": "T004", "status": "done", "handoff": { "done": "..." } }],
  "split": [],
  "remove": []
}`;

export interface CatchUpInput {
  projectName: string;
  docsFolder: string;
  budget: number;
  firstId: string;
  tasks: ReviseInput['tasks'];
  /** Put finished work on the board as done tasks. */
  recordDone: boolean;
  note?: string;
}

/**
 * Asks a planner to work out where a project already under way stands, from its code, docs and
 * history, and to turn what is left into Relay tasks. Half-done work gets a handoff that says
 * where it stands, so its first session carries on instead of starting over.
 */
export function buildCatchUpRequest(input: CatchUpInput): string {
  const board =
    input.tasks.length > 0
      ? input.tasks
          .map((task) => {
            const depends = task.depends.length > 0 ? ` depends ${task.depends.join(', ')}` : '';
            const estimate =
              task.estimate !== null ? `, estimate ${formatTokenCount(task.estimate)}` : '';
            return `- ${task.id} ${task.title} [${task.status}]${depends}${estimate}`;
          })
          .join('\n')
      : '- none yet';
  const finished = input.recordDone
    ? `- Finished work: add a few tasks with "status": "done", one per finished feature or epic (not one per commit), so the board shows the progress and later tasks can depend on them. Give each a "handoff" whose "done" says where the work lives and which tests cover it, and whose "decisions" holds what later tasks must respect.`
    : `- Finished work: do not add tasks for finished work. Mention what later tasks build on in their own "handoff" instead.`;
  const note = input.note?.trim()
    ? `\nWhat the user says about the project:\n"""\n${input.note.trim()}\n"""\n`
    : '';
  return `You are taking over the project "${input.projectName}", which is already under way, so that AgentMate Relay can finish it. Do not change any file.

Work out where the project stands:
- what it is meant to deliver: read the README and every plan you find, such as the docs in ${input.docsFolder}/, a roadmap, a backlog, epics, a delivery status or TODO notes;
- what is already built: read the code and its tests, and the git history (git log) if you can run it;
- what is half done and what is not started.

Then plan the rest as tasks that AgentMate Relay runs one after another.

${sizingRules(input.budget)}

How to record what you find:
${finished}
- Half done work: a task with "status": "todo" whose "handoff" has "done" (what exists and works now, with the files) and "next" (the exact next action), so its first session carries on instead of starting over.
- Work not started: tasks with "status": "todo" and no handoff.
- Plan only what the plans and the code point at. When they disagree, follow the code for what is done and the plans for what is left, and say so in "summary".

Rules for the tasks already on the board:
- Never change, split or remove a task that is done.
- When the code shows a board task is finished, list it under "change" with "status": "done" and a "handoff".
- Change or split board tasks that no longer match the plans, keeping their ids.
- Number new tasks from ${input.firstId} upward, in the order they should run. Use "depends" for tasks that must be done first.

The board now:
${board}
${note}
Answer with only the JSON below. No prose before or after it.

${CATCH_UP_PROPOSAL_SHAPE}`;
}

/**
 * The part of a Blueprint prompt that asks for Relay task files in place of a backlog. AgentMate
 * writes the guide into the project before the prompt runs.
 */
export function blueprintRelaySection(docsFolder: string, budget: number): string {
  const tasks = `${tasksFolderRelPath(docsFolder)}/`;
  const ceiling = formatTokenCount(Math.round(budget * TIGHT_ESTIMATE_SHARE));
  return `Write the backlog as task files in \`${tasks}\`; there is no separate backlog file. AgentMate runs them one after another, each in a fresh AI coding session that may use at most ${formatTokenCount(budget)} tokens of context, so every task must be small enough to finish within that budget.

AgentMate has put the format in \`${guideRelPath(docsFolder)}\`. Read it and follow it exactly:
- one file per task, named like \`T001-short-slug.md\`, numbered in delivery order from T001;
- YAML front matter with \`id\`, \`title\`, \`status: todo\`, \`epic\`, \`order\`, \`depends\`, \`estimate\`, \`budget: ${budget}\` and \`specs\`;
- the sections Goal, Scope, Acceptance criteria (one checkbox each) and Test plan;
- an \`estimate\` of the context one session needs (the task, the specs and code it reads, and the output of the tests it runs), at or under ${ceiling}. Split any task that would need more, so every task ends with something testable;
- \`depends\` lists only the tasks that must be done first, and \`specs\` links the epic the task belongs to.

Link each epic to its task files. Do not write any handoff files; each session writes its own.`;
}
