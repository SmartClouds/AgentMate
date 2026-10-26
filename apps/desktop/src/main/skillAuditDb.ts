import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillAuditFinding, SkillAuditVerdict } from '@runova/core';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type { SkillAuditRecord, SkillAuditSourceKind } from '../shared/apiTypes';

// Same native-module note as promptHistoryDb: better-sqlite3 is rebuilt for
// Electron's ABI by the `rebuild:native` script.
let db: Database.Database | null = null;

interface SkillAuditRow {
  id: string;
  skill_id: string;
  skill_name: string;
  source_kind: SkillAuditSourceKind;
  source_label: string;
  project_id: string | null;
  verdict: SkillAuditVerdict;
  score: number;
  findings: string;
  files_scanned: number;
  bytes_scanned: number;
  deep_review: number;
  cli_name: string | null;
  ai_summary: string | null;
  ai_error: string | null;
  created_at: string;
}

function rowToRecord(row: SkillAuditRow): SkillAuditRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    projectId: row.project_id ?? null,
    verdict: row.verdict,
    score: row.score,
    findings: JSON.parse(row.findings) as SkillAuditFinding[],
    filesScanned: row.files_scanned,
    bytesScanned: row.bytes_scanned,
    deepReview: row.deep_review === 1,
    cliName: row.cli_name ?? null,
    aiSummary: row.ai_summary ?? null,
    aiError: row.ai_error ?? null,
    createdAt: row.created_at,
  };
}

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'skill-audits.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_audits (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_label TEXT NOT NULL,
      project_id TEXT,
      verdict TEXT NOT NULL,
      score INTEGER NOT NULL,
      findings TEXT NOT NULL,
      files_scanned INTEGER NOT NULL,
      bytes_scanned INTEGER NOT NULL,
      deep_review INTEGER NOT NULL,
      cli_name TEXT,
      ai_summary TEXT,
      ai_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_audits_created_at ON skill_audits(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_audits_skill_id ON skill_audits(skill_id, created_at DESC);
  `);
  return db;
}

function toRowValues(record: SkillAuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    skillId: record.skillId,
    skillName: record.skillName,
    sourceKind: record.sourceKind,
    sourceLabel: record.sourceLabel,
    projectId: record.projectId ?? null,
    verdict: record.verdict,
    score: record.score,
    findings: JSON.stringify(record.findings ?? []),
    filesScanned: record.filesScanned,
    bytesScanned: record.bytesScanned,
    deepReview: record.deepReview ? 1 : 0,
    cliName: record.cliName ?? null,
    aiSummary: record.aiSummary ?? null,
    aiError: record.aiError ?? null,
    createdAt: record.createdAt,
  };
}

const INSERT_SQL = `INSERT INTO skill_audits
  (id, skill_id, skill_name, source_kind, source_label, project_id, verdict, score, findings,
   files_scanned, bytes_scanned, deep_review, cli_name, ai_summary, ai_error, created_at)
  VALUES
  (@id, @skillId, @skillName, @sourceKind, @sourceLabel, @projectId, @verdict, @score, @findings,
   @filesScanned, @bytesScanned, @deepReview, @cliName, @aiSummary, @aiError, @createdAt)`;

export const skillAuditDb = {
  add(record: Omit<SkillAuditRecord, 'id' | 'createdAt'>): SkillAuditRecord {
    const full: SkillAuditRecord = {
      ...record,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    getDb().prepare(INSERT_SQL).run(toRowValues(full));
    return full;
  },

  /** Newest first. `skillId` narrows to one skill's own scan history. */
  list(options: { skillId?: string | null; limit?: number } = {}): SkillAuditRecord[] {
    const limit = options.limit ?? 200;
    const rows = options.skillId
      ? (getDb()
          .prepare('SELECT * FROM skill_audits WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(options.skillId, limit) as SkillAuditRow[])
      : (getDb()
          .prepare('SELECT * FROM skill_audits ORDER BY created_at DESC LIMIT ?')
          .all(limit) as SkillAuditRow[]);
    return rows.map(rowToRecord);
  },

  get(id: string): SkillAuditRecord | null {
    const row = getDb().prepare('SELECT * FROM skill_audits WHERE id = ?').get(id) as
      | SkillAuditRow
      | undefined;
    return row ? rowToRecord(row) : null;
  },

  /** The most recent scan of each skill, so cards can show a verdict without rescanning. */
  latestPerSkill(): SkillAuditRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM skill_audits WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY created_at DESC) AS rn
             FROM skill_audits
           ) WHERE rn = 1
         ) ORDER BY created_at DESC`,
      )
      .all() as SkillAuditRow[];
    return rows.map(rowToRecord);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM skill_audits WHERE id = ?').run(id);
  },

  clear(): void {
    getDb().prepare('DELETE FROM skill_audits').run();
  },

  /** Full table, unlike `list()` which caps out. Used for backup export. */
  exportAll(): SkillAuditRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM skill_audits ORDER BY created_at DESC')
      .all() as SkillAuditRow[];
    return rows.map(rowToRecord);
  },

  /** Replaces the entire table with `records`. Used for backup restore. */
  importAll(records: SkillAuditRecord[]): void {
    const database = getDb();
    const insert = database.prepare(INSERT_SQL);
    database.transaction((rows: SkillAuditRecord[]) => {
      database.prepare('DELETE FROM skill_audits').run();
      for (const record of rows) insert.run(toRowValues(record));
    })(records);
  },
};
