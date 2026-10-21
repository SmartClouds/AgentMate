import { describe, expect, it } from 'vitest';
import {
  formatTokenCount,
  HANDOFF_SECTIONS,
  handoffRelPath,
  isRelayTaskId,
  nextTaskId,
  parseTokenCount,
  relayGuideMarkdown,
  renderHandoff,
  renderHandoffTemplate,
  taskFileName,
  taskIdFromFileName,
  taskRelPath,
} from './format.js';
import { parseHandoff } from './parse.js';

describe('task ids and file names', () => {
  it('accepts T plus at least three digits', () => {
    expect(isRelayTaskId('T001')).toBe(true);
    expect(isRelayTaskId('T1234')).toBe(true);
    expect(isRelayTaskId('T01')).toBe(false);
    expect(isRelayTaskId('t001')).toBe(false);
    expect(isRelayTaskId('E01-T03')).toBe(false);
  });

  it('names a task file after its id and a short ascii slug', () => {
    expect(taskFileName('T001', 'Parse the Relay task format')).toBe(
      'T001-parse-the-relay-task-format.md',
    );
    expect(taskFileName('T002', '  Fix: C# & .NET   build!! ')).toBe('T002-fix-c-net-build.md');
    expect(taskFileName('T003', 'ساخت صفحه')).toBe('T003.md');
    const long = taskFileName('T004', 'word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual('T004-'.length + 48 + '.md'.length);
    expect(long.endsWith('-.md')).toBe(false);
  });

  it('reads the id back from a file name', () => {
    expect(taskIdFromFileName('T001-parse-format.md')).toBe('T001');
    expect(taskIdFromFileName('T012.md')).toBe('T012');
    expect(taskIdFromFileName('RELAY.md')).toBeNull();
    expect(taskIdFromFileName('T001-notes.txt')).toBeNull();
    expect(taskIdFromFileName('notes-T001.md')).toBeNull();
  });

  it('continues the numbering after the highest id, padded to three digits', () => {
    expect(nextTaskId([])).toBe('T001');
    expect(nextTaskId(['T001', 'T009', 'T003'])).toBe('T010');
    expect(nextTaskId(['T999'])).toBe('T1000');
    expect(nextTaskId(['bogus', 'T002'])).toBe('T003');
  });

  it('builds posix paths relative to the project', () => {
    expect(taskRelPath('docs', 'T001-a.md')).toBe('docs/tasks/T001-a.md');
    expect(handoffRelPath('docs', 'T001')).toBe('docs/tasks/handoffs/T001.md');
    expect(handoffRelPath('planning/specs', 'T020')).toBe('planning/specs/tasks/handoffs/T020.md');
  });
});

describe('token counts', () => {
  it('parses numbers and k or M suffixes', () => {
    expect(parseTokenCount(120000)).toBe(120000);
    expect(parseTokenCount('120000')).toBe(120000);
    expect(parseTokenCount('120k')).toBe(120000);
    expect(parseTokenCount('1.5K')).toBe(1500);
    expect(parseTokenCount('1M')).toBe(1_000_000);
    expect(parseTokenCount('120,000')).toBe(120000);
    expect(parseTokenCount('a lot')).toBeNull();
    expect(parseTokenCount(-5)).toBeNull();
    expect(parseTokenCount(null)).toBeNull();
  });

  it('formats a count the short way', () => {
    expect(formatTokenCount(200_000)).toBe('200K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(84_500)).toBe('84.5K');
    expect(formatTokenCount(950)).toBe('950');
  });
});

describe('handoff template', () => {
  it('has the five sections in order with the task in the front matter', () => {
    const text = renderHandoffTemplate({ id: 'T004', title: 'Board columns' });
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('task: T004');
    expect(text).toContain('outcome: continue');
    expect(text).toContain('tests: not-run');
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(HANDOFF_SECTIONS.map((section) => section.heading));
  });
});

describe('a written handoff', () => {
  it('fills the sections it is given and leaves the hint in the rest', () => {
    const text = renderHandoff({
      id: 'T004',
      outcome: 'continue',
      sections: {
        purpose: 'Board columns.',
        done: 'The To do column renders, in src/board/Columns.tsx.',
        next: 'Add the Done column.',
      },
    });
    const handoff = parseHandoff('T004', text);
    expect(handoff).toMatchObject({ outcome: 'continue', tests: 'not-run', leg: 0 });
    expect(handoff.sections.done).toBe('The To do column renders, in src/board/Columns.tsx.');
    expect(handoff.sections.next).toBe('Add the Done column.');
    expect(handoff.missingSections).toEqual(['decisions', 'rejected']);
  });

  it('records finished work as done', () => {
    const text = renderHandoff({ id: 'T001', outcome: 'done', sections: { purpose: 'Login.' } });
    expect(parseHandoff('T001', text).outcome).toBe('done');
  });
});

describe('the RELAY.md guide', () => {
  const guide = relayGuideMarkdown('docs');

  it('names the folders, the statuses and the handoff rules', () => {
    expect(guide).toContain('docs/tasks/');
    expect(guide).toContain('docs/tasks/handoffs/');
    for (const status of ['todo', 'in-progress', 'testing', 'done', 'blocked']) {
      expect(guide).toContain(status);
    }
    for (const section of HANDOFF_SECTIONS) expect(guide).toContain(section.heading);
    expect(guide).toContain('outcome: continue');
  });

  it('never uses an em dash', () => {
    expect(guide).not.toContain('—');
  });
});
