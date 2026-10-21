import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTaskFile } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProposalFiles,
  ensureGuide,
  ensureHandoffTemplate,
  handoffMtime,
  readBoardFiles,
  readHandoff,
  relayFolder,
  reorderTaskFiles,
  setTaskStatusFile,
} from './taskFiles';

/** The task and handoff files in a project, read and written the way the board needs them. */

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'relay-files-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function tasksDir(): string {
  return join(project, 'docs', 'tasks');
}

function writeTask(file: string, content: string): void {
  mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(join(tasksDir(), file), content);
}

const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  renderTaskFile({ id, title, status: 'todo', goal: `Do ${title}.`, ...extra });

describe('relayFolder', () => {
  it('keeps the folder inside the project', () => {
    const folder = relayFolder(project, '../../outside');
    expect(folder.docsFolder).toBe('docs');
    expect(folder.tasksDir).toBe(join(project, 'docs', 'tasks'));
    expect(folder.handoffsDir).toBe(join(project, 'docs', 'tasks', 'handoffs'));
  });
});

describe('readBoardFiles', () => {
  it('says when there is no tasks folder', async () => {
    const board = await readBoardFiles(relayFolder(project, 'docs'));
    expect(board).toEqual({ exists: false, guidePresent: false, files: [], issues: [] });
  });

  it('lists the task files, ignoring everything else', async () => {
    writeTask('T002-search.md', task('T002', 'Search'));
    writeTask('T001-login.md', task('T001', 'Login'));
    writeTask('RELAY.md', '# guide');
    writeTask('notes.md', '# notes');
    const board = await readBoardFiles(relayFolder(project, 'docs'));
    expect(board.exists).toBe(true);
    expect(board.guidePresent).toBe(true);
    expect(board.files.map((file) => [file.file, file.task.id, file.task.title])).toEqual([
      ['T001-login.md', 'T001', 'Login'],
      ['T002-search.md', 'T002', 'Search'],
    ]);
  });

  it('shows the first of two files with one id and reports the other', async () => {
    writeTask('T001-a.md', task('T001', 'A'));
    writeTask('T001-b.md', task('T001', 'B'));
    const board = await readBoardFiles(relayFolder(project, 'docs'));
    expect(board.files.map((file) => file.file)).toEqual(['T001-a.md']);
    expect(board.issues).toEqual([
      { field: 'files', message: expect.stringContaining('T001-b.md') },
    ]);
  });
});

describe('writing', () => {
  it('sets a status and keeps CRLF line endings', async () => {
    writeTask('T001-login.md', task('T001', 'Login').replace(/\n/g, '\r\n'));
    const folder = relayFolder(project, 'docs');
    expect(await setTaskStatusFile(folder, 'T001', 'done')).toBe(true);
    const text = readFileSync(join(tasksDir(), 'T001-login.md'), 'utf-8');
    expect(text).toContain('status: done\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
    expect(await setTaskStatusFile(folder, 'T404', 'done')).toBe(false);
  });

  it('rewrites the order of the tasks it is given', async () => {
    writeTask('T001-a.md', task('T001', 'A', { order: 1 }));
    writeTask('T002-b.md', task('T002', 'B', { order: 2 }));
    const folder = relayFolder(project, 'docs');
    await reorderTaskFiles(folder, ['T002', 'T001']);
    const board = await readBoardFiles(folder);
    expect(board.files.map((file) => [file.task.id, file.task.order])).toEqual([
      ['T001', 2],
      ['T002', 1],
    ]);
  });

  it('applies a proposal: new files, changes and removals', async () => {
    writeTask('T001-login.md', task('T001', 'Login'));
    writeTask('T002-search.md', task('T002', 'Search', { depends: ['T001'] }));
    const folder = relayFolder(project, 'docs');
    const result = await applyProposalFiles(folder, {
      summary: '',
      add: [{ id: 'T003', title: 'Export', depends: ['T002'] }],
      change: [{ id: 'T001', title: 'Sign in' }],
      split: [],
      remove: [{ id: 'T002' }],
    });
    expect(result.written.sort()).toEqual(['T001-login.md', 'T003-export.md']);
    expect(result.removed).toEqual(['T002-search.md']);
    const board = await readBoardFiles(folder);
    expect(board.files.map((file) => [file.task.id, file.task.title])).toEqual([
      ['T001', 'Sign in'],
      ['T003', 'Export'],
    ]);
  });

  it('writes the guide and a handoff template only when they are missing', async () => {
    const folder = relayFolder(project, 'docs');
    await ensureGuide(folder);
    writeFileSync(join(tasksDir(), 'RELAY.md'), 'kept');
    await ensureGuide(folder);
    expect(readFileSync(join(tasksDir(), 'RELAY.md'), 'utf-8')).toBe('kept');

    expect(await handoffMtime(folder, 'T001')).toBeNull();
    await ensureHandoffTemplate(folder, { id: 'T001', title: 'Login' });
    const path = join(tasksDir(), 'handoffs', 'T001.md');
    expect(readFileSync(path, 'utf-8')).toContain('task: T001');
    writeFileSync(path, '---\noutcome: done\n---\n## Purpose\nX\n');
    await ensureHandoffTemplate(folder, { id: 'T001', title: 'Login' });
    expect(readFileSync(path, 'utf-8')).toContain('outcome: done');
    expect(await handoffMtime(folder, 'T001')).toBe(statSync(path).mtimeMs);
  });
});

describe('readHandoff', () => {
  it('reads the baton with what the relay decides on', async () => {
    const folder = relayFolder(project, 'docs');
    mkdirSync(folder.handoffsDir, { recursive: true });
    const body = [
      '---',
      'task: T001',
      'outcome: blocked',
      'tests: not-run',
      'leg: 2',
      '---',
      '## Purpose',
      'Login.',
      '## Done so far',
      'Form.',
      '## Decisions',
      'None.',
      '## Tried and rejected',
      'None.',
      '## Next step',
      'Which provider?',
    ].join('\n');
    writeFileSync(join(folder.handoffsDir, 'T001.md'), body);
    const read = await readHandoff(folder, 'T001');
    expect(read?.handoff).toMatchObject({ outcome: 'blocked', leg: 2, missingSections: [] });
    expect(read?.meta).toMatchObject({
      outcome: 'blocked',
      tests: 'not-run',
      next: 'Which provider?',
    });
    expect(read?.meta.hash).toMatch(/^[0-9a-f]{40}$/);

    // The same sections with a new leg number hash the same: that is a session with no progress.
    writeFileSync(join(folder.handoffsDir, 'T001.md'), body.replace('leg: 2', 'leg: 3'));
    expect((await readHandoff(folder, 'T001'))?.meta.hash).toBe(read?.meta.hash);
    expect(await readHandoff(folder, 'T404')).toBeNull();
  });
});
