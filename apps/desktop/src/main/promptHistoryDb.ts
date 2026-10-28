import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type {
  AddPromptHistoryInput,
  PromptHistoryEntry,
  PromptHistorySource,
} from '../shared/apiTypes';

// Unlike node-pty, better-sqlite3 is not N-API based, so its native binding is
// tied to the exact Electron ABI it runs under. See the `rebuild:native`
// script in package.json (run before `dev`/`package`) which rebuilds it for
// Electron via @electron/rebuild.
let db: Database.Database | null = null;

interface PromptHistoryRow {
  id: string;
  raw_input: string;
  prompt_type: string;
  target_ai: string;
  content: string;
  source: PromptHistorySource;
  tags: string;
  project_id: string | null;
  created_at: string;
}

function rowToEntry(row: PromptHistoryRow): PromptHistoryEntry {
  return {
    id: row.id,
    rawInput: row.raw_input,
    promptType: row.prompt_type,
    targetAI: row.target_ai,
    content: row.content,
    source: row.source,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    projectId: row.project_id ?? null,
    createdAt: row.created_at,
  };
}

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'prompt-history.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_history (
      id TEXT PRIMARY KEY,
      raw_input TEXT NOT NULL,
      prompt_type TEXT NOT NULL,
      target_ai TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_history_created_at ON prompt_history(created_at DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(prompt_history)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'tags')) {
    db.exec(`ALTER TABLE prompt_history ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
  }
  // Nullable on purpose: most entries come from Prompt Builder and belong to no
  // project, and rows written before this column existed can't be attributed.
  if (!columns.some((c) => c.name === 'project_id')) {
    db.exec(`ALTER TABLE prompt_history ADD COLUMN project_id TEXT`);
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_prompt_history_project_id ON prompt_history(project_id, created_at DESC)',
  );
  return db;
}

export const promptHistoryDb = {
  add(input: AddPromptHistoryInput): PromptHistoryEntry {
    const entry: PromptHistoryEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      tags: [],
      ...input,
      // Normalized after the spread: the input field is optional, the column isn't.
      projectId: input.projectId ?? null,
    };
    getDb()
      .prepare(
        `INSERT INTO prompt_history (id, raw_input, prompt_type, target_ai, content, source, project_id, created_at)
         VALUES (@id, @rawInput, @promptType, @targetAI, @content, @source, @projectId, @createdAt)`,
      )
      .run(entry);
    return entry;
  },

  list(projectId?: string | null, limit = 200): PromptHistoryEntry[] {
    const rows = projectId
      ? (getDb()
          .prepare(
            'SELECT * FROM prompt_history WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(projectId, limit) as PromptHistoryRow[])
      : (getDb()
          .prepare('SELECT * FROM prompt_history ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(limit) as PromptHistoryRow[]);
    return rows.map(rowToEntry);
  },

  search(query: string, projectId?: string | null, limit = 200): PromptHistoryEntry[] {
    const like = `%${query}%`;
    const matches =
      '(raw_input LIKE @like OR content LIKE @like OR prompt_type LIKE @like OR target_ai LIKE @like)';
    const rows = getDb()
      .prepare(
        `SELECT * FROM prompt_history
         WHERE ${matches}${projectId ? ' AND project_id = @projectId' : ''}
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ like, limit, ...(projectId ? { projectId } : {}) }) as PromptHistoryRow[];
    return rows.map(rowToEntry);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM prompt_history WHERE id = ?').run(id);
  },

  /** Re-files one entry under another project, or under none when `projectId` is null. */
  setProject(id: string, projectId: string | null): void {
    getDb()
      .prepare('UPDATE prompt_history SET project_id = @projectId WHERE id = @id')
      .run({ id, projectId });
  },

  setTags(id: string, tags: string[]): void {
    getDb()
      .prepare('UPDATE prompt_history SET tags = @tags WHERE id = @id')
      .run({ id, tags: JSON.stringify(tags) });
  },

  /** Full table, unlike `list()` which caps at 200. Used for backup export. */
  exportAll(): PromptHistoryEntry[] {
    const rows = getDb()
      .prepare('SELECT * FROM prompt_history ORDER BY created_at DESC, rowid DESC')
      .all() as PromptHistoryRow[];
    return rows.map(rowToEntry);
  },

  /** Replaces the entire table with `entries`. Used for backup restore. */
  importAll(entries: PromptHistoryEntry[]): void {
    const database = getDb();
    const insert = database.prepare(
      `INSERT INTO prompt_history (id, raw_input, prompt_type, target_ai, content, source, tags, project_id, created_at)
       VALUES (@id, @rawInput, @promptType, @targetAI, @content, @source, @tags, @projectId, @createdAt)`,
    );
    database.transaction((rows: PromptHistoryEntry[]) => {
      database.prepare('DELETE FROM prompt_history').run();
      for (const entry of rows) {
        insert.run({
          id: entry.id,
          rawInput: entry.rawInput,
          promptType: entry.promptType,
          targetAI: entry.targetAI,
          content: entry.content,
          source: entry.source,
          tags: JSON.stringify(entry.tags ?? []),
          projectId: entry.projectId ?? null,
          createdAt: entry.createdAt,
        });
      }
    })(entries);
  },
};
