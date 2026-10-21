import { describe, expect, it } from 'vitest';
import { parseTaskFile, renderTaskFile } from './parse.js';
import { applyProposal, diffProposal, parsePlanProposal } from './proposal.js';
import type { RelayTask } from './types.js';

function existing(
  id: string,
  title: string,
  options: Partial<Pick<RelayTask, 'status' | 'depends' | 'estimate' | 'epic'>> = {},
) {
  const content = renderTaskFile({
    id,
    title,
    status: options.status ?? 'todo',
    depends: options.depends,
    estimate: options.estimate ?? null,
    epic: options.epic ?? null,
    goal: `Goal of ${title}.`,
    acceptance: [`${title} works`],
  });
  const file = `${id}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;
  return { file, content, task: parseTaskFile(file, content) };
}

describe('parsePlanProposal', () => {
  it('reads JSON wrapped in a fence and prose', () => {
    const text = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        summary: 'Two tasks.',
        add: [
          { id: 'T005', title: 'Schema', estimate: '80k', acceptance: ['Migrates'] },
          { id: 'T006', title: 'Endpoint', depends: ['T005'], estimate: 60000 },
        ],
      }),
      '```',
    ].join('\n');
    const result = parsePlanProposal(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.summary).toBe('Two tasks.');
    expect(result.proposal.add.map((task) => [task.id, task.estimate])).toEqual([
      ['T005', 80_000],
      ['T006', 60_000],
    ]);
    expect(result.proposal.change).toEqual([]);
  });

  it('explains what is wrong with an answer that is not a proposal', () => {
    expect(parsePlanProposal('I could not do it.')).toEqual({
      ok: false,
      error: expect.stringContaining('JSON'),
    });
    expect(parsePlanProposal('{"add": [{"title": 5}]}')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });
});

describe('applyProposal', () => {
  const board = [
    existing('T001', 'Login', { status: 'done' }),
    existing('T002', 'Search', { depends: ['T001'], estimate: 250_000 }),
    existing('T003', 'Export', { depends: ['T002'] }),
  ];

  it('writes added tasks under fresh ids and keeps their dependencies pointing right', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [
        { id: 'T002', title: 'Clashing id', depends: ['T001'] },
        { id: 'T009', title: 'After it', depends: ['T002'] },
      ],
      change: [],
      split: [],
      remove: [],
    });
    const written = plan.write.map((file) => parseTaskFile(file.file, file.content));
    expect(written.map((task) => [task.id, task.title, task.depends])).toEqual([
      ['T004', 'Clashing id', ['T001']],
      ['T005', 'After it', ['T004']],
    ]);
    expect(plan.remove).toEqual([]);
  });

  it('changes a task but never a done one', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [
        { id: 'T003', title: 'Export to CSV', acceptance: ['Writes a CSV', 'Escapes commas'] },
        { id: 'T001', title: 'Login again' },
      ],
      split: [],
      remove: [],
    });
    expect(plan.write).toHaveLength(1);
    const task = parseTaskFile(plan.write[0].file, plan.write[0].content);
    expect(task).toMatchObject({
      id: 'T003',
      title: 'Export to CSV',
      depends: ['T002'],
      acceptance: { total: 2 },
    });
    expect(plan.write[0].content).toContain('Goal of Export.');
    expect(plan.warnings).toEqual([expect.stringContaining('T001')]);
  });

  it('splits an oversized task and moves its dependents onto the new parts', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [],
      split: [
        {
          id: 'T002',
          into: [
            { id: 'T010', title: 'Search API', estimate: 90_000 },
            { id: 'T011', title: 'Search UI', depends: ['T010'], estimate: 90_000 },
          ],
        },
      ],
      remove: [],
    });
    expect(plan.remove).toEqual(['T002-search.md']);
    const written = new Map(
      plan.write.map((file) => {
        const task = parseTaskFile(file.file, file.content);
        return [task.id, task];
      }),
    );
    expect(written.get('T004')).toMatchObject({ title: 'Search API', depends: ['T001'] });
    expect(written.get('T005')).toMatchObject({ title: 'Search UI', depends: ['T004'] });
    expect(written.get('T003')?.depends).toEqual(['T004', 'T005']);
  });

  it('removes a task and drops it from what depended on it', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [],
      split: [],
      remove: [{ id: 'T002', reason: 'Not needed.' }],
    });
    expect(plan.remove).toEqual(['T002-search.md']);
    expect(parseTaskFile(plan.write[0].file, plan.write[0].content).depends).toEqual([]);
  });
});

describe('diffProposal', () => {
  it('lists what the proposal would do, field by field', () => {
    const board = [existing('T002', 'Search', { estimate: 250_000 })];
    const entries = diffProposal(board, {
      summary: '',
      add: [{ id: 'T003', title: 'New' }],
      change: [{ id: 'T002', title: 'Search patients', estimate: 120_000 }],
      split: [],
      remove: [],
    });
    expect(entries).toEqual([
      { kind: 'add', id: 'T003', title: 'New', fields: [] },
      {
        kind: 'change',
        id: 'T002',
        title: 'Search patients',
        fields: [
          { field: 'title', before: 'Search', after: 'Search patients' },
          { field: 'estimate', before: '250K', after: '120K' },
        ],
      },
    ]);
  });
});
