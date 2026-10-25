import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { EditOp } from '../../document/ops.js';
import { parseDocument, type StudioDocument } from '../../document/schema.js';
import type { TxRef } from '../../document/undo.js';
import type { OpenSqlDriver, SqlDriver, SqlRow } from './sqlDriver.js';

/**
 * `studio.db`, the history of one video and the source of truth for it. Every change is one
 * entry (a transaction of edit ops with their inverse), and a full snapshot of the document is
 * stored every so often so any version can be rebuilt quickly. Nothing here is ever changed or
 * removed: triggers refuse UPDATE and DELETE on the history tables, so even a bug, or a hand
 * edit, cannot prune it.
 */

export type TxKind = TxRef['kind'];
export type TxActor = 'user' | 'ai' | 'system';

export interface TxRecord {
  seq: number;
  at: number;
  kind: TxKind;
  of: number | null;
  actor: TxActor;
  label: string;
  /** The AI generation that produced this change, when one did. */
  generationId: string | null;
  ops: EditOp[];
  inverse: EditOp[];
}

export type NewTx = Omit<TxRecord, 'seq'>;
export type HistoryEntry = Omit<TxRecord, 'ops' | 'inverse'> & { opCount: number };

export interface Revision {
  id: number;
  seq: number;
  at: number;
  label: string;
  kind: 'milestone' | 'render' | 'restore';
}

const APPEND_ONLY = ['txs', 'snapshots', 'revisions'];

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS txs (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'undo', 'redo', 'mark')),
  of_seq INTEGER,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'ai', 'system')),
  label TEXT NOT NULL,
  generation_id TEXT,
  ops TEXT NOT NULL,
  inverse TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  document BLOB NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL
);
${APPEND_ONLY.map(
  (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT, 'Studio history is append-only.'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, 'Studio history is append-only.'); END;`,
).join('')}
`;

export interface HistoryDbOptions {
  /** WAL needs shared memory that network drives do not give, so they use a rollback journal. */
  network?: boolean;
  busyTimeoutMs?: number;
}

function toTx(row: SqlRow): TxRecord {
  return {
    seq: Number(row.seq),
    at: Number(row.at),
    kind: row.kind as TxKind,
    of: row.of_seq === null ? null : Number(row.of_seq),
    actor: row.actor as TxActor,
    label: String(row.label),
    generationId: row.generation_id === null ? null : String(row.generation_id),
    ops: JSON.parse(String(row.ops)) as EditOp[],
    inverse: JSON.parse(String(row.inverse)) as EditOp[],
  };
}

export class HistoryDb {
  private constructor(private readonly db: SqlDriver) {}

  static open(openDb: OpenSqlDriver, file: string, options: HistoryDbOptions = {}): HistoryDb {
    const db = openDb(file);
    try {
      db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 2000}`);
      // One writer, held for as long as the video is open: the hard backstop behind the lock file.
      db.pragma('locking_mode = EXCLUSIVE');
      db.pragma(`journal_mode = ${options.network ? 'DELETE' : 'WAL'}`);
      // An acknowledged edit must survive a power cut, not just a crash.
      db.pragma('synchronous = FULL');
      db.exec(DDL);
    } catch (error) {
      db.close();
      throw error;
    }
    return new HistoryDb(db);
  }

  head(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM txs').get();
    return row?.seq == null ? 0 : Number(row.seq);
  }

  /** Writes one entry, and the document as it stands after it when `snapshot` is given. */
  append(tx: NewTx, snapshot?: StudioDocument): number {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO txs (at, kind, of_seq, actor, label, generation_id, ops, inverse)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tx.at,
          tx.kind,
          tx.of,
          tx.actor,
          tx.label,
          tx.generationId,
          JSON.stringify(tx.ops),
          JSON.stringify(tx.inverse),
        );
      const seq = Number(result.lastInsertRowid);
      if (snapshot) {
        const json = JSON.stringify(snapshot);
        this.db
          .prepare('INSERT INTO snapshots (seq, at, document, hash) VALUES (?, ?, ?, ?)')
          .run(
            seq,
            tx.at,
            deflateRawSync(Buffer.from(json, 'utf8')),
            createHash('sha256').update(json).digest('hex'),
          );
      }
      return seq;
    });
  }

  tx(seq: number): TxRecord | undefined {
    const row = this.db.prepare('SELECT * FROM txs WHERE seq = ?').get(seq);
    return row ? toTx(row) : undefined;
  }

  /** Entries with `from < seq <= to`, oldest first. */
  txsBetween(from: number, to: number): TxRecord[] {
    return this.db
      .prepare('SELECT * FROM txs WHERE seq > ? AND seq <= ? ORDER BY seq')
      .all(from, to)
      .map(toTx);
  }

  refs(): TxRef[] {
    return this.db
      .prepare('SELECT seq, kind, of_seq FROM txs ORDER BY seq')
      .all()
      .map((row) => ({
        seq: Number(row.seq),
        kind: row.kind as TxKind,
        of: row.of_seq === null ? null : Number(row.of_seq),
      }));
  }

  /** Newest first, without the op payloads, for the History panel. */
  entries(options: { before?: number; limit: number }): HistoryEntry[] {
    return this.db
      .prepare(
        `SELECT seq, at, kind, of_seq, actor, label, generation_id, json_array_length(ops) AS op_count
         FROM txs WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
      .map((row) => ({
        seq: Number(row.seq),
        at: Number(row.at),
        kind: row.kind as TxKind,
        of: row.of_seq === null ? null : Number(row.of_seq),
        actor: row.actor as TxActor,
        label: String(row.label),
        generationId: row.generation_id === null ? null : String(row.generation_id),
        opCount: Number(row.op_count),
      }));
  }

  snapshotAtOrBefore(seq: number): { seq: number; document: StudioDocument } | undefined {
    const row = this.db
      .prepare('SELECT seq, document FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1')
      .get(seq);
    if (!row) return undefined;
    const json = inflateRawSync(row.document as Uint8Array).toString('utf8');
    return { seq: Number(row.seq), document: parseDocument(JSON.parse(json)) };
  }

  lastSnapshotSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM snapshots').get();
    return row?.seq == null ? 0 : Number(row.seq);
  }

  addRevision(revision: Omit<Revision, 'id'>): void {
    this.db
      .prepare('INSERT INTO revisions (seq, at, label, kind) VALUES (?, ?, ?, ?)')
      .run(revision.seq, revision.at, revision.label, revision.kind);
  }

  revisions(): Revision[] {
    return this.db
      .prepare('SELECT id, seq, at, label, kind FROM revisions ORDER BY id')
      .all()
      .map((row) => ({
        id: Number(row.id),
        seq: Number(row.seq),
        at: Number(row.at),
        label: String(row.label),
        kind: row.kind as Revision['kind'],
      }));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  quickCheck(): boolean {
    const rows = this.db.pragma('quick_check');
    return rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok';
  }

  /** For tests that prove the triggers hold. Never used by the app. */
  unsafeExec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
