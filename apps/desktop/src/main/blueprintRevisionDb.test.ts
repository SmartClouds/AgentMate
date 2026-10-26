import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BlueprintRevision } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddBlueprintRevisionInput } from '../shared/apiTypes';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * Blueprint revision history: one log per section plus one for the final prompt, capped so it
 * cannot grow without bound and take every backup with it. The `step_id IS @stepId` comparisons
 * are the interesting part, since the final prompt's history is keyed by a NULL step.
 */

const userData = useTempUserData();

/**
 * Nothing closes these sqlite handles, and Windows will not remove a folder that still holds an
 * open file, so the harness cleanup would throw. Each connection is recorded and closed first.
 */
const openDatabases = new Set<DatabaseSync>();
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function trackedPrepare(this: DatabaseSync, sql: string) {
  openDatabases.add(this);
  return nativePrepare.call(this, sql);
};
DatabaseSync.prototype.exec = function trackedExec(this: DatabaseSync, sql: string) {
  openDatabases.add(this);
  return nativeExec.call(this, sql);
};

function closeOpenDatabases(): void {
  for (const database of openDatabases) {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }
  openDatabases.clear();
}

afterEach(closeOpenDatabases);

type Db = typeof import('./blueprintRevisionDb')['blueprintRevisionDb'];

async function loadDb(): Promise<Db> {
  return (await import('./blueprintRevisionDb')).blueprintRevisionDb;
}

// `add` stamps created_at itself, and ordering is what most of this file is about.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
});

function input(overrides: Partial<AddBlueprintRevisionInput> = {}): AddBlueprintRevisionInput {
  return {
    blueprintId: 'bp-1',
    projectId: 'alpha',
    target: 'section',
    stepId: 'idea',
    text: 'The first draft.',
    ...overrides,
  };
}

/** Adds revisions a simulated minute apart, oldest first. */
function addSpaced(
  db: Db,
  count: number,
  overrides: Partial<AddBlueprintRevisionInput> = {},
): BlueprintRevision[] {
  return Array.from({ length: count }, (_, index) => {
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 12, index)));
    return db.add(input({ text: `draft ${index}`, ...overrides }));
  });
}

describe('schema creation', () => {
  it('creates the database on first use and reads the entry back', async () => {
    const db = await loadDb();

    const entry = db.add(input({ attachmentNames: ['shot.png'] }));

    expect(existsSync(join(userData.dir, 'data', 'blueprint-revisions.db'))).toBe(true);
    expect(entry).toMatchObject({
      blueprintId: 'bp-1',
      projectId: 'alpha',
      target: 'section',
      stepId: 'idea',
      attachmentNames: ['shot.png'],
      createdAt: '2026-03-01T12:00:00.000Z',
    });
    expect(db.list('alpha', 'idea')).toEqual([entry]);
  });

  it('defaults the step and the attachment names when they are left out', async () => {
    const db = await loadDb();

    const entry = db.add({
      blueprintId: 'bp-1',
      projectId: 'alpha',
      target: 'final-prompt',
      text: 'The prompt.',
    });

    expect(entry.stepId).toBeNull();
    expect(entry.attachmentNames).toEqual([]);
    expect(db.list('alpha', null)).toEqual([entry]);
  });

  it('reopens a database that already holds revisions', async () => {
    const first = await loadDb();
    const entry = first.add(input());
    closeOpenDatabases();

    vi.resetModules();
    const second = await loadDb();

    expect(second.list('alpha', 'idea')).toEqual([entry]);
  });
});

describe('list', () => {
  it('returns the newest revision first', async () => {
    const db = await loadDb();
    addSpaced(db, 3);

    expect(db.list('alpha', 'idea').map((one) => one.text)).toEqual([
      'draft 2',
      'draft 1',
      'draft 0',
    ]);
  });

  it('keeps two revisions written in the same millisecond in insert order', async () => {
    const db = await loadDb();
    const first = db.add(input({ text: 'first' }));
    const second = db.add(input({ text: 'second' }));

    // Same created_at to the millisecond, so the rowid tiebreak is the only thing separating them.
    expect(first.createdAt).toBe(second.createdAt);
    expect(db.list('alpha', 'idea').map((one) => one.text)).toEqual(['second', 'first']);
  });

  it('tells one step apart from another', async () => {
    const db = await loadDb();
    addSpaced(db, 2, { stepId: 'idea' });
    addSpaced(db, 1, { stepId: 'backend' });

    expect(db.list('alpha', 'idea')).toHaveLength(2);
    expect(db.list('alpha', 'backend')).toHaveLength(1);
  });

  it('keeps the final prompt history separate from every section', async () => {
    const db = await loadDb();
    addSpaced(db, 2, { stepId: 'idea' });
    db.add(input({ target: 'final-prompt', stepId: null, text: 'the prompt' }));

    // A null step is matched with IS, not =, so this is the query that would silently return
    // nothing if the comparison were ever written as `step_id = @stepId`.
    expect(db.list('alpha', null).map((one) => one.text)).toEqual(['the prompt']);
    expect(db.list('alpha', 'idea')).toHaveLength(2);
  });

  it('keeps one project out of another project history', async () => {
    const db = await loadDb();
    addSpaced(db, 2, { projectId: 'alpha' });
    addSpaced(db, 1, { projectId: 'beta' });

    expect(db.list('alpha', 'idea')).toHaveLength(2);
    expect(db.list('beta', 'idea')).toHaveLength(1);
  });

  it('honours the limit, newest first', async () => {
    const db = await loadDb();
    addSpaced(db, 5);

    expect(db.list('alpha', 'idea', 2).map((one) => one.text)).toEqual(['draft 4', 'draft 3']);
  });

  it('is empty for a project that has no revisions', async () => {
    const db = await loadDb();
    db.add(input());

    expect(db.list('gamma', 'idea')).toEqual([]);
  });
});

describe('pruning', () => {
  it('keeps the newest hundred revisions of one step', async () => {
    const db = await loadDb();
    addSpaced(db, 105);

    const kept = db.list('alpha', 'idea', 500);

    expect(kept).toHaveLength(100);
    expect(kept[0].text).toBe('draft 104');
    expect(kept.at(-1)?.text).toBe('draft 5');
  });

  it('prunes each step on its own', async () => {
    const db = await loadDb();
    addSpaced(db, 101, { stepId: 'idea' });
    addSpaced(db, 3, { stepId: 'backend' });

    // Adding to one step must not evict another step's history.
    expect(db.list('alpha', 'idea', 500)).toHaveLength(100);
    expect(db.list('alpha', 'backend', 500)).toHaveLength(3);
  });

  it('prunes the final prompt history on its own too', async () => {
    const db = await loadDb();
    addSpaced(db, 101, { target: 'final-prompt', stepId: null });
    addSpaced(db, 2, { stepId: 'idea' });

    expect(db.list('alpha', null, 500)).toHaveLength(100);
    expect(db.list('alpha', 'idea', 500)).toHaveLength(2);
  });
});

describe('removeForProject', () => {
  it('drops every revision of that project and leaves the others', async () => {
    const db = await loadDb();
    addSpaced(db, 2, { projectId: 'alpha', stepId: 'idea' });
    db.add(input({ projectId: 'alpha', target: 'final-prompt', stepId: null }));
    addSpaced(db, 1, { projectId: 'beta' });

    db.removeForProject('alpha');

    expect(db.list('alpha', 'idea')).toEqual([]);
    expect(db.list('alpha', null)).toEqual([]);
    expect(db.list('beta', 'idea')).toHaveLength(1);
  });

  it('does nothing for a project that had none', async () => {
    const db = await loadDb();
    db.add(input());

    expect(() => db.removeForProject('gamma')).not.toThrow();
    expect(db.exportAll()).toHaveLength(1);
  });
});

describe('backup export and import', () => {
  it('exports the whole table, past the cap list() applies', async () => {
    const db = await loadDb();
    addSpaced(db, 4, { stepId: 'idea' });
    addSpaced(db, 2, { stepId: 'backend' });

    expect(db.list('alpha', 'idea', 2)).toHaveLength(2);
    expect(db.exportAll()).toHaveLength(6);
  });

  it('replaces the table with what the backup carried', async () => {
    const db = await loadDb();
    db.add(input({ text: 'will be gone' }));
    const restored: BlueprintRevision = {
      id: 'restored-1',
      blueprintId: 'bp-9',
      projectId: 'beta',
      target: 'final-prompt',
      stepId: null,
      text: 'from the backup',
      attachmentNames: ['a.png', 'b.png'],
      createdAt: '2026-02-02T00:00:00.000Z',
    };

    db.importAll([restored]);

    expect(db.exportAll()).toEqual([restored]);
  });

  it('rolls the import back when one row cannot be inserted', async () => {
    const db = await loadDb();
    const existing = db.add(input({ text: 'still here afterwards' }));
    const duplicate: BlueprintRevision = {
      id: 'same-id',
      blueprintId: 'bp-9',
      projectId: 'beta',
      target: 'section',
      stepId: 'idea',
      text: 'a',
      attachmentNames: [],
      createdAt: '2026-02-02T00:00:00.000Z',
    };

    // Two rows sharing a primary key, so the second insert fails inside the transaction.
    expect(() => db.importAll([duplicate, { ...duplicate, text: 'b' }])).toThrow();

    // The delete that opened the transaction has to roll back as well, or a failed restore would
    // wipe the history the user still had.
    expect(db.exportAll()).toEqual([existing]);
  });

  it('fills in attachment names the backup left out', async () => {
    const db = await loadDb();
    const partial = {
      id: 'no-names',
      blueprintId: 'bp-9',
      projectId: 'beta',
      target: 'section',
      stepId: 'idea',
      text: 'a',
      createdAt: '2026-02-02T00:00:00.000Z',
    } as unknown as BlueprintRevision;

    db.importAll([partial]);

    // The column is NOT NULL, so a missing list has to become empty JSON rather than a crash.
    expect(db.exportAll()[0].attachmentNames).toEqual([]);
  });
});
