import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyProposal,
  type BoardFile,
  type HandoffMeta,
  isRelayTaskId,
  normalizeDocsFolder,
  parseHandoff,
  parseTaskFile,
  RELAY_GUIDE_FILE,
  RELAY_HANDOFFS_DIR,
  RELAY_TASKS_DIR,
  type RelayHandoff,
  type RelayIssue,
  type RelayProposal,
  type RelayTaskStatus,
  relayGuideMarkdown,
  renderHandoffTemplate,
  setFrontMatterValue,
  setTaskStatus,
  taskIdFromFileName,
} from '@runova/core';
import type { RelayApplyResult } from '../../shared/relayTypes';

/**
 * The Relay files inside a project: `<docs>/tasks/T###-slug.md` and `<docs>/tasks/handoffs/T###.md`.
 * Runova writes task files (status, order, planned tasks) and the guide; only the sessions
 * write handoffs, apart from the empty template a first session finds.
 */

export interface RelayFolder {
  docsFolder: string;
  tasksDir: string;
  handoffsDir: string;
}

/** The docs folder is cleaned the way Blueprint cleans it, so it can never point outside. */
export function relayFolder(projectFolder: string, docsFolder: string): RelayFolder {
  const docs = normalizeDocsFolder(docsFolder);
  const tasksDir = join(projectFolder, ...docs.split('/'), RELAY_TASKS_DIR);
  return { docsFolder: docs, tasksDir, handoffsDir: join(tasksDir, RELAY_HANDOFFS_DIR) };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Written to a temporary name and renamed over, so a reader never sees half a file. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf-8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface BoardFiles {
  exists: boolean;
  guidePresent: boolean;
  /** One per task id, ordered by file name. */
  files: BoardFile[];
  issues: RelayIssue[];
}

export async function readBoardFiles(folder: RelayFolder): Promise<BoardFiles> {
  let names: string[];
  try {
    names = await readdir(folder.tasksDir);
  } catch {
    return { exists: false, guidePresent: false, files: [], issues: [] };
  }
  const files: BoardFile[] = [];
  const issues: RelayIssue[] = [];
  const seen = new Map<string, string>();
  for (const name of names.sort()) {
    if (!taskIdFromFileName(name)) continue;
    let content: string;
    try {
      content = await readFile(join(folder.tasksDir, name), 'utf-8');
    } catch {
      continue;
    }
    const task = parseTaskFile(name, content);
    const first = seen.get(task.id);
    if (first) {
      issues.push({
        field: 'files',
        message: `${task.id} is in two files, ${first} and ${name}. The board shows ${first}.`,
      });
      continue;
    }
    seen.set(task.id, name);
    files.push({ file: name, content, task });
  }
  return {
    exists: true,
    guidePresent: names.includes(RELAY_GUIDE_FILE),
    files,
    issues,
  };
}

async function findTaskFile(folder: RelayFolder, taskId: string): Promise<BoardFile | null> {
  const board = await readBoardFiles(folder);
  return board.files.find((file) => file.task.id === taskId) ?? null;
}

export async function setTaskStatusFile(
  folder: RelayFolder,
  taskId: string,
  status: RelayTaskStatus,
): Promise<boolean> {
  const file = await findTaskFile(folder, taskId);
  if (!file) return false;
  const next = setTaskStatus(file.content, status);
  if (next !== file.content) await writeAtomic(join(folder.tasksDir, file.file), next);
  return true;
}

/** Gives the tasks `order` 1, 2, 3 in the order given; the others keep theirs. */
export async function reorderTaskFiles(folder: RelayFolder, taskIds: string[]): Promise<void> {
  const board = await readBoardFiles(folder);
  const byId = new Map(board.files.map((file) => [file.task.id, file]));
  for (const [index, id] of taskIds.entries()) {
    const file = byId.get(id);
    if (!file || file.task.order === index + 1) continue;
    const next = setFrontMatterValue(file.content, 'order', String(index + 1), { after: 'epic' });
    await writeAtomic(join(folder.tasksDir, file.file), next);
  }
}

export async function applyProposalFiles(
  folder: RelayFolder,
  proposal: RelayProposal,
): Promise<RelayApplyResult> {
  const board = await readBoardFiles(folder);
  const plan = applyProposal(board.files, proposal);
  const warnings = [...plan.warnings];
  await mkdir(folder.tasksDir, { recursive: true });
  // A board started from a proposal gets its guide too; sessions are pointed at it.
  await ensureGuide(folder);
  for (const file of plan.write) {
    // The names come from core (id plus an ascii slug), so they never leave the folder.
    if (!taskIdFromFileName(file.file)) continue;
    await writeAtomic(join(folder.tasksDir, file.file), file.content);
  }
  for (const file of plan.remove) {
    if (!taskIdFromFileName(file)) continue;
    await rm(join(folder.tasksDir, file), { force: true });
  }
  for (const handoff of plan.handoffs) {
    if (!isRelayTaskId(handoff.taskId)) continue;
    if (await handoffHasWork(folder, handoff.taskId)) {
      warnings.push(`${handoff.taskId} already has a handoff, so it was kept as it is.`);
      continue;
    }
    await mkdir(folder.handoffsDir, { recursive: true });
    await writeAtomic(handoffPath(folder, handoff.taskId), handoff.content);
  }
  return {
    written: plan.write.map((file) => file.file),
    removed: plan.remove,
    warnings,
  };
}

/** A handoff a session wrote something in, as opposed to none or the untouched template. */
async function handoffHasWork(folder: RelayFolder, taskId: string): Promise<boolean> {
  const read = await readHandoff(folder, taskId);
  return read !== null && Object.values(read.handoff.sections).some((text) => text.trim() !== '');
}

export async function ensureGuide(folder: RelayFolder): Promise<void> {
  const path = join(folder.tasksDir, RELAY_GUIDE_FILE);
  if (await exists(path)) return;
  await mkdir(folder.tasksDir, { recursive: true });
  await writeAtomic(path, relayGuideMarkdown(folder.docsFolder));
}

function handoffPath(folder: RelayFolder, taskId: string): string {
  return join(folder.handoffsDir, `${taskId}.md`);
}

export async function ensureHandoffTemplate(
  folder: RelayFolder,
  task: { id: string; title: string },
): Promise<void> {
  const path = handoffPath(folder, task.id);
  if (await exists(path)) return;
  await mkdir(folder.handoffsDir, { recursive: true });
  await writeAtomic(path, renderHandoffTemplate(task));
}

export async function handoffMtime(folder: RelayFolder, taskId: string): Promise<number | null> {
  return stat(handoffPath(folder, taskId)).then(
    (info) => info.mtimeMs,
    () => null,
  );
}

export interface HandoffRead {
  handoff: RelayHandoff;
  text: string;
  meta: HandoffMeta;
}

/**
 * The hash covers the five sections only, not the front matter, so a session that bumps the leg
 * number and changes nothing else is seen as making no progress.
 */
function sectionsHash(handoff: RelayHandoff): string {
  return createHash('sha1').update(JSON.stringify(handoff.sections)).digest('hex');
}

export async function readHandoff(
  folder: RelayFolder,
  taskId: string,
): Promise<HandoffRead | null> {
  const path = handoffPath(folder, taskId);
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([
      readFile(path, 'utf-8'),
      stat(path).then((info) => info.mtimeMs),
    ]);
  } catch {
    return null;
  }
  const handoff = parseHandoff(taskId, text);
  return {
    handoff,
    text,
    meta: {
      mtimeMs,
      outcome: handoff.outcome,
      tests: handoff.tests,
      next: handoff.sections.next,
      hash: sectionsHash(handoff),
    },
  };
}
