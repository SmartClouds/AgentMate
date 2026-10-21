import { describe, expect, it } from 'vitest';
import {
  blueprintRelaySection,
  buildCatchUpRequest,
  buildDecomposeRequest,
  buildLegPrompt,
  buildReviseRequest,
  RELAY_PROPOSAL_SHAPE,
} from './prompts.js';

const TASK = { id: 'T003', title: 'Board columns', file: 'T003-board-columns.md' };

describe('buildLegPrompt', () => {
  const base = {
    task: TASK,
    docsFolder: 'docs',
    legNo: 1,
    continuation: false,
    budget: 200_000,
    dependsOn: ['T001'],
    commitPerTask: true,
    mcp: false,
    planFirst: false,
  };

  it('points at the guide, the task, its handoff and its direct dependencies', () => {
    const prompt = buildLegPrompt(base);
    expect(prompt).toContain('docs/tasks/RELAY.md');
    expect(prompt).toContain('docs/tasks/T003-board-columns.md');
    expect(prompt).toContain('docs/tasks/handoffs/T003.md');
    expect(prompt).toContain('docs/tasks/handoffs/T001.md');
    expect(prompt).toContain('leg: 1');
    expect(prompt).toContain('200K');
  });

  it('asks for test-first work and a commit of only this task', () => {
    const prompt = buildLegPrompt(base);
    expect(prompt).toMatch(/test/i);
    expect(prompt).toContain('T003:');
    expect(prompt).toContain('git add -A');
  });

  it('leaves the commit out when the relay does not commit', () => {
    expect(buildLegPrompt({ ...base, commitPerTask: false })).not.toMatch(/commit/i);
  });

  it('lets a first session build on a handoff that already records work', () => {
    // Catching up a project in progress writes a handoff for half-done work before any session.
    expect(buildLegPrompt(base)).toMatch(/already records work.*Next step/);
  });

  it('tells a continuation to carry on from the next step', () => {
    const prompt = buildLegPrompt({ ...base, legNo: 3, continuation: true });
    expect(prompt).toMatch(/session 3/i);
    expect(prompt).toContain('Next step');
    expect(prompt).toContain('leg: 3');
  });

  it('asks a plan-first session to put open questions in the plan', () => {
    const prompt = buildLegPrompt({ ...base, planFirst: true });
    expect(prompt).toContain('Open questions');
    // An empty "Open questions: None." section is what real plans wrote without this.
    expect(prompt).toContain('Leave that heading out when nothing does.');
  });

  it('names the MCP finish call only when the bridge is there', () => {
    expect(buildLegPrompt({ ...base, mcp: true })).toContain('finish_leg');
    expect(buildLegPrompt(base)).not.toContain('finish_leg');
  });

  it('holds no double quote, which Windows PowerShell 5.1 splits native arguments on', () => {
    const prompt = buildLegPrompt({
      ...base,
      task: { ...TASK, title: 'Say "hello"\nworld' },
      mcp: true,
      planFirst: true,
    });
    expect(prompt).not.toContain('"');
    expect(prompt).toContain("Say 'hello' world");
  });

  it('stays short enough to pass on a command line', () => {
    const prompt = buildLegPrompt({
      ...base,
      mcp: true,
      planFirst: true,
      dependsOn: ['T001', 'T002'],
    });
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).not.toContain('—');
  });
});

describe('buildDecomposeRequest', () => {
  it('carries the request, the budget, the first id and the JSON shape', () => {
    const request = buildDecomposeRequest({
      projectName: 'CuraLink',
      request: 'Add a patient search page with filters',
      docsFolder: 'docs',
      budget: 200_000,
      firstId: 'T014',
      existing: [{ id: 'T001', title: 'Login', status: 'done' }],
    });
    expect(request).toContain('Add a patient search page with filters');
    expect(request).toContain('200K');
    expect(request).toContain('T014');
    expect(request).toContain('T001 Login (done)');
    expect(request).toContain(RELAY_PROPOSAL_SHAPE);
    expect(request).toMatch(/only the JSON/i);
    expect(request).not.toContain('—');
  });
});

describe('buildReviseRequest', () => {
  it('lists the board, protects done tasks and passes the note', () => {
    const request = buildReviseRequest({
      projectName: 'CuraLink',
      docsFolder: 'docs',
      budget: 200_000,
      firstId: 'T010',
      tasks: [
        { id: 'T001', title: 'Login', status: 'done', depends: [], estimate: 40_000 },
        { id: 'T002', title: 'Search', status: 'todo', depends: ['T001'], estimate: 250_000 },
      ],
      note: 'The search must also cover archived patients.',
    });
    expect(request).toContain('T002 Search [todo] depends T001, estimate 250K');
    expect(request).toMatch(/never change, split or remove a task that is done/i);
    expect(request).toContain('The search must also cover archived patients.');
    expect(request).toContain('T010');
    expect(request).toContain('docs/');
    expect(request).not.toContain('—');
  });
});

describe('buildCatchUpRequest', () => {
  const base = {
    projectName: 'CuraLink',
    docsFolder: 'docs',
    budget: 200_000,
    firstId: 'T001',
    tasks: [],
    recordDone: true,
  };

  it('asks for what is finished, half done and left, read from the code and the docs', () => {
    const request = buildCatchUpRequest(base);
    expect(request).toMatch(/do not change any file/i);
    expect(request).toMatch(/git log/);
    expect(request).toContain('"status": "done"');
    expect(request).toContain('"handoff"');
    expect(request).toMatch(/half done/i);
    expect(request).toContain('200K');
    expect(request).toContain('T001');
    expect(request).toMatch(/only the JSON/i);
    expect(request).not.toContain('—');
  });

  it('keeps finished work off the board when the user does not want it', () => {
    const request = buildCatchUpRequest({ ...base, recordDone: false });
    expect(request).toMatch(/do not add tasks for finished work/i);
  });

  it('lists the board so its tasks can be marked done, and passes the note', () => {
    const request = buildCatchUpRequest({
      ...base,
      firstId: 'T003',
      tasks: [
        { id: 'T001', title: 'Login', status: 'done', depends: [], estimate: null },
        { id: 'T002', title: 'Search', status: 'todo', depends: ['T001'], estimate: 90_000 },
      ],
      note: 'The plan is in docs/ROADMAP.md.',
    });
    expect(request).toContain('T002 Search [todo] depends T001, estimate 90K');
    expect(request).toMatch(/never change, split or remove a task that is done/i);
    expect(request).toContain('The plan is in docs/ROADMAP.md.');
    expect(request).toContain('T003');
  });
});

describe('blueprintRelaySection', () => {
  it('asks for task files in the Relay format within the budget', () => {
    const section = blueprintRelaySection('docs', 200_000);
    expect(section).toContain('docs/tasks/');
    expect(section).toContain('docs/tasks/RELAY.md');
    expect(section).toContain('200K');
    expect(section).toContain('T001');
    expect(section).toContain('status: todo');
    expect(section).not.toContain('—');
  });
});
