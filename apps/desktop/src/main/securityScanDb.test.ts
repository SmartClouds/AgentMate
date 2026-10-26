import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ScannerRunResult,
  SecurityFinding,
  SecurityScanRecord,
  SecuritySeverity,
} from '@runova/core';
import { DEFAULT_SCAN_OPTIONS } from '@runova/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * Scan history: what the Security tab reads when it opens, what the dropdown is allowed to carry
 * over IPC, and the per-project pruning that keeps the table from growing forever.
 */

const userData = useTempUserData();

/**
 * The stores never close their sqlite handle, and Windows will not delete a folder that still has
 * an open file in it, so the harness cleanup would throw. Every connection is recorded as it
 * prepares or execs, and closed before the temp profile is removed.
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

type Db = typeof import('./securityScanDb')['securityScanDb'];

async function loadDb(): Promise<Db> {
  return (await import('./securityScanDb')).securityScanDb;
}

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'f1',
    scannerId: 'semgrep',
    ruleId: 'rule.one',
    title: 'Hardcoded secret',
    detail: 'A token is checked in.',
    severity: 'high',
    nativeSeverity: 'ERROR',
    kind: 'secret',
    file: 'src/index.ts',
    line: 12,
    endLine: 12,
    excerpt: null,
    cwe: ['CWE-798'],
    owasp: [],
    cve: null,
    packageName: null,
    installedVersion: null,
    fixedVersion: null,
    helpUri: null,
    remediation: null,
    redacted: true,
    ...overrides,
  };
}

function run(overrides: Partial<ScannerRunResult> = {}): ScannerRunResult {
  return {
    scannerId: 'semgrep',
    status: 'ok',
    transport: 'native',
    toolVersion: '1.2.3',
    findingCount: 1,
    durationMs: 900,
    exitCode: 0,
    truncated: false,
    error: null,
    warnings: [],
    log: 'semgrep says hello',
    ...overrides,
  };
}

const NO_COUNTS: Record<SecuritySeverity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
};

function record(overrides: Partial<SecurityScanRecord> = {}): SecurityScanRecord {
  return {
    id: 's1',
    projectId: 'alpha',
    projectName: 'Alpha',
    status: 'complete',
    verdict: 'caution',
    score: 72,
    findings: [finding()],
    runs: [run()],
    counts: { ...NO_COUNTS, high: 1 },
    options: { ...DEFAULT_SCAN_OPTIONS },
    durationMs: 1500,
    createdAt: '2026-03-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('schema creation', () => {
  it('creates the database on first use and reads a record back whole', async () => {
    const db = await loadDb();
    const saved = record();

    db.add(saved);

    expect(existsSync(join(userData.dir, 'data', 'security-scans.db'))).toBe(true);
    // Everything that went into a JSON column has to survive the round trip, not just the scalars.
    expect(db.get('s1')).toEqual(saved);
  });

  it('reopens a database that already holds scans', async () => {
    const first = await loadDb();
    first.add(record());
    closeOpenDatabases();

    vi.resetModules();
    const second = await loadDb();

    expect(second.get('s1')?.projectName).toBe('Alpha');
  });

  it('returns null for an id that is not there', async () => {
    const db = await loadDb();

    expect(db.get('nope')).toBeNull();
    expect(db.latest('nope')).toBeNull();
  });
});

describe('list', () => {
  it('returns the newest scan first', async () => {
    const db = await loadDb();
    db.add(record({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }));
    db.add(record({ id: 'new', createdAt: '2026-02-01T00:00:00.000Z' }));

    expect(db.list('alpha').map((one) => one.id)).toEqual(['new', 'old']);
  });

  it('strips the findings and the scanner logs', async () => {
    const db = await loadDb();
    db.add(record());

    const [summary] = db.list('alpha');

    // Twenty five full reports with their tool output attached would be megabytes over IPC every
    // time the tab opens, so the dropdown gets the verdict and the date only.
    expect(summary.findings).toEqual([]);
    expect(summary.runs[0].log).toBeNull();
    expect(summary.runs[0].findingCount).toBe(1);
    expect(summary.verdict).toBe('caution');
    expect(summary.score).toBe(72);
    // The full record is still there for whoever opens that entry.
    expect(db.get('s1')?.findings).toHaveLength(1);
  });

  it('keeps one project out of another project history', async () => {
    const db = await loadDb();
    db.add(record({ id: 'a1', projectId: 'alpha' }));
    db.add(record({ id: 'b1', projectId: 'beta' }));

    expect(db.list('alpha').map((one) => one.id)).toEqual(['a1']);
    expect(db.list('beta').map((one) => one.id)).toEqual(['b1']);
  });

  it('honours the limit', async () => {
    const db = await loadDb();
    for (let index = 0; index < 5; index += 1) {
      db.add(record({ id: `s${index}`, createdAt: `2026-03-0${index + 1}T00:00:00.000Z` }));
    }

    expect(db.list('alpha', 2).map((one) => one.id)).toEqual(['s4', 's3']);
  });
});

describe('latest', () => {
  it('picks the most recent scan for that project only', async () => {
    const db = await loadDb();
    db.add(record({ id: 'a-old', projectId: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' }));
    db.add(record({ id: 'b-new', projectId: 'beta', createdAt: '2026-05-01T00:00:00.000Z' }));
    db.add(record({ id: 'a-new', projectId: 'alpha', createdAt: '2026-02-01T00:00:00.000Z' }));

    expect(db.latest('alpha')?.id).toBe('a-new');
    // Unlike list(), this one keeps the findings: it is what the tab renders on open.
    expect(db.latest('alpha')?.findings).toHaveLength(1);
  });
});

describe('add', () => {
  it('replaces a scan saved under the same id', async () => {
    const db = await loadDb();
    db.add(record({ status: 'partial', score: 10 }));

    db.add(record({ status: 'complete', score: 90 }));

    expect(db.list('alpha')).toHaveLength(1);
    expect(db.get('s1')?.score).toBe(90);
  });

  it('prunes to the newest twenty five runs of that project', async () => {
    const db = await loadDb();
    for (let index = 0; index < 30; index += 1) {
      db.add(
        record({
          id: `s${String(index).padStart(2, '0')}`,
          createdAt: `2026-03-01T${String(index).padStart(2, '0')}:00:00.000Z`,
        }),
      );
    }

    const kept = db.list('alpha', 100);

    expect(kept).toHaveLength(25);
    expect(kept.at(-1)?.id).toBe('s05');
  });

  it('leaves another project untouched while pruning', async () => {
    const db = await loadDb();
    db.add(record({ id: 'beta-1', projectId: 'beta' }));
    for (let index = 0; index < 30; index += 1) {
      db.add(
        record({
          id: `s${String(index).padStart(2, '0')}`,
          createdAt: `2026-03-01T${String(index).padStart(2, '0')}:00:00.000Z`,
        }),
      );
    }

    expect(db.get('beta-1')).not.toBeNull();
  });

  it('accepts a record whose lists came back missing', async () => {
    const db = await loadDb();
    const partial = {
      ...record(),
      findings: undefined,
      runs: undefined,
      counts: undefined,
      options: undefined,
    } as unknown as SecurityScanRecord;

    db.add(partial);

    // The columns are NOT NULL, so a half built record has to become empty JSON, not a crash.
    expect(db.get('s1')).toMatchObject({ findings: [], runs: [], counts: {}, options: {} });
  });
});

describe('remove', () => {
  it('deletes only the scan asked for', async () => {
    const db = await loadDb();
    db.add(record({ id: 'a1' }));
    db.add(record({ id: 'a2', createdAt: '2026-04-01T00:00:00.000Z' }));

    db.remove('a1');

    expect(db.list('alpha').map((one) => one.id)).toEqual(['a2']);
  });

  it('ignores an id that is not there', async () => {
    const db = await loadDb();
    db.add(record());

    expect(() => db.remove('no-such-scan')).not.toThrow();
    expect(db.list('alpha')).toHaveLength(1);
  });
});
