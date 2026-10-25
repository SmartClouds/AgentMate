// OpenCode keeps its conversations in one SQLite database. From 2.x on it writes them to
// `session_v2` (with their messages in `session_message`, one typed row each) and no longer
// touches the `session`, `message` and `part` tables, which stay behind holding only what was
// migrated. An install from before that has just the old tables. Reading the old ones on a new
// database gives a history that stops the day OpenCode upgraded.
//
// Which layout a database has is read from its schema. A query that names a missing table
// throws, and `queryDb` answers a throw by copying the whole database to try again, which is far
// too heavy to use as a probe.

export type OpencodeSessionTable = 'session_v2' | 'session';

type OpencodeQuery = (sql: string) => Promise<Record<string, unknown>[]>;

const LAYOUT_SQL = `SELECT name FROM sqlite_master WHERE type = 'table'
  AND name IN ('session_v2', 'session_message')`;

/** The table holding OpenCode's sessions: `session_v2` on 2.x, `session` before that. */
export async function opencodeSessionTable(query: OpencodeQuery): Promise<OpencodeSessionTable> {
  const names = new Set((await query(LAYOUT_SQL)).map((row) => row.name));
  return names.has('session_v2') && names.has('session_message') ? 'session_v2' : 'session';
}

/**
 * The first or last thing the user typed in a session. Either layout returns one row whose `data`
 * is JSON with the text in `text`: a user message on 2.x, a text part of a user message before.
 * Plan mode reminders and the like are `synthetic` rows on 2.x, so they never pass for a prompt.
 */
export function opencodePromptSql(table: OpencodeSessionTable, which: 'first' | 'last'): string {
  const order = which === 'first' ? 'ASC' : 'DESC';
  if (table === 'session_v2') {
    return `SELECT data FROM session_message WHERE session_id = ? AND type = 'user'
  ORDER BY seq ${order} LIMIT 1`;
  }
  return `SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id
  WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created ${order} LIMIT 1`;
}
