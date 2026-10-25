import type { OpenSqlDriver, SqlRow, SqlValue } from '@agentmat/studio/node';
import Database from 'better-sqlite3';

/** Studio's SQLite port over the app's better-sqlite3 build. */
export const openBetterSqlite: OpenSqlDriver = (file) => {
  const db = new Database(file);
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => {
          const result = statement.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get: (...params: SqlValue[]) => statement.get(...params) as SqlRow | undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as SqlRow[],
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    pragma: (statement) => db.pragma(statement) as SqlRow[],
    transaction: (work) => db.transaction(work)(),
    close: () => db.close(),
  };
};
