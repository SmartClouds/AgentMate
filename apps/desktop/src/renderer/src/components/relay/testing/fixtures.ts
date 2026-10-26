import { DEFAULT_RELAY_OPTIONS } from '@runova/core';
import type { RelayBoard, RelayLegView, RelayRunView, RelayTaskCard } from '@shared/relayTypes';

/** Shapes for Relay renderer tests: a task card, a board and a live relay. */
export function card(id: string, overrides: Partial<RelayTaskCard> = {}): RelayTaskCard {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    epic: null,
    order: null,
    depends: [],
    estimate: null,
    budget: null,
    specs: [],
    file: `${id}-task.md`,
    acceptance: { checked: 0, total: 0 },
    issues: [],
    handoff: null,
    legCount: 0,
    legPeaks: [],
    ...overrides,
  };
}

export function board(overrides: Partial<RelayBoard> = {}): RelayBoard {
  const tasks = overrides.tasks ?? [card('T001'), card('T002')];
  return {
    projectId: 'p1',
    docsFolder: 'docs',
    exists: true,
    guidePresent: true,
    tasks,
    order: tasks.map((task) => task.id),
    cycles: [],
    missing: [],
    issues: [],
    settings: {
      docsFolder: 'docs',
      defaults: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
      overrides: {},
      options: { ...DEFAULT_RELAY_OPTIONS },
    },
    active: null,
    ...overrides,
  };
}

export function run(overrides: Partial<RelayRunView> = {}): RelayRunView {
  return {
    id: 'r1',
    projectId: 'p1',
    status: 'running',
    trigger: { kind: 'now' },
    triggerText: 'Starts now',
    queue: [],
    finished: [],
    current: null,
    pauseReason: null,
    options: { ...DEFAULT_RELAY_OPTIONS },
    createdAt: 0,
    ...overrides,
  };
}

export function leg(overrides: Partial<RelayLegView> = {}): RelayLegView {
  return {
    legId: 'r1-T001-1-1',
    taskId: 'T001',
    legNo: 1,
    phase: 'executing',
    tabId: 'tab-1',
    choice: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
    planFirst: false,
    startedAt: 0,
    contextTokens: null,
    peakContextTokens: null,
    budget: 200_000,
    guardAt: 160_000,
    awaiting: null,
    ...overrides,
  };
}
