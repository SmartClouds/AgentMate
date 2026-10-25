/**
 * The slice of a SQLite binding Studio uses. The desktop app hands in better-sqlite3 (rebuilt for
 * Electron, so this package cannot import it); tests use Node's own `node:sqlite`. Parameters are
 * positional only, which both bindings take the same way.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface SqlDriver {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  pragma(statement: string): SqlRow[];
  /** Runs `work` inside one transaction, committing on return and rolling back on a throw. */
  transaction<T>(work: () => T): T;
  close(): void;
}

export type OpenSqlDriver = (file: string) => SqlDriver;
