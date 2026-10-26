import { describe, expect, it } from 'vitest';
import { parseHandoff, parseTaskFile, renderTaskFile, setTaskStatus } from './parse.js';

const TASK = `---
id: T003
title: "Board columns: drag and drop"
status: in-progress
epic: E02
order: 3
depends: [T001, t002]
estimate: 90k
budget: 200000
specs:
  - docs/epics/02-board.md
---

## Goal

Cards move between columns.

## Acceptance criteria

- [x] A card can be dragged to another column
- [ ] Alt+Arrow moves the focused card
- [ ] The move survives a reload

## Test plan

Renderer tests with a fake bridge.
`;

describe('parseTaskFile', () => {
  it('reads every field of a well-formed task', () => {
    const task = parseTaskFile('T003-board-columns.md', TASK);
    expect(task).toMatchObject({
      id: 'T003',
      title: 'Board columns: drag and drop',
      status: 'in-progress',
      epic: 'E02',
      order: 3,
      depends: ['T001', 'T002'],
      estimate: 90_000,
      budget: 200_000,
      specs: ['docs/epics/02-board.md'],
      file: 'T003-board-columns.md',
      acceptance: { checked: 1, total: 3 },
      issues: [],
    });
    expect(task.body.startsWith('## Goal')).toBe(true);
  });

  it('accepts CRLF line endings and a byte order mark', () => {
    const task = parseTaskFile('T003-x.md', `﻿${TASK.replace(/\n/g, '\r\n')}`);
    expect(task.id).toBe('T003');
    expect(task.depends).toEqual(['T001', 'T002']);
    expect(task.issues).toEqual([]);
  });

  it('takes the id from the file name when the front matter has none', () => {
    const task = parseTaskFile('T007-thing.md', '---\ntitle: Thing\n---\nBody');
    expect(task.id).toBe('T007');
    expect(task.status).toBe('todo');
    expect(task.issues).toEqual([]);
  });

  it('flags an id that disagrees with the file name and keeps the front matter one', () => {
    const task = parseTaskFile('T007-thing.md', '---\nid: T008\ntitle: Thing\n---\n');
    expect(task.id).toBe('T008');
    expect(task.issues.map((issue) => issue.field)).toContain('id');
  });

  it('reads an unknown status as todo with an issue rather than failing', () => {
    const task = parseTaskFile('T001-a.md', '---\nid: T001\ntitle: A\nstatus: finished\n---\n');
    expect(task.status).toBe('todo');
    expect(task.issues).toEqual([
      expect.objectContaining({ field: 'status', message: expect.stringContaining('finished') }),
    ]);
  });

  it('understands common status spellings', () => {
    const read = (status: string) =>
      parseTaskFile('T001-a.md', `---\nid: T001\ntitle: A\nstatus: ${status}\n---\n`).status;
    expect(read('In Progress')).toBe('in-progress');
    expect(read('in_progress')).toBe('in-progress');
    expect(read('DONE')).toBe('done');
    expect(read('to-do')).toBe('todo');
  });

  it('accepts depends as a comma separated string and drops bad ids with an issue', () => {
    const task = parseTaskFile(
      'T004-a.md',
      '---\nid: T004\ntitle: A\ndepends: T001, T002, banana\n---\n',
    );
    expect(task.depends).toEqual(['T001', 'T002']);
    expect(task.issues.map((issue) => issue.field)).toEqual(['depends']);
  });

  it('flags a task that depends on itself', () => {
    const task = parseTaskFile('T004-a.md', '---\nid: T004\ntitle: A\ndepends: [T004]\n---\n');
    expect(task.depends).toEqual([]);
    expect(task.issues.map((issue) => issue.field)).toEqual(['depends']);
  });

  it('survives a file with no front matter at all', () => {
    const task = parseTaskFile('T009-loose.md', '# Loose notes\n\nNo front matter here.');
    expect(task.id).toBe('T009');
    expect(task.title).toBe('Loose notes');
    expect(task.status).toBe('todo');
    expect(task.issues.map((issue) => issue.field)).toContain('frontMatter');
  });

  it('survives broken YAML', () => {
    const task = parseTaskFile('T010-bad.md', '---\nid: T010\ntitle: [unclosed\n---\nBody');
    expect(task.id).toBe('T010');
    expect(task.issues.map((issue) => issue.field)).toContain('frontMatter');
  });

  it('falls back to the file name for the title', () => {
    const task = parseTaskFile('T011-wire-the-ipc.md', '---\nid: T011\n---\n');
    expect(task.title).toBe('wire the ipc');
  });

  it('ignores a token count it cannot read, with an issue', () => {
    const task = parseTaskFile('T012-a.md', '---\nid: T012\ntitle: A\nestimate: lots\n---\n');
    expect(task.estimate).toBeNull();
    expect(task.issues.map((issue) => issue.field)).toEqual(['estimate']);
  });
});

describe('setTaskStatus', () => {
  it('changes only the status line', () => {
    const next = setTaskStatus(TASK, 'done');
    expect(next).toBe(TASK.replace('status: in-progress', 'status: done'));
  });

  it('keeps CRLF line endings', () => {
    const crlf = TASK.replace(/\n/g, '\r\n');
    const next = setTaskStatus(crlf, 'blocked');
    expect(next).toBe(crlf.replace('status: in-progress', 'status: blocked'));
  });

  it('keeps a trailing comment on the status line', () => {
    const text = '---\nid: T001\nstatus: todo # set by Runova\n---\n';
    expect(setTaskStatus(text, 'done')).toBe('---\nid: T001\nstatus: done # set by Runova\n---\n');
  });

  it('adds a status line after the title when there is none', () => {
    const text = '---\nid: T001\ntitle: A\nepic: E01\n---\nBody\n';
    expect(setTaskStatus(text, 'testing')).toBe(
      '---\nid: T001\ntitle: A\nstatus: testing\nepic: E01\n---\nBody\n',
    );
  });

  it('adds front matter to a file that has none', () => {
    expect(setTaskStatus('# Notes\n', 'done')).toBe('---\nstatus: done\n---\n# Notes\n');
  });

  it('does not touch a nested status key', () => {
    const text = '---\nid: T001\nmeta:\n  status: x\nstatus: todo\n---\n';
    expect(setTaskStatus(text, 'done')).toBe(
      '---\nid: T001\nmeta:\n  status: x\nstatus: done\n---\n',
    );
  });
});

describe('renderTaskFile', () => {
  it('writes a file that parses back to the same task', () => {
    const text = renderTaskFile({
      id: 'T005',
      title: 'Context ring: show the budget',
      status: 'todo',
      epic: 'E03',
      order: 5,
      depends: ['T001'],
      estimate: 60_000,
      budget: 200_000,
      specs: ['docs/epics/03-ring.md'],
      goal: 'Show how full the context is.',
      scope: 'The ring only.',
      acceptance: ['Shows used and budget', 'Marks the guard'],
      testPlan: 'Renderer test.',
    });
    const task = parseTaskFile('T005-context-ring.md', text);
    expect(task).toMatchObject({
      id: 'T005',
      title: 'Context ring: show the budget',
      status: 'todo',
      epic: 'E03',
      order: 5,
      depends: ['T001'],
      estimate: 60_000,
      budget: 200_000,
      specs: ['docs/epics/03-ring.md'],
      acceptance: { checked: 0, total: 2 },
      issues: [],
    });
    expect(text).toContain('## Goal\n\nShow how full the context is.');
    expect(text).toContain('- [ ] Marks the guard');
    expect(text).not.toContain('—');
  });

  it('leaves out empty optional fields', () => {
    const text = renderTaskFile({ id: 'T006', title: 'Small', status: 'todo' });
    expect(text).not.toContain('epic:');
    expect(text).not.toContain('depends:');
    expect(parseTaskFile('T006-small.md', text).issues).toEqual([]);
  });
});

const HANDOFF = `---
task: T003
outcome: continue
tests: failed
leg: 2
updated: 2026-10-21T10:00:00Z
---

## Purpose

Make cards draggable between columns.

## Done so far

- Column drop targets.

## Decisions

- Native HTML5 drag, no new dependency.

## Tried and rejected

- ReorderableGroup across columns: it only handles one list.

## Next step

Wire Alt+Arrow.
`;

describe('parseHandoff', () => {
  it('reads the front matter and the five sections', () => {
    const handoff = parseHandoff('T003', HANDOFF);
    expect(handoff).toMatchObject({
      taskId: 'T003',
      outcome: 'continue',
      tests: 'failed',
      leg: 2,
      updated: '2026-10-21T10:00:00Z',
      missingSections: [],
      issues: [],
    });
    expect(handoff.sections.rejected).toBe(
      '- ReorderableGroup across columns: it only handles one list.',
    );
    expect(handoff.sections.next).toBe('Wire Alt+Arrow.');
  });

  it('lists sections that are missing or empty', () => {
    const handoff = parseHandoff(
      'T003',
      '---\noutcome: done\n---\n## Purpose\n\nX\n\n## Next step\n\n',
    );
    expect(handoff.missingSections).toEqual(['done', 'decisions', 'rejected', 'next']);
  });

  it('matches headings loosely', () => {
    const handoff = parseHandoff(
      'T003',
      [
        '---',
        'outcome: done',
        '---',
        '# Purpose of the task',
        'a',
        '### What has been done',
        'b',
        '## Decisions made',
        'c',
        '## Rejected approaches',
        'd',
        '## Next steps',
        'e',
      ].join('\n'),
    );
    expect(handoff.missingSections).toEqual([]);
    expect(handoff.sections).toEqual({
      purpose: 'a',
      done: 'b',
      decisions: 'c',
      rejected: 'd',
      next: 'e',
    });
  });

  it('reads an unknown outcome as null with an issue', () => {
    const handoff = parseHandoff('T003', '---\noutcome: finished\ntests: green\n---\n');
    expect(handoff.outcome).toBeNull();
    expect(handoff.tests).toBeNull();
    expect(handoff.issues.map((issue) => issue.field)).toEqual(['outcome', 'tests']);
  });

  it('flags a handoff written for another task', () => {
    const handoff = parseHandoff('T003', '---\ntask: T004\noutcome: done\n---\n');
    expect(handoff.issues.map((issue) => issue.field)).toEqual(['task']);
  });

  it('reads a date the YAML parser turned into a Date back as text', () => {
    const handoff = parseHandoff('T003', '---\nupdated: 2026-10-21\n---\n');
    expect(handoff.updated).toBe('2026-10-21');
  });
});
