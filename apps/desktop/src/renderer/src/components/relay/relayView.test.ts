import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMNS,
  boardColumns,
  choiceFor,
  choiceLabel,
  epicHue,
  formatDuration,
  legPhaseLabel,
  neighbourStatus,
  relaySummary,
  runArgsFor,
  trackStations,
  withColumnOrder,
} from './relayView';
import { board, card, run } from './testing/fixtures';

describe('boardColumns', () => {
  it('puts every task in its status column, in run order', () => {
    const columns = boardColumns(
      [
        card('T003', { status: 'done' }),
        card('T001'),
        card('T002', { status: 'blocked' }),
        card('T004'),
      ],
      ['T004', 'T001', 'T003', 'T002'],
    );
    expect(columns.map((column) => column.status)).toEqual(
      BOARD_COLUMNS.map((column) => column.status),
    );
    expect(columns[0].tasks.map((task) => task.id)).toEqual(['T004', 'T001']);
    expect(columns[3].tasks.map((task) => task.id)).toEqual(['T003']);
    expect(columns[4].tasks.map((task) => task.id)).toEqual(['T002']);
  });

  it('keeps tasks left out of the order (a cycle) at the end of their column', () => {
    const columns = boardColumns([card('T009'), card('T001')], ['T001']);
    expect(columns[0].tasks.map((task) => task.id)).toEqual(['T001', 'T009']);
  });
});

describe('neighbourStatus', () => {
  it('steps one column left or right and stops at the ends', () => {
    expect(neighbourStatus('todo', 1)).toBe('in-progress');
    expect(neighbourStatus('done', 1)).toBe('blocked');
    expect(neighbourStatus('todo', -1)).toBeNull();
    expect(neighbourStatus('blocked', 1)).toBeNull();
  });
});

describe('epicHue', () => {
  it('gives an epic the same hue every time and none to no epic', () => {
    expect(epicHue('E01')).toBe(epicHue('E01'));
    expect(epicHue('E01')).not.toBe(epicHue('E02'));
    expect(epicHue(null)).toBeNull();
  });
});

describe('choices', () => {
  const settings = board().settings;

  it('lets a task override the defaults', () => {
    expect(choiceFor(settings, 'T001')).toEqual(settings.defaults);
    expect(
      choiceFor({ ...settings, overrides: { T001: { model: 'sonnet', planFirst: true } } }, 'T001'),
    ).toEqual({ ...settings.defaults, model: 'sonnet' });
  });

  it('reads a choice as words', () => {
    expect(choiceLabel(settings.defaults)).toMatch(/Opus/);
    expect(choiceLabel({ ...settings.defaults, autoSize: true })).toBe('Auto');
    expect(choiceLabel({ cliId: 'codex-cli', model: null, effort: null, autoSize: false })).toBe(
      'Codex CLI',
    );
  });

  it('turns a choice into flags, with the plan flag when planning first', () => {
    expect(runArgsFor(settings.defaults, false)).toEqual(['--model', 'opus', '--effort', 'high']);
    expect(runArgsFor(settings.defaults, true)).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'plan',
    ]);
    expect(runArgsFor({ ...settings.defaults, cliId: 'codex-cli', model: null }, true)).toEqual([]);
  });
});

describe('trackStations', () => {
  it('marks what is done, running, queued and waiting', () => {
    const tasks = [
      card('T001', { status: 'done' }),
      card('T002', { status: 'in-progress', legCount: 2 }),
      card('T003'),
      card('T004', { status: 'blocked' }),
      card('T005'),
    ];
    const live = run({
      queue: ['T003'],
      current: {
        legId: 'l',
        taskId: 'T002',
        legNo: 2,
        phase: 'executing',
        tabId: 'tab',
        choice: board().settings.defaults,
        planFirst: false,
        startedAt: 0,
        contextTokens: 50_000,
        peakContextTokens: 60_000,
        budget: 200_000,
        guardAt: 160_000,
        awaiting: null,
      },
    });
    const stations = trackStations(board({ tasks, active: live }));
    expect(stations.map((station) => [station.task.id, station.state])).toEqual([
      ['T001', 'done'],
      ['T002', 'running'],
      ['T003', 'queued'],
      ['T004', 'blocked'],
      ['T005', 'idle'],
    ]);
    expect(stations[1].legs).toBe(2);
  });

  it('shows a waiting leg as waiting on the user', () => {
    const live = run({
      current: {
        legId: 'l',
        taskId: 'T001',
        legNo: 1,
        phase: 'awaiting-user',
        tabId: 'tab',
        choice: board().settings.defaults,
        planFirst: false,
        startedAt: 0,
        contextTokens: null,
        peakContextTokens: null,
        budget: 200_000,
        guardAt: null,
        awaiting: { reason: 'plan-review', message: 'The plan is ready for review.' },
      },
    });
    expect(trackStations(board({ active: live }))[0].state).toBe('waiting');
  });
});

describe('relaySummary', () => {
  it('counts done tasks and adds up the estimates left', () => {
    const summary = relaySummary(
      board({
        tasks: [
          card('T001', { status: 'done', estimate: 50_000 }),
          card('T002', { estimate: 80_000 }),
          card('T003', { estimate: 40_000 }),
          card('T004'),
        ],
      }),
    );
    expect(summary).toEqual({ done: 1, total: 4, estimateLeft: 120_000, unestimated: 1 });
  });
});

describe('words', () => {
  it('names leg phases for people', () => {
    expect(legPhaseLabel('planning', null)).toBe('Planning');
    expect(legPhaseLabel('awaiting-user', { reason: 'plan-review', message: 'x' })).toBe(
      'Plan ready for review',
    );
    expect(legPhaseLabel('awaiting-user', { reason: 'not-started', message: 'x' })).toBe(
      'Not started yet',
    );
  });

  it('formats durations short', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
});

describe('withColumnOrder', () => {
  it('puts a column back in its new sequence and leaves the rest where it was', () => {
    expect(withColumnOrder(['T001', 'T002', 'T003', 'T004'], ['T003', 'T001'])).toEqual([
      'T003',
      'T002',
      'T001',
      'T004',
    ]);
  });

  it('adds an id the order did not have where its column sits', () => {
    expect(withColumnOrder(['T001', 'T002'], ['T009', 'T002'])).toEqual(['T001', 'T009', 'T002']);
  });
});
