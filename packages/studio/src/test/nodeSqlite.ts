import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { OpenSqlDriver, SqlDriver, SqlRow, SqlValue } from '../node/db/sqlDriver.js';

/** The `SqlDriver` port over Node's own sqlite, for the package's tests. */
export const openNodeSqlite: OpenSqlDriver = (file: string): SqlDriver => {
  const db = new DatabaseSync(file);
  const bind = (params: SqlValue[]) => params as SQLInputValue[];
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params) => {
          const result = statement.run(...bind(params));
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        get: (...params) => statement.get(...bind(params)) as SqlRow | undefined,
        all: (...params) => statement.all(...bind(params)) as SqlRow[],
      };
    },
    exec: (sql) => db.exec(sql),
    pragma: (statement) => db.prepare(`PRAGMA ${statement}`).all() as SqlRow[],
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
};
