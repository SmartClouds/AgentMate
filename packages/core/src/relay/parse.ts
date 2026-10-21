import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { HANDOFF_SECTIONS, isRelayTaskId, parseTokenCount, taskIdFromFileName } from './format.js';
import {
  type HandoffSectionKey,
  RELAY_OUTCOMES,
  RELAY_TASK_STATUSES,
  RELAY_TEST_RESULTS,
  type RelayHandoff,
  type RelayIssue,
  type RelayOutcome,
  type RelayTask,
  type RelayTaskDraft,
  type RelayTaskStatus,
  type RelayTestResult,
} from './types.js';

interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  issue: RelayIssue | null;
}

/** Splits `---` front matter off a Markdown file. Never throws: a bad block becomes an issue. */
function splitFrontMatter(text: string): FrontMatter {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return {
      data: {},
      body: normalized,
      issue: { field: 'frontMatter', message: 'The file has no front matter.' },
    };
  }
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (close === -1) {
    return {
      data: {},
      body: normalized,
      issue: { field: 'frontMatter', message: 'The front matter is never closed with ---.' },
    };
  }
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '');
  try {
    const parsed: unknown = parseYaml(lines.slice(1, close).join('\n'));
    const data =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { data, body, issue: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unreadable';
    return {
      data: {},
      body,
      issue: { field: 'frontMatter', message: `The front matter is not valid YAML: ${reason}` },
    };
  }
}

function text(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function list(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value == null
        ? []
        : [value];
  return items.map((item) => text(item)).filter((item): item is string => Boolean(item));
}

const STATUS_ALIASES: Record<string, RelayTaskStatus> = {
  'to-do': 'todo',
  open: 'todo',
  pending: 'todo',
  wip: 'in-progress',
  doing: 'in-progress',
  started: 'in-progress',
  'in-review': 'testing',
  review: 'testing',
  verifying: 'testing',
  complete: 'done',
  completed: 'done',
  stuck: 'blocked',
};

function normalizeWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Reads a known value or an alias of one. Undefined means the field is absent, null that it holds
 * something unrecognised. Aliases cover spellings a person writes by hand (`In Progress`, `to-do`);
 * anything looser is reported rather than guessed at.
 */
function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Record<string, T> = {},
): T | null | undefined {
  const raw = text(value);
  if (raw === null) return undefined;
  const word = normalizeWord(raw);
  if ((allowed as readonly string[]).includes(word)) return word as T;
  return aliases[word] ?? null;
}

function readStatus(value: unknown, issues: RelayIssue[]): RelayTaskStatus {
  const status = pick(value, RELAY_TASK_STATUSES, STATUS_ALIASES);
  if (status === undefined) return 'todo';
  if (status === null) {
    issues.push({
      field: 'status',
      message: `"${text(value)}" is not a status. Use one of ${RELAY_TASK_STATUSES.join(', ')}.`,
    });
    return 'todo';
  }
  return status;
}

function readTokens(field: string, value: unknown, issues: RelayIssue[]): number | null {
  if (value == null || value === '') return null;
  const count = parseTokenCount(value);
  if (count === null) {
    issues.push({ field, message: `"${text(value)}" is not a token count, like 120000 or 120k.` });
  }
  return count;
}

function readDepends(value: unknown, id: string, issues: RelayIssue[]): string[] {
  const ids = list(value).map((item) => item.toUpperCase());
  const bad = ids.filter((item) => !isRelayTaskId(item) || item === id);
  if (bad.length > 0) {
    issues.push({
      field: 'depends',
      message: `Ignored ${bad.map((item) => `"${item}"`).join(', ')}: not another task's id.`,
    });
  }
  return [...new Set(ids.filter((item) => isRelayTaskId(item) && item !== id))];
}

function titleFrom(body: string, file: string, id: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  if (heading) return heading;
  const slug = /^T\d{3,}-(.+)\.md$/.exec(file)?.[1];
  return slug ? slug.replace(/-+/g, ' ') : id;
}

const ACCEPTANCE_HEADING = /^#{1,4}\s+.*acceptance/i;
const ANY_HEADING = /^#{1,4}\s+/;
const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]/;

/** Counts the checkboxes under the acceptance heading, or in the whole body when it has none. */
function countAcceptance(body: string): { checked: number; total: number } {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => ACCEPTANCE_HEADING.test(line));
  let scope = lines;
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && ANY_HEADING.test(line));
    scope = lines.slice(start + 1, end === -1 ? undefined : end);
  }
  let checked = 0;
  let total = 0;
  for (const line of scope) {
    const match = CHECKBOX.exec(line);
    if (!match) continue;
    total += 1;
    if (match[1] !== ' ') checked += 1;
  }
  return { checked, total };
}

/**
 * Reads a task file the way a person would: an unknown status, a stray dependency or broken
 * front matter becomes an issue on the card, and the rest of the task still shows.
 */
export function parseTaskFile(file: string, content: string): RelayTask {
  const { data, body, issue } = splitFrontMatter(content);
  const issues: RelayIssue[] = issue ? [issue] : [];
  const fileId = taskIdFromFileName(file);
  const declared = text(data.id)?.toUpperCase() ?? null;
  let id = fileId ?? '';
  if (declared && isRelayTaskId(declared)) {
    if (fileId && declared !== fileId) {
      issues.push({
        field: 'id',
        message: `The front matter says ${declared} but the file is named for ${fileId}.`,
      });
    }
    id = declared;
  } else if (declared) {
    issues.push({ field: 'id', message: `"${declared}" is not a task id like T001.` });
  }

  const order = typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : null;
  return {
    id,
    title: text(data.title) ?? titleFrom(body, file, id),
    status: readStatus(data.status, issues),
    epic: text(data.epic),
    order,
    depends: readDepends(data.depends, id, issues),
    estimate: readTokens('estimate', data.estimate, issues),
    budget: readTokens('budget', data.budget, issues),
    specs: list(data.specs),
    file,
    body,
    acceptance: countAcceptance(body),
    issues,
  };
}

/** Headings a handoff section is recognised by. Checked in this order, first match wins. */
const SECTION_PATTERNS: readonly [HandoffSectionKey, RegExp][] = [
  ['rejected', /rejected|ruled out|dead ends?|tried/i],
  ['decisions', /^decisions?\b/i],
  ['next', /^next\b/i],
  ['purpose', /^(purpose|goal|why)\b/i],
  ['done', /^(done|what (has been|was|is) done|progress|completed)\b/i],
];

const HEADING = /^#{1,4}\s+(.+?)\s*#*\s*$/;

function sectionFor(heading: string): HandoffSectionKey | null {
  return SECTION_PATTERNS.find(([, pattern]) => pattern.test(heading))?.[0] ?? null;
}

function readSections(body: string): Record<HandoffSectionKey, string> {
  const collected: Record<HandoffSectionKey, string[]> = {
    purpose: [],
    done: [],
    decisions: [],
    rejected: [],
    next: [],
  };
  let current: HandoffSectionKey | null = null;
  for (const line of body.split('\n')) {
    const heading = HEADING.exec(line)?.[1];
    const key = heading ? sectionFor(heading) : null;
    if (key) {
      current = key;
      continue;
    }
    if (current) collected[current].push(line);
  }
  const clean = (lines: string[]): string =>
    lines
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
  return {
    purpose: clean(collected.purpose),
    done: clean(collected.done),
    decisions: clean(collected.decisions),
    rejected: clean(collected.rejected),
    next: clean(collected.next),
  };
}

const TEST_ALIASES: Record<string, RelayTestResult> = {
  pass: 'passed',
  fail: 'failed',
  'not-run-yet': 'not-run',
  none: 'not-run',
  skipped: 'not-run',
};

/** Reads the baton a session left. The app trusts only what parses; the rest becomes an issue. */
export function parseHandoff(taskId: string, content: string): RelayHandoff {
  const { data, body, issue } = splitFrontMatter(content);
  const issues: RelayIssue[] = issue ? [issue] : [];

  const declaredTask = text(data.task)?.toUpperCase();
  if (declaredTask && declaredTask !== taskId) {
    issues.push({ field: 'task', message: `This handoff says it is for ${declaredTask}.` });
  }

  const outcome = pick<RelayOutcome>(data.outcome, RELAY_OUTCOMES);
  if (outcome === null) {
    issues.push({
      field: 'outcome',
      message: `"${text(data.outcome)}" is not an outcome. Use done, continue or blocked.`,
    });
  }
  const tests = pick<RelayTestResult>(data.tests, RELAY_TEST_RESULTS, TEST_ALIASES);
  if (tests === null) {
    issues.push({
      field: 'tests',
      message: `"${text(data.tests)}" is not a test result. Use passed, failed or not-run.`,
    });
  }
  const leg = typeof data.leg === 'number' && Number.isInteger(data.leg) ? data.leg : null;
  const sections = readSections(body);

  return {
    taskId,
    outcome: outcome ?? null,
    tests: tests ?? null,
    leg,
    updated: text(data.updated),
    sections,
    missingSections: HANDOFF_SECTIONS.map((section) => section.key).filter(
      (key) => sections[key] === '',
    ),
    issues,
  };
}

interface SplitLines {
  bom: string;
  eol: string;
  lines: string[];
  /** Index of the closing `---`, or -1 when the file has no front matter. */
  close: number;
}

function splitLines(content: string): SplitLines {
  const bom = content.startsWith('﻿') ? '﻿' : '';
  const raw = content.slice(bom.length);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const close =
    lines[0]?.trim() === '---'
      ? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
      : -1;
  return { bom, eol, lines, close };
}

/** The lines a top-level key spans: its own, plus any indented continuation (a block list). */
function keySpan(lines: string[], close: number, key: string): [number, number] | null {
  const pattern = new RegExp(`^${key}\\s*:`);
  const start = lines.findIndex((line, index) => index > 0 && index < close && pattern.test(line));
  if (start === -1) return null;
  // A key with nothing after its colon owns the lines below it: indented ones, and a block list
  // written flush left (`specs:` then `- a`), which YAML allows too.
  const opensBlock = /:\s*(#.*)?$/.test(lines[start]);
  let end = start + 1;
  while (
    end < close &&
    (/^\s+\S/.test(lines[end]) || (opensBlock && /^-(\s|$)/.test(lines[end])))
  ) {
    end += 1;
  }
  return [start, end];
}

/**
 * Sets one top-level front matter key to an already rendered YAML value, or removes it when the
 * value is null. Only that key's lines change, so the rest of the file keeps its formatting, its
 * comments and its line endings. A new key goes after `after` when that key is a one-liner, else
 * at the end of the front matter.
 */
export function setFrontMatterValue(
  content: string,
  key: string,
  value: string | null,
  options: { after?: string } = {},
): string {
  const { bom, eol, lines, close } = splitLines(content);
  if (close === -1) {
    if (value === null) return content;
    return `${bom}---${eol}${key}: ${value}${eol}---${eol}${lines.join(eol)}`;
  }

  const span = keySpan(lines, close, key);
  if (span) {
    const [start, end] = span;
    if (value === null) {
      lines.splice(start, end - start);
    } else if (end === start + 1) {
      lines[start] = lines[start].replace(
        new RegExp(`^(${key}\\s*:\\s*)(.*?)(\\s+#.*)?$`),
        (_match, prefix: string, _old: string, comment: string | undefined) =>
          `${prefix}${value}${comment ?? ''}`,
      );
    } else {
      lines.splice(start, end - start, `${key}: ${value}`);
    }
    return bom + lines.join(eol);
  }
  if (value === null) return content;

  const anchor = options.after ? keySpan(lines, close, options.after) : null;
  // A block-scalar value continues below its key, so a new key never goes in the middle of it.
  const oneLine = anchor && anchor[1] === anchor[0] + 1 && !/[|>][-+]?\s*$/.test(lines[anchor[0]]);
  lines.splice(oneLine ? anchor[1] : close, 0, `${key}: ${value}`);
  return bom + lines.join(eol);
}

/**
 * Sets a task's status by rewriting only its `status:` line, so a file a person or an agent wrote
 * keeps its formatting, comments and line endings. A missing line is added after the title.
 */
export function setTaskStatus(content: string, status: RelayTaskStatus): string {
  return setFrontMatterValue(content, 'status', status, { after: 'title' });
}

/**
 * Replaces the text under a `## heading` of a task's body, or appends the section when the body
 * has none. Headings are matched without regard to case.
 */
export function setBodySection(content: string, heading: string, text: string): string {
  const { bom, eol, lines } = splitLines(content);
  const wanted = heading.toLowerCase();
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1].toLowerCase() === wanted);
  const block = ['', ...text.trim().split('\n'), ''];
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${heading}`, ...block);
    return bom + lines.join(eol);
  }
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s+/.test(lines[end])) end += 1;
  lines.splice(start + 1, end - start - 1, ...block);
  return bom + lines.join(eol);
}

export function yamlScalar(value: string): string {
  return stringifyYaml(value).trimEnd();
}

export function yamlFlowList(values: readonly string[]): string {
  return `[${values.map((value) => (/^[\w./-]+$/.test(value) ? value : JSON.stringify(value))).join(', ')}]`;
}

const scalar = yamlScalar;

/** Writes a new task file, front matter first, leaving out whatever the draft does not set. */
export function renderTaskFile(draft: RelayTaskDraft): string {
  const front = [`id: ${draft.id}`, `title: ${scalar(draft.title)}`];
  front.push(`status: ${draft.status ?? 'todo'}`);
  if (draft.epic) front.push(`epic: ${scalar(draft.epic)}`);
  if (draft.order != null) front.push(`order: ${draft.order}`);
  if (draft.depends && draft.depends.length > 0)
    front.push(`depends: [${draft.depends.join(', ')}]`);
  if (draft.estimate != null) front.push(`estimate: ${draft.estimate}`);
  if (draft.budget != null) front.push(`budget: ${draft.budget}`);
  if (draft.specs && draft.specs.length > 0) {
    front.push('specs:', ...draft.specs.map((spec) => `  - ${scalar(spec)}`));
  }

  const sections: string[] = [];
  if (draft.goal?.trim()) sections.push(`## Goal\n\n${draft.goal.trim()}`);
  if (draft.scope?.trim()) sections.push(`## Scope\n\n${draft.scope.trim()}`);
  const criteria = (draft.acceptance ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length > 0) {
    sections.push(
      `## Acceptance criteria\n\n${criteria.map((item) => `- [ ] ${item}`).join('\n')}`,
    );
  }
  if (draft.testPlan?.trim()) sections.push(`## Test plan\n\n${draft.testPlan.trim()}`);

  return `---\n${front.join('\n')}\n---\n${sections.length > 0 ? `\n${sections.join('\n\n')}\n` : ''}`;
}
