import { z } from 'zod';
import { formatTokenCount, nextTaskId, parseTokenCount, taskFileName } from './format.js';
import {
  renderTaskFile,
  setBodySection,
  setFrontMatterValue,
  yamlFlowList,
  yamlScalar,
} from './parse.js';
import type { RelayTask } from './types.js';

const idList = z
  .union([z.array(z.string()), z.string()])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );

const tokens = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => parseTokenCount(value));

const text = z.string().transform((value) => value.trim());

const taskFields = {
  title: z.string().trim().min(1, 'Every task needs a title.'),
  epic: z.string().trim().nullish(),
  order: z.number().nullish(),
  depends: idList.optional(),
  estimate: tokens.optional(),
  budget: tokens.optional(),
  specs: z.array(z.string()).optional(),
  goal: text.optional(),
  scope: text.optional(),
  acceptance: z.array(z.string()).optional(),
  testPlan: text.optional(),
};

const proposalTask = z.object({ id: z.string().trim().toUpperCase().optional(), ...taskFields });
const proposalChange = z
  .object(taskFields)
  .partial()
  .extend({ id: z.string().trim().toUpperCase() });

const proposalSchema = z.object({
  summary: z.string().optional().default(''),
  add: z.array(proposalTask).optional().default([]),
  change: z.array(proposalChange).optional().default([]),
  split: z
    .array(z.object({ id: z.string().trim().toUpperCase(), into: z.array(proposalTask).min(1) }))
    .optional()
    .default([]),
  remove: z
    .array(z.object({ id: z.string().trim().toUpperCase(), reason: z.string().optional() }))
    .optional()
    .default([]),
});

export type ProposalTask = z.infer<typeof proposalTask>;
export type ProposalChange = z.infer<typeof proposalChange>;
export interface ProposalSplit {
  id: string;
  into: ProposalTask[];
}
export interface ProposalRemoval {
  id: string;
  reason?: string;
}

/** What a planner proposes for the board. Nothing is written until the user applies it. */
export interface RelayProposal {
  summary: string;
  add: ProposalTask[];
  change: ProposalChange[];
  split: ProposalSplit[];
  remove: ProposalRemoval[];
}

/** The JSON object in a planner's answer, which may come wrapped in a fence or a sentence. */
function extractJson(answer: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(answer)?.[1];
  const source = fenced ?? answer;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start !== -1 && end > start ? source.slice(start, end + 1) : null;
}

export function parsePlanProposal(
  answer: string,
): { ok: true; proposal: RelayProposal } | { ok: false; error: string } {
  const json = extractJson(answer);
  if (!json) return { ok: false, error: 'The answer had no JSON plan in it.' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'The answer had JSON in it that could not be read.' };
  }
  const parsed = proposalSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
    return {
      ok: false,
      error: `The plan does not have the expected shape: ${issue.message}${where}`,
    };
  }
  return { ok: true, proposal: parsed.data as RelayProposal };
}

export interface BoardFile {
  file: string;
  content: string;
  task: RelayTask;
}

export interface ProposalPlan {
  /** Files to create or overwrite, by name inside the tasks folder. */
  write: { file: string; content: string }[];
  /** Files to delete, by name inside the tasks folder. */
  remove: string[];
  /** Parts of the proposal that were left out, and why. */
  warnings: string[];
}

/**
 * Turns a proposal into file changes. New tasks get the next free ids (references between them
 * follow), done tasks are never touched, and the tasks that depended on a split or removed task
 * move onto its parts or lose the dependency.
 */
interface AssignedIds {
  /** The id each added task gets, in proposal order. */
  added: string[];
  /** The ids each split's parts get, by the id of the task split. Only splits that may happen. */
  parts: Map<string, string[]>;
  /** The proposal's own ids, mapped to the ids they become. */
  renamed: Map<string, string>;
}

/**
 * New tasks, and the parts of a split, get the next free ids in proposal order, whatever ids the
 * planner wrote. A planner can collide with the board or skip numbers; the board never does.
 */
function assignIds(board: readonly BoardFile[], proposal: RelayProposal): AssignedIds {
  const byId = new Map(board.map((entry) => [entry.task.id, entry.task]));
  const used = new Set(byId.keys());
  const renamed = new Map<string, string>();
  const take = (task: ProposalTask): string => {
    const id = nextTaskId(used);
    used.add(id);
    if (task.id) renamed.set(task.id, id);
    return id;
  };
  const added = proposal.add.map(take);
  const parts = new Map<string, string[]>();
  for (const split of proposal.split) {
    const original = byId.get(split.id);
    if (original && original.status !== 'done') parts.set(split.id, split.into.map(take));
  }
  return { added, parts, renamed };
}

export function applyProposal(board: readonly BoardFile[], proposal: RelayProposal): ProposalPlan {
  const byId = new Map(board.map((entry) => [entry.task.id, entry]));
  const warnings: string[] = [];
  const isDone = (id: string): boolean => byId.get(id)?.task.status === 'done';
  const { added, parts, renamed } = assignIds(board, proposal);
  const newIds = new Set([...added, ...[...parts.values()].flat()]);

  const newTasks: { id: string; task: ProposalTask; inherit: string[] }[] = proposal.add.map(
    (task, index) => ({ id: added[index], task, inherit: [] }),
  );
  const removed = new Set<string>();
  const replacedBy = new Map<string, string[]>();
  for (const split of proposal.split) {
    const original = byId.get(split.id);
    const ids = parts.get(split.id);
    if (!original || !ids) {
      warnings.push(
        original
          ? `${split.id} is done, so it was not split.`
          : `${split.id} is not on the board, so it was not split.`,
      );
      continue;
    }
    split.into.forEach((task, index) => {
      newTasks.push({ id: ids[index], task, inherit: original.task.depends });
    });
    removed.add(split.id);
    replacedBy.set(split.id, ids);
  }
  for (const removal of proposal.remove) {
    if (!byId.has(removal.id)) {
      warnings.push(`${removal.id} is not on the board, so it was not removed.`);
    } else if (isDone(removal.id)) {
      warnings.push(`${removal.id} is done, so it was not removed.`);
    } else {
      removed.add(removal.id);
    }
  }

  /**
   * Maps dependencies onto real ids. Ids the proposal wrote may name its own new tasks, so those
   * go through the renames first; a board task's existing dependencies only follow splits and
   * removals.
   */
  const resolve = (depends: readonly string[], owner: string, fromProposal: boolean): string[] => {
    const out: string[] = [];
    for (const dep of depends) {
      const target = (fromProposal && renamed.get(dep)) || dep;
      const expanded = replacedBy.get(target) ?? [target];
      for (const id of expanded) {
        if (id === owner || removed.has(id)) continue;
        if (!byId.has(id) && !newIds.has(id)) {
          warnings.push(`${owner} depended on ${dep}, which does not exist; that was dropped.`);
          continue;
        }
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  };

  const write: ProposalPlan['write'] = newTasks.map(({ id, task, inherit }) => {
    const own = Boolean(task.depends?.length);
    const depends = resolve(own ? (task.depends ?? []) : inherit, id, own);
    return {
      file: taskFileName(id, task.title),
      content: renderTaskFile({ ...task, id, status: 'todo', depends }),
    };
  });

  const changes = new Map<string, ProposalChange>();
  for (const change of proposal.change) {
    if (!byId.has(change.id))
      warnings.push(`${change.id} is not on the board, so it was not changed.`);
    else if (isDone(change.id)) warnings.push(`${change.id} is done, so it was not changed.`);
    else if (removed.has(change.id))
      warnings.push(`${change.id} is split or removed, so it was not changed.`);
    else changes.set(change.id, change);
  }

  for (const entry of board) {
    const { task } = entry;
    if (removed.has(task.id) || task.status === 'done') continue;
    const change = changes.get(task.id);
    const depends = change?.depends
      ? resolve(change.depends, task.id, true)
      : resolve(task.depends, task.id, false);
    const dependsChanged = depends.join(',') !== task.depends.join(',');
    if (!change && !dependsChanged) continue;

    let content = entry.content;
    if (dependsChanged || change?.depends) {
      content = setFrontMatterValue(
        content,
        'depends',
        depends.length > 0 ? yamlFlowList(depends) : null,
      );
    }
    if (change) content = applyChange(content, change);
    write.push({ file: entry.file, content });
  }

  const remove = board.filter((entry) => removed.has(entry.task.id)).map((entry) => entry.file);
  return { write, remove, warnings };
}

function applyChange(content: string, change: ProposalChange): string {
  let next = content;
  if (change.title) next = setFrontMatterValue(next, 'title', yamlScalar(change.title));
  if (change.epic !== undefined)
    next = setFrontMatterValue(next, 'epic', change.epic ? yamlScalar(change.epic) : null);
  if (change.order !== undefined)
    next = setFrontMatterValue(next, 'order', change.order === null ? null : String(change.order));
  if (change.estimate !== undefined) {
    next = setFrontMatterValue(
      next,
      'estimate',
      change.estimate === null ? null : String(change.estimate),
    );
  }
  if (change.budget !== undefined) {
    next = setFrontMatterValue(
      next,
      'budget',
      change.budget === null ? null : String(change.budget),
    );
  }
  if (change.specs)
    next = setFrontMatterValue(
      next,
      'specs',
      change.specs.length > 0 ? yamlFlowList(change.specs) : null,
    );
  if (change.goal) next = setBodySection(next, 'Goal', change.goal);
  if (change.scope) next = setBodySection(next, 'Scope', change.scope);
  if (change.acceptance?.length) {
    next = setBodySection(
      next,
      'Acceptance criteria',
      change.acceptance.map((item) => `- [ ] ${item.trim()}`).join('\n'),
    );
  }
  if (change.testPlan) next = setBodySection(next, 'Test plan', change.testPlan);
  return next;
}

export interface ProposalFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface ProposalEntry {
  kind: 'add' | 'change' | 'split' | 'remove';
  id: string;
  title: string;
  fields: ProposalFieldChange[];
  /** The parts a split makes, as the proposal names them. */
  parts?: { id: string; title: string }[];
  reason?: string;
}

function show(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(field === 'acceptance' ? '; ' : ', ');
  if ((field === 'estimate' || field === 'budget') && typeof value === 'number') {
    return formatTokenCount(value);
  }
  return String(value);
}

const DIFF_FIELDS = [
  'title',
  'epic',
  'depends',
  'estimate',
  'budget',
  'goal',
  'scope',
  'acceptance',
  'testPlan',
] as const;

/** What a proposal would do, entry by entry, for the review step before anything is applied. */
export function diffProposal(
  board: readonly BoardFile[],
  proposal: RelayProposal,
): ProposalEntry[] {
  const byId = new Map(board.map((entry) => [entry.task.id, entry.task]));
  const ids = assignIds(board, proposal);
  const entries: ProposalEntry[] = proposal.add.map((task, index) => ({
    kind: 'add',
    id: ids.added[index],
    title: task.title,
    fields: [],
  }));
  for (const change of proposal.change) {
    const task = byId.get(change.id);
    const before: Record<string, unknown> = task
      ? {
          title: task.title,
          epic: task.epic,
          depends: task.depends,
          estimate: task.estimate,
          budget: task.budget,
        }
      : {};
    const fields: ProposalFieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const after = change[field];
      if (after === undefined) continue;
      const was = show(field, before[field]);
      const now = show(field, after);
      if (was !== now) fields.push({ field, before: was, after: now });
    }
    entries.push({
      kind: 'change',
      id: change.id,
      title: change.title ?? task?.title ?? change.id,
      fields,
    });
  }
  for (const split of proposal.split) {
    const partIds = ids.parts.get(split.id);
    entries.push({
      kind: 'split',
      id: split.id,
      title: byId.get(split.id)?.title ?? split.id,
      fields: [],
      parts: split.into.map((task, index) => ({ id: partIds?.[index] ?? '', title: task.title })),
    });
  }
  for (const removal of proposal.remove) {
    entries.push({
      kind: 'remove',
      id: removal.id,
      title: byId.get(removal.id)?.title ?? removal.id,
      fields: [],
      reason: removal.reason,
    });
  }
  return entries;
}
