import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ScannerRunResult,
  SecurityFinding,
  SecurityScanOptions,
  SecurityScanRecord,
  SecurityScanStatus,
  SecuritySeverity,
  SecurityVerdict,
} from '@runova/core';
import Database from 'better-sqlite3';
import { app } from 'electron';

/**
 * Scan history, so reopening a project's Security tab shows the last report immediately instead
 * of making the user re-run a 20-minute scan to see what it already found.
 *
 * Same shape as skillAuditDb, including the native-module note: better-sqlite3 is rebuilt for
 * Electron's ABI by the `rebuild:native` script.
 *
 * Findings live in a JSON column rather than their own table. A scan is always read whole (the
 * report renders every severity group at once) and never queried across, so a second table would
 * buy nothing; the per-scanner finding cap is what keeps a row from growing without bound.
 */

let db: Database.Database | null = null;

interface SecurityScanRow {
  id: string;
  project_id: string;
  project_name: string;
  status: SecurityScanStatus;
  verdict: SecurityVerdict;
  score: number;
  findings: string;
  runs: string;
  counts: string;
  options: string;
  duration_ms: number;
  created_at: string;
}

function rowToRecord(row: SecurityScanRow): SecurityScanRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    status: row.status,
    verdict: row.verdict,
    score: row.score,
    findings: JSON.parse(row.findings) as SecurityFinding[],
    runs: JSON.parse(row.runs) as ScannerRunResult[],
    counts: JSON.parse(row.counts) as Record<SecuritySeverity, number>,
    options: JSON.parse(row.options) as SecurityScanOptions,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'security-scans.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT NOT NULL,
      score INTEGER NOT NULL,
      findings TEXT NOT NULL,
      runs TEXT NOT NULL,
      counts TEXT NOT NULL,
      options TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_scans_project
      ON security_scans(project_id, created_at DESC);
  `);
  return db;
}

const INSERT_SQL = `INSERT OR REPLACE INTO security_scans
  (id, project_id, project_name, status, verdict, score, findings, runs, counts, options,
   duration_ms, created_at)
  VALUES
  (@id, @projectId, @projectName, @status, @verdict, @score, @findings, @runs, @counts, @options,
   @durationMs, @createdAt)`;

/** Older runs past this per project are pruned, so history never grows without bound. */
const KEEP_PER_PROJECT = 25;

export const securityScanDb = {
  add(record: SecurityScanRecord): SecurityScanRecord {
    getDb()
      .prepare(INSERT_SQL)
      .run({
        id: record.id,
        projectId: record.projectId,
        projectName: record.projectName,
        status: record.status,
        verdict: record.verdict,
        score: record.score,
        findings: JSON.stringify(record.findings ?? []),
        runs: JSON.stringify(record.runs ?? []),
        counts: JSON.stringify(record.counts ?? {}),
        options: JSON.stringify(record.options ?? {}),
        durationMs: record.durationMs,
        createdAt: record.createdAt,
      });

    getDb()
      .prepare(
        `DELETE FROM security_scans WHERE project_id = ? AND id NOT IN (
           SELECT id FROM security_scans WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(record.projectId, record.projectId, KEEP_PER_PROJECT);

    return record;
  },

  /**
   * Newest first. Findings and scanner logs are stripped: the history dropdown only needs the
   * verdict, the score and the date, and 25 full reports with their output attached would be
   * several megabytes over IPC every time the tab opens. Opening one entry loads it in full.
   */
  list(projectId: string, limit = KEEP_PER_PROJECT): SecurityScanRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM security_scans WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit) as SecurityScanRow[];
    return rows.map((row) => {
      const record = rowToRecord(row);
      return {
        ...record,
        findings: [],
        runs: record.runs.map((run) => ({ ...run, log: null })),
      };
    });
  },

  get(id: string): SecurityScanRecord | null {
    const row = getDb().prepare('SELECT * FROM security_scans WHERE id = ?').get(id) as
      | SecurityScanRow
      | undefined;
    return row ? rowToRecord(row) : null;
  },

  latest(projectId: string): SecurityScanRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM security_scans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as SecurityScanRow | undefined;
    return row ? rowToRecord(row) : null;
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM security_scans WHERE id = ?').run(id);
  },
};
