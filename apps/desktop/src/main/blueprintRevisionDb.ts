import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BlueprintRevision, BlueprintRevisionTarget, BlueprintStepId } from '@runova/core';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type { AddBlueprintRevisionInput } from '../shared/apiTypes';

// Same native-binding caveat as prompt-history: better-sqlite3 is not N-API
// based, so its binding is tied to the Electron ABI it runs under. See the
// `rebuild:native` script in package.json.
let db: Database.Database | null = null;

/**
 * How many revisions are kept per section (and for the final prompt). The
 * history is a log rather than a version chain, so it would otherwise grow
 * without limit and take every backup with it.
 */
const MAX_REVISIONS_PER_TARGET = 100;

interface BlueprintRevisionRow {
  id: string;
  blueprint_id: string;
  project_id: string;
  target: BlueprintRevisionTarget;
  step_id: string | null;
  text: string;
  attachment_names: string;
  created_at: string;
}

function rowToEntry(row: BlueprintRevisionRow): BlueprintRevision {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    projectId: row.project_id,
    target: row.target,
    stepId: (row.step_id as BlueprintStepId | null) ?? null,
    text: row.text,
    attachmentNames: row.attachment_names ? (JSON.parse(row.attachment_names) as string[]) : [],
    createdAt: row.created_at,
  };
}

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'blueprint-revisions.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_revisions (
      id TEXT PRIMARY KEY,
      blueprint_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      target TEXT NOT NULL,
      step_id TEXT,
      text TEXT NOT NULL,
      attachment_names TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blueprint_revisions_project
      ON blueprint_revisions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blueprint_revisions_target
      ON blueprint_revisions(blueprint_id, target, step_id, created_at DESC);
  `);
  return db;
}

/** Keeps the newest MAX_REVISIONS_PER_TARGET rows for one section or prompt. */
function prune(database: Database.Database, entry: BlueprintRevision): void {
  database
    .prepare(
      `DELETE FROM blueprint_revisions
       WHERE blueprint_id = @blueprintId AND target = @target
         AND step_id IS @stepId
         AND id NOT IN (
           SELECT id FROM blueprint_revisions
           WHERE blueprint_id = @blueprintId AND target = @target AND step_id IS @stepId
           ORDER BY created_at DESC, rowid DESC
           LIMIT @limit
         )`,
    )
    .run({
      blueprintId: entry.blueprintId,
      target: entry.target,
      stepId: entry.stepId,
      limit: MAX_REVISIONS_PER_TARGET,
    });
}

export const blueprintRevisionDb = {
  add(input: AddBlueprintRevisionInput): BlueprintRevision {
    const entry: BlueprintRevision = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
      stepId: input.stepId ?? null,
      attachmentNames: input.attachmentNames ?? [],
    };
    const database = getDb();
    database
      .prepare(
        `INSERT INTO blueprint_revisions
           (id, blueprint_id, project_id, target, step_id, text, attachment_names, created_at)
         VALUES (@id, @blueprintId, @projectId, @target, @stepId, @text, @attachmentNames, @createdAt)`,
      )
      .run({ ...entry, attachmentNames: JSON.stringify(entry.attachmentNames) });
    prune(database, entry);
    return entry;
  },

  /** Newest first. `stepId` of null asks for the final prompt's history. */
  list(projectId: string, stepId: BlueprintStepId | null, limit = 100): BlueprintRevision[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM blueprint_revisions
         WHERE project_id = @projectId AND step_id IS @stepId
         ORDER BY created_at DESC, rowid DESC
         LIMIT @limit`,
      )
      .all({ projectId, stepId, limit }) as BlueprintRevisionRow[];
    return rows.map(rowToEntry);
  },

  removeForProject(projectId: string): void {
    getDb().prepare('DELETE FROM blueprint_revisions WHERE project_id = ?').run(projectId);
  },

  /** Full table, unlike `list()` which caps out. Used for backup export. */
  exportAll(): BlueprintRevision[] {
    const rows = getDb()
      .prepare('SELECT * FROM blueprint_revisions ORDER BY created_at DESC')
      .all() as BlueprintRevisionRow[];
    return rows.map(rowToEntry);
  },

  /** Replaces the entire table with `entries`. Used for backup restore. */
  importAll(entries: BlueprintRevision[]): void {
    const database = getDb();
    const insert = database.prepare(
      `INSERT INTO blueprint_revisions
         (id, blueprint_id, project_id, target, step_id, text, attachment_names, created_at)
       VALUES (@id, @blueprintId, @projectId, @target, @stepId, @text, @attachmentNames, @createdAt)`,
    );
    database.transaction((rows: BlueprintRevision[]) => {
      database.prepare('DELETE FROM blueprint_revisions').run();
      for (const entry of rows) {
        insert.run({
          id: entry.id,
          blueprintId: entry.blueprintId,
          projectId: entry.projectId,
          target: entry.target,
          stepId: entry.stepId ?? null,
          text: entry.text,
          attachmentNames: JSON.stringify(entry.attachmentNames ?? []),
          createdAt: entry.createdAt,
        });
      }
    })(entries);
  },
};
