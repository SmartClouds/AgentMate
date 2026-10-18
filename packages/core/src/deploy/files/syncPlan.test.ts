import { describe, expect, it } from 'vitest';
import { planFileSync } from './syncPlan.js';
import type {
  BaseMap,
  LocalFileMap,
  PartialRemote,
  PlannedChange,
  RemoteObservation,
  RemoteTimeSource,
  SyncPlanInput,
} from './types.js';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 1, 12, 0, 0);

const sha = (tag: string) => tag.repeat(64).slice(0, 64);

function local(entries: Record<string, [tag: string, size: number]>): LocalFileMap {
  const map: LocalFileMap = {};
  for (const [path, [tag, size]] of Object.entries(entries)) {
    map[path] = { sha256: sha(tag), size, mtimeMs: T };
  }
  return map;
}

function obs(
  size: number,
  mtimeMs: number | null = T,
  via: RemoteTimeSource | null = 'sftp',
): RemoteObservation {
  return { size, mtimeMs, via };
}

function base(
  entries: Record<string, [tag: string, size: number, remote?: RemoteObservation | null]>,
): BaseMap {
  const map: BaseMap = {};
  for (const [path, [tag, size, remote]] of Object.entries(entries)) {
    map[path] = {
      sha256: sha(tag),
      size,
      localMtimeMs: T - 1000,
      remote: remote === undefined ? obs(size) : remote,
    };
  }
  return map;
}

function remote(dirs: string[], entries: Record<string, RemoteObservation>): PartialRemote {
  return { listedDirs: new Set(dirs), entries };
}

function plan(input: Partial<SyncPlanInput>) {
  return planFileSync({ local: {}, base: {}, remote: null, ...input });
}

/** The fields that carry the decision, for a compact table. */
function brief(change: PlannedChange) {
  return {
    path: change.path,
    local: change.local,
    remote: change.remote,
    action: change.action,
    conflict: change.conflict,
    unverified: change.unverified,
  };
}

describe('planFileSync decision table', () => {
  // One row per case of the plan's table: the local side, the server side, and the decision.
  type Row = {
    name: string;
    local: LocalFileMap;
    base: BaseMap;
    remote: PartialRemote;
    adopt?: 'bySize' | null;
    expect: Partial<PlannedChange> | null;
    list?: 'dropFromBase' | 'serverOnlyDrift' | 'missingOnServer';
  };
  const rows: Row[] = [
    {
      name: 'added, folder listed, not on the server: upload',
      local: local({ 'a.html': ['1', 5] }),
      base: {},
      remote: remote([''], {}),
      expect: { local: 'added', remote: 'missing', action: 'upload', unverified: false, size: 5 },
    },
    {
      name: 'added, folder not listed: upload, unverified',
      local: local({ 'new/a.html': ['1', 5] }),
      base: {},
      remote: remote([''], {}),
      expect: { local: 'added', remote: 'unknown', action: 'upload', unverified: true, size: 5 },
    },
    {
      name: 'added, already on the server: conflict existsOnServer',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'b.html': ['2', 3] }),
      remote: remote([''], { 'a.html': obs(5), 'b.html': obs(3) }),
      expect: {
        local: 'added',
        remote: 'untracked',
        action: 'conflict',
        conflict: 'existsOnServer',
        unverified: false,
        size: 5,
        server: obs(5),
        base: null,
      },
    },
    {
      name: 'added, already on the server, adopt by size, same size: adopt',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'b.html': ['2', 3] }),
      remote: remote([''], { 'a.html': obs(5), 'b.html': obs(3) }),
      adopt: 'bySize',
      expect: { action: 'adopt', conflict: null, size: 0, unverified: true, remote: 'untracked' },
    },
    {
      name: 'added, already on the server, adopt by size, other size: conflict',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'b.html': ['2', 3] }),
      remote: remote([''], { 'a.html': obs(6), 'b.html': obs(3) }),
      adopt: 'bySize',
      expect: { action: 'conflict', conflict: 'existsOnServer', size: 5 },
    },
    {
      name: 'modified, server unchanged: upload',
      local: local({ 'a.html': ['9', 7] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(5) }),
      expect: {
        local: 'modified',
        remote: 'unchanged',
        action: 'upload',
        unverified: false,
        size: 7,
        server: obs(5),
        base: obs(5),
      },
    },
    {
      name: 'modified, server changed: conflict changedOnServer',
      local: local({ 'a.html': ['9', 7] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(5, T + 60_000) }),
      expect: { action: 'conflict', conflict: 'changedOnServer', remote: 'changed', size: 7 },
    },
    {
      name: 'modified, gone from the server: conflict deletedOnServer',
      local: local({ 'a.html': ['9', 7] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], {}),
      expect: {
        action: 'conflict',
        conflict: 'deletedOnServer',
        remote: 'missing',
        size: 7,
        server: null,
      },
    },
    {
      name: 'modified, server judged by size: upload, unverified',
      local: local({ 'a.html': ['9', 7] }),
      base: base({ 'a.html': ['1', 5, obs(5, null, null)] }),
      remote: remote([''], { 'a.html': obs(5) }),
      expect: { action: 'upload', remote: 'sizeOnly', unverified: true, size: 7 },
    },
    {
      name: 'modified, folder not listed: upload, unverified',
      local: local({ 'css/a.css': ['9', 7] }),
      base: base({ 'css/a.css': ['1', 5] }),
      remote: remote([''], {}),
      expect: { action: 'upload', remote: 'unknown', unverified: true, size: 7, server: null },
    },
    {
      name: 'deleted, server unchanged: deleteRemote',
      local: {},
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(5) }),
      expect: {
        local: 'deleted',
        remote: 'unchanged',
        action: 'deleteRemote',
        unverified: false,
        size: 0,
      },
    },
    {
      name: 'deleted, server judged by size: deleteRemote, unverified',
      local: {},
      base: base({ 'a.html': ['1', 5, obs(5, T, 'mlsd')] }),
      remote: remote([''], { 'a.html': obs(5, T, 'mdtm') }),
      expect: { action: 'deleteRemote', remote: 'sizeOnly', unverified: true, size: 0 },
    },
    {
      name: 'deleted, server changed: conflict changedOnServer',
      local: {},
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(8) }),
      expect: { action: 'conflict', conflict: 'changedOnServer', remote: 'changed', size: 0 },
    },
    {
      name: 'deleted, folder not listed: nothing this time',
      local: {},
      base: base({ 'css/a.css': ['1', 5] }),
      remote: remote([''], {}),
      expect: null,
    },
    {
      name: 'deleted, already gone from the server: dropped from the base',
      local: {},
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], {}),
      expect: null,
      list: 'dropFromBase',
    },
    {
      name: 'unchanged, server changed: serverOnlyDrift',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(6) }),
      expect: null,
      list: 'serverOnlyDrift',
    },
    {
      name: 'unchanged, gone from the server: missingOnServer',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], {}),
      expect: null,
      list: 'missingOnServer',
    },
    {
      name: 'unchanged, server unchanged: nothing',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote([''], { 'a.html': obs(5) }),
      expect: null,
    },
    {
      name: 'unchanged, server judged by size: nothing',
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'a.html': ['1', 5, null] }),
      remote: remote([''], { 'a.html': obs(5) }),
      expect: null,
    },
    {
      name: 'unchanged, folder not listed: nothing',
      local: local({ 'x/a.html': ['1', 5] }),
      base: base({ 'x/a.html': ['1', 5] }),
      remote: remote([''], {}),
      expect: null,
    },
  ];

  it.each(rows)('$name', (row) => {
    const result = planFileSync({
      local: row.local,
      base: row.base,
      remote: row.remote,
      adopt: row.adopt,
    });
    const path = Object.keys({ ...row.local, ...row.base }).find(
      (p) => !(p === 'b.html' && !(p in row.local)),
    ) as string;
    const change = result.changes.find((c) => c.path === path);
    if (row.expect === null) expect(change).toBeUndefined();
    else expect(change).toMatchObject({ path, ...row.expect });
    for (const list of ['dropFromBase', 'serverOnlyDrift', 'missingOnServer'] as const) {
      expect(result[list]).toEqual(list === row.list ? [path] : []);
    }
    expect(result.conflicts).toEqual(result.changes.filter((c) => c.action === 'conflict'));
  });
});

describe('planFileSync totals and order', () => {
  it('sorts by plain code-unit order and counts bytes and deletes', () => {
    const result = plan({
      local: local({ 'b.html': ['1', 10], 'B.html': ['2', 20], 'a/z.css': ['3', 300] }),
      base: base({ 'old.txt': ['4', 4], 'Old.txt': ['5', 5], 'a/z.css': ['0', 1] }),
      remote: remote(['', 'a'], { 'old.txt': obs(4), 'Old.txt': obs(5), 'a/z.css': obs(1) }),
    });
    expect(result.changes.map((c) => c.path)).toEqual([
      'B.html',
      'Old.txt',
      'a/z.css',
      'b.html',
      'old.txt',
    ]);
    expect(result.uploadBytes).toBe(330);
    expect(result.deleteCount).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(result.firstDeploy).toBeNull();
    expect(result.clockShiftHours).toBeNull();
  });

  it('counts only upload bytes, not conflicts or adopts', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5], 'b.html': ['2', 7], 'c.html': ['3', 11] }),
      base: base({ 'b.html': ['0', 7] }),
      remote: remote([''], { 'a.html': obs(5), 'b.html': obs(99) }),
      adopt: 'bySize',
    });
    expect(result.changes.map(brief)).toEqual([
      {
        path: 'a.html',
        local: 'added',
        remote: 'untracked',
        action: 'adopt',
        conflict: null,
        unverified: true,
      },
      {
        path: 'b.html',
        local: 'modified',
        remote: 'changed',
        action: 'conflict',
        conflict: 'changedOnServer',
        unverified: false,
      },
      {
        path: 'c.html',
        local: 'added',
        remote: 'missing',
        action: 'upload',
        conflict: null,
        unverified: false,
      },
    ]);
    expect(result.uploadBytes).toBe(11);
    expect(result.conflicts.map((c) => c.path)).toEqual(['b.html']);
  });

  it('sorts the info lists too', () => {
    const result = plan({
      local: local({ 'z.txt': ['1', 1], 'a.txt': ['1', 1], 'm.txt': ['1', 1], 'b.txt': ['1', 1] }),
      base: base({
        'z.txt': ['1', 1],
        'a.txt': ['1', 1],
        'm.txt': ['1', 1],
        'b.txt': ['1', 1],
        'y.txt': ['1', 1],
        'c.txt': ['1', 1],
      }),
      remote: remote([''], { 'm.txt': obs(2), 'b.txt': obs(2) }),
    });
    expect(result.missingOnServer).toEqual(['a.txt', 'z.txt']);
    expect(result.serverOnlyDrift).toEqual(['b.txt', 'm.txt']);
    expect(result.dropFromBase).toEqual(['c.txt', 'y.txt']);
    expect(result.changes).toEqual([]);
  });
});

describe('planFileSync safety', () => {
  it('drops invalid and denied paths from every input', () => {
    const result = plan({
      local: local({ '.env': ['1', 1], '.claude/settings.json': ['1', 1], 'a/../b': ['1', 1] }),
      base: base({ '.git/config': ['1', 1], id_rsa: ['1', 1] }),
      remote: remote(['', '.git'], { '.env': obs(1), '.git/config': obs(9) }),
    });
    expect(result.changes).toEqual([]);
    expect(result.dropFromBase).toEqual([]);
    expect(result.serverOnlyDrift).toEqual([]);
    expect(result.firstDeploy).toBeNull();
  });

  it('allows the host config files a shared host needs', () => {
    const result = plan({
      local: local({ '.user.ini': ['1', 3], 'php.ini': ['2', 4], '.htaccess': ['3', 5] }),
      base: {},
      remote: remote([''], {}),
    });
    expect(result.changes.map((c) => [c.path, c.action])).toEqual([
      ['.htaccess', 'upload'],
      ['.user.ini', 'upload'],
      ['php.ini', 'upload'],
    ]);
  });

  it('never touches a file that is only on the server', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5] }),
      base: base({ 'a.html': ['1', 5] }),
      remote: remote(['', 'uploads'], {
        'a.html': obs(5),
        'other.html': obs(1),
        'uploads/x.jpg': obs(2),
      }),
    });
    expect(result.changes).toEqual([]);
    expect(result.serverOnlyDrift).toEqual([]);
    expect(result.missingOnServer).toEqual([]);
  });

  it('only deletes when the folder was listed', () => {
    const listed = plan({
      base: base({ 'css/a.css': ['1', 5] }),
      remote: remote(['', 'css'], { 'css/a.css': obs(5) }),
    });
    expect(listed.changes.map((c) => c.action)).toEqual(['deleteRemote']);
    const notListed = plan({
      base: base({ 'css/a.css': ['1', 5] }),
      remote: remote([''], { 'css/a.css': obs(5) }),
    });
    expect(notListed.changes).toEqual([]);
    expect(notListed.deleteCount).toBe(0);
    expect(notListed.dropFromBase).toEqual([]);
  });
});

describe('planFileSync without the server', () => {
  it('lists every local change as upload or delete, unknown and unverified', () => {
    const result = plan({
      local: local({ 'new.html': ['1', 5], 'mod.html': ['9', 7], 'same.html': ['3', 3] }),
      base: base({ 'mod.html': ['1', 6], 'gone.html': ['2', 2], 'same.html': ['3', 3] }),
      remote: null,
    });
    expect(result.changes.map(brief)).toEqual([
      {
        path: 'gone.html',
        local: 'deleted',
        remote: 'unknown',
        action: 'deleteRemote',
        conflict: null,
        unverified: true,
      },
      {
        path: 'mod.html',
        local: 'modified',
        remote: 'unknown',
        action: 'upload',
        conflict: null,
        unverified: true,
      },
      {
        path: 'new.html',
        local: 'added',
        remote: 'unknown',
        action: 'upload',
        conflict: null,
        unverified: true,
      },
    ]);
    expect(result.changes.map((c) => [c.size, c.server, c.base])).toEqual([
      [0, null, obs(2)],
      [7, null, obs(6)],
      [5, null, null],
    ]);
    expect(result.uploadBytes).toBe(12);
    expect(result.deleteCount).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.dropFromBase).toEqual([]);
    expect(result.serverOnlyDrift).toEqual([]);
    expect(result.missingOnServer).toEqual([]);
    expect(result.firstDeploy).toBeNull();
    expect(result.clockShiftHours).toBeNull();
  });

  it('still drops denied paths', () => {
    const result = plan({ local: local({ '.env': ['1', 1], 'AGENTS.md': ['1', 1] }) });
    expect(result.changes).toEqual([]);
  });
});

describe('planFileSync clock shift', () => {
  const shifted = (size: number, hours: number) => obs(size, T + hours * HOUR, 'mlsd');
  const at = (size: number) => obs(size, T, 'mlsd');

  it('treats a uniform whole-hour shift as unchanged and reports it', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5], 'b.html': ['9', 70], 'c.html': ['3', 3] }),
      base: base({
        'a.html': ['1', 5, at(5)],
        'b.html': ['2', 6, at(6)],
        'c.html': ['3', 3, at(3)],
        'd.html': ['4', 4, at(4)],
      }),
      remote: remote([''], {
        'a.html': shifted(5, 1),
        'b.html': shifted(6, 1),
        'c.html': shifted(3, 1),
        'd.html': shifted(4, 1),
      }),
    });
    expect(result.clockShiftHours).toBe(1);
    expect(result.changes.map(brief)).toEqual([
      {
        path: 'b.html',
        local: 'modified',
        remote: 'unchanged',
        action: 'upload',
        conflict: null,
        unverified: false,
      },
      {
        path: 'd.html',
        local: 'deleted',
        remote: 'unchanged',
        action: 'deleteRemote',
        conflict: null,
        unverified: false,
      },
    ]);
    expect(result.serverOnlyDrift).toEqual([]);
  });

  it('leaves a file whose size changed as changed, alongside a shift', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5], 'b.html': ['2', 6], 'c.html': ['3', 3] }),
      base: base({
        'a.html': ['1', 5, at(5)],
        'b.html': ['2', 6, at(6)],
        'c.html': ['3', 3, at(3)],
      }),
      remote: remote([''], {
        'a.html': shifted(5, -2),
        'b.html': shifted(6, -2),
        'c.html': shifted(9, -2),
      }),
    });
    expect(result.clockShiftHours).toBe(-2);
    expect(result.serverOnlyDrift).toEqual(['c.html']);
  });

  it('needs at least two shifted files', () => {
    const result = plan({
      local: local({ 'a.html': ['9', 5], 'b.html': ['2', 6] }),
      base: base({ 'a.html': ['1', 5, at(5)], 'b.html': ['2', 6, at(6)] }),
      remote: remote([''], { 'a.html': shifted(5, 1), 'b.html': at(6) }),
    });
    expect(result.clockShiftHours).toBeNull();
    expect(result.changes.map(brief)).toEqual([
      {
        path: 'a.html',
        local: 'modified',
        remote: 'changed',
        action: 'conflict',
        conflict: 'changedOnServer',
        unverified: false,
      },
    ]);
  });

  it('is not a shift when the hours differ', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5], 'b.html': ['2', 6] }),
      base: base({ 'a.html': ['1', 5, at(5)], 'b.html': ['2', 6, at(6)] }),
      remote: remote([''], { 'a.html': shifted(5, 1), 'b.html': shifted(6, 2) }),
    });
    expect(result.clockShiftHours).toBeNull();
    expect(result.serverOnlyDrift).toEqual(['a.html', 'b.html']);
  });

  it('is not a shift for times read another way', () => {
    const result = plan({
      local: local({ 'a.html': ['1', 5], 'b.html': ['2', 6] }),
      base: base({ 'a.html': ['1', 5, at(5)], 'b.html': ['2', 6, at(6)] }),
      remote: remote([''], {
        'a.html': obs(5, T + HOUR, 'mdtm'),
        'b.html': obs(6, T + HOUR, 'mdtm'),
      }),
    });
    expect(result.clockShiftHours).toBeNull();
    // Read another way, they compare by size only, and the sizes match.
    expect(result.serverOnlyDrift).toEqual([]);
  });
});

describe('planFileSync first deploy', () => {
  it('reports files already on the server, and how many have the same size', () => {
    const result = plan({
      local: local({ 'index.html': ['1', 10], 'css/a.css': ['2', 20], 'new.js': ['3', 30] }),
      base: {},
      remote: remote(['', 'css'], {
        'index.html': obs(10),
        'css/a.css': obs(21),
        'server-only.txt': obs(1),
      }),
    });
    expect(result.firstDeploy).toEqual({ existing: 2, sameSize: 1 });
    expect(result.changes.map((c) => [c.path, c.action, c.conflict])).toEqual([
      ['css/a.css', 'conflict', 'existsOnServer'],
      ['index.html', 'conflict', 'existsOnServer'],
      ['new.js', 'upload', null],
    ]);
    expect(result.uploadBytes).toBe(30);
  });

  it('adopts the same-size files with adopt by size and overwrites nothing else silently', () => {
    const result = plan({
      local: local({ 'index.html': ['1', 10], 'css/a.css': ['2', 20], 'new.js': ['3', 30] }),
      base: {},
      remote: remote(['', 'css'], { 'index.html': obs(10), 'css/a.css': obs(21) }),
      adopt: 'bySize',
    });
    expect(result.firstDeploy).toEqual({ existing: 2, sameSize: 1 });
    expect(result.changes.map((c) => [c.path, c.action, c.size])).toEqual([
      ['css/a.css', 'conflict', 20],
      ['index.html', 'adopt', 0],
      ['new.js', 'upload', 30],
    ]);
    expect(result.uploadBytes).toBe(30);
  });

  it('still reports a server folder that holds only other files', () => {
    const result = plan({
      local: local({ 'index.html': ['1', 10] }),
      remote: remote([''], { 'other.html': obs(3) }),
    });
    expect(result.firstDeploy).toEqual({ existing: 0, sameSize: 0 });
  });

  it('is null for an empty server folder, a known base, or no server read', () => {
    const files = local({ 'index.html': ['1', 10] });
    expect(plan({ local: files, remote: remote([''], {}) }).firstDeploy).toBeNull();
    expect(plan({ local: files }).firstDeploy).toBeNull();
    expect(
      plan({
        local: files,
        base: base({ 'index.html': ['1', 10] }),
        remote: remote([''], { 'index.html': obs(10) }),
      }).firstDeploy,
    ).toBeNull();
  });

  it('does not count denied server files', () => {
    const result = plan({
      local: local({ 'index.html': ['1', 10] }),
      remote: remote([''], { '.env': obs(3), '.git/config': obs(3) }),
    });
    expect(result.firstDeploy).toBeNull();
  });
});
