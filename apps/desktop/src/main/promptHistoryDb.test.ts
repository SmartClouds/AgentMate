import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddPromptHistoryInput, PromptHistoryEntry } from '../shared/apiTypes';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * The prompt history table: the schema it creates on a fresh profile, the columns it adds to a
 * database written by an older build, and the reads the Prompt Builder page depends on. Real SQL
 * throughout, through the node:sqlite shim the main project aliases better-sqlite3 to.
 */

const userData = useTempUserData();

/**
 * Two divergences between the shim and better-sqlite3 have to be closed for these tests to
 * exercise the real code path.
 *
 * better-sqlite3 binds named parameters by walking the parameters in the statement, so keys on the
 * object that no parameter uses are simply ignored; `add` relies on that, since it passes the whole
 * entry (tags included) to an insert that has no tags parameter. node:sqlite throws instead.
 *
 * Nothing closes these connections either, and Windows will not remove a folder that still holds an
 * open file, so every connection is recorded and closed before the harness deletes the temp
 * profile.
 */
const openDatabases = new Set<DatabaseSync>();
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function trackedPrepare(this: DatabaseSync, sql: string) {
  openDatabases.add(this);
  const statement = nativePrepare.call(this, sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement;
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
      // Already closed. Nothing is holding the folder either way.
    }
  }
  openDatabases.clear();
}

afterEach(closeOpenDatabases);

type Db = typeof import('./promptHistoryDb')['promptHistoryDb'];

async function loadDb(): Promise<Db> {
  return (await import('./promptHistoryDb')).promptHistoryDb;
}

function dbPath(): string {
  return join(userData.dir, 'data', 'prompt-history.db');
}

function input(overrides: Partial<AddPromptHistoryInput> = {}): AddPromptHistoryInput {
  return {
    rawInput: 'build me a login page',
    promptType: 'feature',
    targetAI: 'claude-code',
    content: 'Build a login page.',
    source: 'generate',
    ...overrides,
  };
}

/** Clock control, so the created_at ordering under test is chosen rather than raced for. */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
});

/** Adds entries one simulated minute apart, oldest first, and returns them in that order. */
async function addSpaced(db: Db, count: number, overrides: Partial<AddPromptHistoryInput> = {}) {
  const entries: PromptHistoryEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 12, index)));
    entries.push(db.add(input({ rawInput: `entry ${index}`, ...overrides })));
  }
  return entries;
}

describe('schema creation', () => {
  it('creates the database and its table on an empty profile', async () => {
    const db = await loadDb();

    const entry = db.add(input());

    expect(existsSync(dbPath())).toBe(true);
    expect(entry).toMatchObject({
      rawInput: 'build me a login page',
      tags: [],
      projectId: null,
      createdAt: '2026-03-01T12:00:00.000Z',
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.list()).toEqual([entry]);
  });

  it('adds the tags and project_id columns to a database an older build wrote', async () => {
    // The shape before either column existed, with a row already in it.
    const legacy = new DatabaseSync(dbPath());
    legacy.exec(`
      CREATE TABLE prompt_history (
        id TEXT PRIMARY KEY,
        raw_input TEXT NOT NULL,
        prompt_type TEXT NOT NULL,
        target_ai TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO prompt_history VALUES
        ('old-1', 'old raw', 'feature', 'claude-code', 'old content', 'generate',
         '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = await loadDb();
    const [entry] = db.list();

    // The row survives the migration, with the new columns filled in rather than missing.
    expect(entry).toEqual({
      id: 'old-1',
      rawInput: 'old raw',
      promptType: 'feature',
      targetAI: 'claude-code',
      content: 'old content',
      source: 'generate',
      tags: [],
      projectId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reopens a database that already has rows in it', async () => {
    const first = await loadDb();
    const entry = first.add(input({ rawInput: 'from the first run' }));
    closeOpenDatabases();

    // A second launch: fresh module registry, same file on disk.
    vi.resetModules();
    const second = await loadDb();

    expect(second.list()).toEqual([entry]);
  });
});

describe('list', () => {
  it('returns the newest entry first', async () => {
    const db = await loadDb();
    const added = await addSpaced(db, 3);

    expect(db.list().map((one) => one.rawInput)).toEqual(['entry 2', 'entry 1', 'entry 0']);
    expect(db.list()[0].createdAt).toBe(added[2].createdAt);
  });

  it('keeps the newest first when two entries share a millisecond', async () => {
    const db = await loadDb();
    // The clock stays put, as it does for two saves that land in the same millisecond.
    db.add(input({ rawInput: 'first' }));
    db.add(input({ rawInput: 'second' }));

    expect(db.list().map((one) => one.rawInput)).toEqual(['second', 'first']);
    expect(db.search('').map((one) => one.rawInput)).toEqual(['second', 'first']);
  });

  it('honours the limit', async () => {
    const db = await loadDb();
    await addSpaced(db, 5);

    const rows = db.list(null, 2);

    // Newest first, so a limit takes the most recent rather than an arbitrary slice.
    expect(rows.map((one) => one.rawInput)).toEqual(['entry 4', 'entry 3']);
  });

  it('narrows to one project when asked', async () => {
    const db = await loadDb();
    await addSpaced(db, 2, { projectId: 'alpha' });
    await addSpaced(db, 1, { projectId: 'beta' });

    expect(db.list('alpha')).toHaveLength(2);
    expect(db.list('beta')).toHaveLength(1);
    // No project id means the whole table, not the entries with no project.
    expect(db.list()).toHaveLength(3);
  });
});

describe('search', () => {
  it('matches the raw input, the content, the type and the target', async () => {
    const db = await loadDb();
    db.add(input({ rawInput: 'needle in the input', content: 'nothing here' }));
    db.add(input({ rawInput: 'nothing here', content: 'needle in the content' }));
    db.add(input({ rawInput: 'a', content: 'b', promptType: 'needle-type' }));
    db.add(input({ rawInput: 'c', content: 'd', targetAI: 'needle-ai' }));
    db.add(input({ rawInput: 'unrelated', content: 'unrelated' }));

    expect(db.search('needle')).toHaveLength(4);
  });

  it('is case insensitive for plain ASCII, the way LIKE is', async () => {
    const db = await loadDb();
    db.add(input({ rawInput: 'Deploy The Thing' }));

    expect(db.search('deploy the thing')).toHaveLength(1);
  });

  it('combines the query with a project filter', async () => {
    const db = await loadDb();
    db.add(input({ rawInput: 'shared word', projectId: 'alpha' }));
    db.add(input({ rawInput: 'shared word', projectId: 'beta' }));

    expect(db.search('shared', 'alpha')).toHaveLength(1);
  });

  it('returns nothing when the query matches nothing', async () => {
    const db = await loadDb();
    db.add(input());

    expect(db.search('zzz-not-present')).toEqual([]);
  });

  it('keeps the newest first ordering and the limit', async () => {
    const db = await loadDb();
    await addSpaced(db, 4);

    expect(db.search('entry', null, 2).map((one) => one.rawInput)).toEqual(['entry 3', 'entry 2']);
  });
});

describe('editing one entry', () => {
  it('removes only the entry asked for', async () => {
    const db = await loadDb();
    const [first, second] = await addSpaced(db, 2);

    db.remove(first.id);

    expect(db.list().map((one) => one.id)).toEqual([second.id]);
  });

  it('ignores a remove for an id that is not there', async () => {
    const db = await loadDb();
    db.add(input());

    expect(() => db.remove('no-such-id')).not.toThrow();
    expect(db.list()).toHaveLength(1);
  });

  it('re-files an entry under another project and back to none', async () => {
    const db = await loadDb();
    const entry = db.add(input());

    db.setProject(entry.id, 'alpha');
    expect(db.list('alpha')).toHaveLength(1);

    db.setProject(entry.id, null);
    expect(db.list('alpha')).toEqual([]);
    expect(db.list()[0].projectId).toBeNull();
  });

  it('stores tags as JSON and reads them back as an array', async () => {
    const db = await loadDb();
    const entry = db.add(input());

    db.setTags(entry.id, ['api', 'auth']);

    expect(db.list()[0].tags).toEqual(['api', 'auth']);
  });

  it('clears the tags back to an empty list', async () => {
    const db = await loadDb();
    const entry = db.add(input());
    db.setTags(entry.id, ['api']);

    db.setTags(entry.id, []);

    expect(db.list()[0].tags).toEqual([]);
  });
});

describe('backup export and import', () => {
  it('exports the whole table, past the cap list() applies', async () => {
    const db = await loadDb();
    await addSpaced(db, 6);

    expect(db.list(null, 2)).toHaveLength(2);
    expect(db.exportAll()).toHaveLength(6);
  });

  it('replaces everything the table held', async () => {
    const db = await loadDb();
    db.add(input({ rawInput: 'will be gone' }));
    const restored: PromptHistoryEntry[] = [
      {
        id: 'restored-1',
        rawInput: 'from the backup',
        promptType: 'feature',
        targetAI: 'codex',
        content: 'restored',
        source: 'translate',
        tags: ['restored'],
        projectId: 'alpha',
        createdAt: '2026-02-02T00:00:00.000Z',
      },
    ];

    db.importAll(restored);

    expect(db.exportAll()).toEqual(restored);
  });

  it('rolls the whole import back when one row is bad', async () => {
    const db = await loadDb();
    const existing = db.add(input({ rawInput: 'still here afterwards' }));
    const duplicate: PromptHistoryEntry = {
      id: 'same-id',
      rawInput: 'a',
      promptType: 'feature',
      targetAI: 'codex',
      content: 'a',
      source: 'generate',
      tags: [],
      projectId: null,
      createdAt: '2026-02-02T00:00:00.000Z',
    };

    // Two rows with one primary key: the second insert fails partway through the transaction.
    expect(() => db.importAll([duplicate, { ...duplicate, rawInput: 'b' }])).toThrow();

    // The delete that opened the transaction has to be undone too, or a failed restore would
    // leave the user with nothing at all.
    expect(db.exportAll()).toEqual([existing]);
  });

  it('accepts an entry whose tags are missing entirely', async () => {
    const db = await loadDb();
    const partial = {
      id: 'no-tags',
      rawInput: 'a',
      promptType: 'feature',
      targetAI: 'codex',
      content: 'a',
      source: 'generate',
      projectId: null,
      createdAt: '2026-02-02T00:00:00.000Z',
    } as unknown as PromptHistoryEntry;

    db.importAll([partial]);

    expect(db.exportAll()[0].tags).toEqual([]);
  });
});
