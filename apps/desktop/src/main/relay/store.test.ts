import { readFileSync } from 'node:fs';
import { createRelay, DEFAULT_RELAY_OPTIONS, type RelayLegRecord } from '@agentmat/core';
import { describe, expect, it } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/** relay.json: the project's relay settings, its relays and the history of its legs. */

const userData = useTempUserData();

function project(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    folderPath: `C:/work/${id}`,
    description: '',
    tags: [],
    agentType: 'claude-code',
    cliId: 'claude-code',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function relayState(id: string, projectId: string) {
  return createRelay({
    id,
    projectId,
    docsFolder: 'docs',
    now: 1,
    tasks: [{ id: 'T001', status: 'todo', depends: [], budget: null }],
    queue: ['T001'],
    trigger: { kind: 'now' },
    defaults: { cliId: 'claude-code', model: null, effort: null, autoSize: false },
    overrides: {},
    options: DEFAULT_RELAY_OPTIONS,
  });
}

function record(legNo: number, projectRelay = 'r1'): RelayLegRecord {
  return {
    legId: `${projectRelay}-T001-${legNo}-1`,
    relayId: projectRelay,
    taskId: 'T001',
    legNo,
    cliId: 'claude-code',
    model: null,
    effort: null,
    tabId: 'tab',
    startedAt: legNo,
    endedAt: legNo + 1,
    outcome: 'continue',
    tests: 'not-run',
    result: 'continue',
    peakContextTokens: null,
  };
}

describe('relay settings', () => {
  it('defaults to the Blueprint docs folder and the project CLI', async () => {
    userData.writeData('projects.json', [project('p1', { cliId: 'codex-cli' })]);
    userData.writeData('blueprints.json', [
      { id: 'b1', projectId: 'p1', docsFolder: 'planning/specs', sections: {} },
    ]);
    const store = await import('./store');
    const settings = await store.relaySettings('p1');
    expect(settings).toMatchObject({
      docsFolder: 'planning/specs',
      defaults: { cliId: 'codex-cli', model: null, effort: null, autoSize: false },
      overrides: {},
      options: DEFAULT_RELAY_OPTIONS,
    });
  });

  it('falls back to docs and the app default CLI', async () => {
    userData.writeData('projects.json', [project('p1', { cliId: null })]);
    userData.writeData('settings.json', { defaultCliId: 'gemini-cli' });
    const store = await import('./store');
    const settings = await store.relaySettings('p1');
    expect(settings.docsFolder).toBe('docs');
    expect(settings.defaults.cliId).toBe('gemini-cli');
  });

  it('saves a patch, keeps the rest, and cleans the docs folder', async () => {
    userData.writeData('projects.json', [project('p1')]);
    const store = await import('./store');
    const saved = await store.saveRelaySettings('p1', {
      docsFolder: '../outside',
      options: { planFirst: true },
      overrides: { T002: { model: 'opus' } },
    });
    expect(saved.docsFolder).toBe('docs');
    expect(saved.options).toEqual({ ...DEFAULT_RELAY_OPTIONS, planFirst: true });
    expect(saved.overrides).toEqual({ T002: { model: 'opus' } });
    const again = await store.relaySettings('p1');
    expect(again).toEqual(saved);
    const onDisk = JSON.parse(readFileSync(userData.dataFile('relay.json'), 'utf-8'));
    expect(onDisk.projects.p1.settings.options.planFirst).toBe(true);
  });

  it('refuses a project it does not know', async () => {
    const store = await import('./store');
    await expect(store.relaySettings('nope')).rejects.toThrow(/project/i);
  });
});

describe('relays and legs', () => {
  it('round-trips relay states, newest first', async () => {
    userData.writeData('projects.json', [project('p1')]);
    const store = await import('./store');
    await store.saveRelayState(relayState('r1', 'p1'));
    const second = { ...relayState('r2', 'p1'), createdAt: 5 };
    await store.saveRelayState(second);
    await store.saveRelayState({ ...second, status: 'running' });
    const relays = await store.relayStates('p1');
    expect(relays.map((relay) => [relay.id, relay.status])).toEqual([
      ['r2', 'running'],
      ['r1', 'waiting'],
    ]);
    expect((await store.allRelayStates()).length).toBe(2);
  });

  it('keeps at most the newest leg records per project', async () => {
    userData.writeData('projects.json', [project('p1')]);
    const store = await import('./store');
    for (let leg = 1; leg <= store.RELAY_MAX_LEG_RECORDS + 3; leg += 1) {
      await store.addLegRecord('p1', record(leg));
    }
    const legs = await store.legRecords('p1');
    expect(legs).toHaveLength(store.RELAY_MAX_LEG_RECORDS);
    expect(legs[0].legNo).toBe(4);
    expect(await store.legRecords('p1', 'T999')).toEqual([]);
  });

  it('prunes the relays of deleted projects', async () => {
    userData.writeData('projects.json', [project('p1'), project('p2')]);
    const store = await import('./store');
    await store.saveRelayState(relayState('r1', 'p1'));
    await store.saveRelayState(relayState('r2', 'p2'));
    await store.addLegRecord('p2', record(1, 'r2'));

    await store.pruneOrphanRelays({ projectIds: ['p2'] });
    expect(await store.allRelayStates()).toHaveLength(1);
    expect(await store.legRecords('p2')).toEqual([]);

    userData.writeData('projects.json', []);
    await store.pruneOrphanRelays();
    expect(await store.allRelayStates()).toEqual([]);
  });

  it('reads a broken file as empty rather than failing', async () => {
    userData.writeData('projects.json', [project('p1')]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile('relay.json'), '{not json');
    const store = await import('./store');
    expect(await store.allRelayStates()).toEqual([]);
  });
});
