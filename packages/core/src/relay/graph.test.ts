import { describe, expect, it } from 'vitest';
import { budgetLevel, orderTasks, relayQueue, unmetDependencies } from './graph.js';
import type { RelayTask, RelayTaskStatus } from './types.js';

function task(
  id: string,
  options: { depends?: string[]; order?: number; status?: RelayTaskStatus } = {},
): Pick<RelayTask, 'id' | 'order' | 'depends' | 'status'> {
  return {
    id,
    order: options.order ?? null,
    depends: options.depends ?? [],
    status: options.status ?? 'todo',
  };
}

describe('orderTasks', () => {
  it('puts dependencies first and breaks ties by order, then id', () => {
    const result = orderTasks([
      task('T004', { depends: ['T002'] }),
      task('T003', { order: 1 }),
      task('T002', { order: 2 }),
      task('T001', { order: 2 }),
    ]);
    expect(result.ordered).toEqual(['T003', 'T001', 'T002', 'T004']);
    expect(result.cycles).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('lets a later order wait for nothing it does not depend on', () => {
    const result = orderTasks([task('T002', { order: 9 }), task('T001', { order: 1 })]);
    expect(result.ordered).toEqual(['T001', 'T002']);
  });

  it('reports a dependency on a task that does not exist and orders as if it were done', () => {
    const result = orderTasks([task('T002', { depends: ['T009'] }), task('T001')]);
    expect(result.ordered).toEqual(['T001', 'T002']);
    expect(result.missing).toEqual([{ taskId: 'T002', dependsOn: 'T009' }]);
  });

  it('leaves the tasks in a cycle, and those waiting on them, out of the order', () => {
    const result = orderTasks([
      task('T001'),
      task('T002', { depends: ['T003'] }),
      task('T003', { depends: ['T002'] }),
      task('T004', { depends: ['T003'] }),
    ]);
    expect(result.ordered).toEqual(['T001']);
    expect(result.cycles).toEqual([['T002', 'T003']]);
    expect(result.stuck).toEqual(['T004']);
  });
});

describe('relayQueue', () => {
  const tasks = [
    task('T001', { status: 'done' }),
    task('T002', { depends: ['T001'] }),
    task('T003', { depends: ['T002'], status: 'blocked' }),
    task('T004', { depends: ['T002'] }),
    task('T005', { status: 'testing' }),
  ];

  it('queues every task that is not done or blocked, in dependency order', () => {
    expect(relayQueue(tasks)).toEqual(['T002', 'T004', 'T005']);
  });

  it('starts from a chosen task', () => {
    expect(relayQueue(tasks, { from: 'T004' })).toEqual(['T004', 'T005']);
  });

  it('runs only the chosen tasks, still in dependency order', () => {
    expect(relayQueue(tasks, { only: ['T005', 'T002'] })).toEqual(['T002', 'T005']);
  });

  it('includes a blocked task when it is asked for by name', () => {
    expect(relayQueue(tasks, { only: ['T003'] })).toEqual(['T003']);
  });
});

describe('unmetDependencies', () => {
  it('lists the dependencies that are not done, ignoring unknown ids', () => {
    const status = new Map<string, RelayTaskStatus>([
      ['T001', 'done'],
      ['T002', 'testing'],
    ]);
    expect(unmetDependencies({ depends: ['T001', 'T002', 'T404'] }, status)).toEqual(['T002']);
  });
});

describe('budgetLevel', () => {
  it('reads an estimate against the budget', () => {
    expect(budgetLevel(null, 200_000)).toBeNull();
    expect(budgetLevel(100_000, 200_000)).toBe('ok');
    expect(budgetLevel(120_000, 200_000)).toBe('ok');
    expect(budgetLevel(130_000, 200_000)).toBe('tight');
    expect(budgetLevel(200_001, 200_000)).toBe('over');
  });
});
