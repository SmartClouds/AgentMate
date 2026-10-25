import { describe, expect, it, vi } from 'vitest';
import { readOpencodeProject } from './projectOpencode';
import type { HistoryFs } from './sessionHistory';

/**
 * OpenCode keeps its conversations in a database that is read synchronously, so the project
 * report reads all of a project's in one query instead of going through the history listing,
 * which asks twice per conversation for prompts the report never shows.
 */

const DB = '/home/me/.local/share/opencode/opencode.db';
const HEADER = 'SQLite format 3\0';

type Query = NonNullable<HistoryFs['queryDb']>;

function fakeFs(options: { rows?: Record<string, unknown>[]; query?: Query; hasDb?: boolean }) {
  const queryDb = vi.fn<Query>(options.query ?? (async () => options.rows ?? []));
  const fs: HistoryFs = {
    scope: 'test',
    caseInsensitive: false,
    join: (...parts) => parts.join('/'),
    home: async () => '/home/me',
    env: async () => undefined,
    list: async () => [],
    readRange: async (path) => {
      if (options.hasDb !== false && path === DB) return HEADER;
      throw new Error('missing');
    },
    queryDb,
  };
  return { fs, queryDb };
}

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ses_a',
  directory: '/work/app',
  title: 'Fix the build',
  model: '{"id":"claude-opus-5-5","providerID":"anthropic"}',
  cost: 0,
  time_updated: new Date(2026, 8, 17, 12).getTime(),
  tokens_input: 1000,
  tokens_output: 200,
  tokens_reasoning: 50,
  tokens_cache_read: 3000,
  tokens_cache_write: 7,
  ...overrides,
});

describe('readOpencodeProject', () => {
  it('reads every session in one query, from the period on', async () => {
    const { fs, queryDb } = fakeFs({ rows: [row()] });

    await readOpencodeProject(fs, ['/work/app'], 12345);

    // One look at the schema, then every session at once rather than one query per session.
    expect(queryDb).toHaveBeenCalledTimes(2);
    expect(queryDb.mock.calls[0][1]).toContain('sqlite_master');
    expect(queryDb.mock.calls[1][0]).toBe(DB);
    expect(queryDb.mock.calls[1][1]).toContain('FROM session WHERE');
    expect(queryDb.mock.calls[1][2]).toEqual([12345]);
  });

  it('reads the sessions from session_v2 on a database that has it', async () => {
    const { fs, queryDb } = fakeFs({
      query: async (_dbPath, sql) =>
        sql.includes('sqlite_master')
          ? [{ name: 'session_v2' }, { name: 'session_message' }]
          : [row()],
    });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(queryDb.mock.calls[1][1]).toContain('FROM session_v2 WHERE');
    expect(read.conversations.map((c) => c.id)).toEqual(['ses_a']);
  });

  it('stays on the old session table when only half of the new layout is there', async () => {
    const { fs, queryDb } = fakeFs({
      query: async (_dbPath, sql) =>
        sql.includes('sqlite_master') ? [{ name: 'session_v2' }] : [row()],
    });

    await readOpencodeProject(fs, ['/work/app'], 0);

    expect(queryDb.mock.calls[1][1]).toContain('FROM session WHERE');
  });

  it('keeps the sessions of the project folder and of its worktrees, and no others', async () => {
    const { fs } = fakeFs({
      rows: [
        row({ id: 'main', directory: '/work/app' }),
        row({ id: 'tree', directory: '/work/app.worktrees/feat' }),
        row({ id: 'elsewhere', directory: '/work/other' }),
        row({ id: 'nowhere', directory: null }),
      ],
    });

    const read = await readOpencodeProject(fs, ['/work/app', '/work/app.worktrees/feat'], 0);

    expect(read.conversations.map((c) => c.id).sort()).toEqual(['main', 'tree']);
  });

  it('names each conversation and dates its usage by its last update', async () => {
    const { fs } = fakeFs({ rows: [row()] });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    const updatedAt = new Date(2026, 8, 17, 12).getTime();
    expect(read.conversations).toEqual([
      { provider: 'opencode', id: 'ses_a', title: 'Fix the build', updatedAt },
    ]);
    expect(read.rows[0]).toMatchObject({
      key: expect.stringContaining('ses_a'),
      day: '2026-09-17',
      model: 'claude-opus-5-5',
    });
  });

  it('counts a sub-session as a conversation of its own, on top of its parent', async () => {
    // A parent's row holds only its own tokens, and a subtask it started has a row of its own
    // (checked against a real database), so adding every row counts each token once.
    const { fs } = fakeFs({
      rows: [
        row({ id: 'parent', tokens_input: 1000, tokens_output: 0, tokens_reasoning: 0 }),
        row({
          id: 'child',
          parent_id: 'parent',
          tokens_input: 400,
          tokens_output: 0,
          tokens_reasoning: 0,
        }),
      ],
    });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read.conversations.map((c) => c.id).sort()).toEqual(['child', 'parent']);
    expect(read.rows.reduce((sum, r) => sum + r.input, 0)).toBe(1400);
  });

  it('counts reasoning as output, the way the agent is billed', async () => {
    const { fs } = fakeFs({ rows: [row()] });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read.rows[0]).toMatchObject({
      input: 1000,
      output: 250,
      cacheRead: 3000,
      cacheWrite: 7,
    });
  });

  it('takes the cost OpenCode recorded, and none when it recorded zero', async () => {
    const { fs } = fakeFs({
      rows: [row({ id: 'paid', cost: 1.5 }), row({ id: 'free', cost: 0 })],
    });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    const byId = (id: string) => read.rows.find((r) => r.key.endsWith(id));
    expect(byId('paid')?.recordedCostUsd).toBe(1.5);
    expect(byId('free')?.recordedCostUsd).toBeNull();
  });

  it('has no model when the row does not name one, and an empty title as none', async () => {
    const { fs } = fakeFs({ rows: [row({ model: null, title: '' })] });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read.rows[0].model).toBeNull();
    expect(read.conversations[0].title).toBeNull();
  });

  it('ignores values that are not counts', async () => {
    const { fs } = fakeFs({
      rows: [row({ tokens_input: 'lots', tokens_output: -5, tokens_cache_read: null })],
    });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read.rows[0]).toMatchObject({ input: 0, output: 50, cacheRead: 0 });
  });

  it('finds nothing, and asks nothing, on a machine without OpenCode', async () => {
    const { fs, queryDb } = fakeFs({ hasDb: false });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read).toEqual({ conversations: [], rows: [], unreadable: 0 });
    expect(queryDb).not.toHaveBeenCalled();
  });

  it('finds nothing on a target that cannot run SQL', async () => {
    const { fs } = fakeFs({ rows: [row()] });
    const remote: HistoryFs = { ...fs, queryDb: undefined };

    expect(await readOpencodeProject(remote, ['/work/app'], 0)).toEqual({
      conversations: [],
      rows: [],
      unreadable: 0,
    });
  });

  it('reports a database it could not read, without failing the rest of the report', async () => {
    const { fs } = fakeFs({
      query: async () => {
        throw new Error('database is locked');
      },
    });

    const read = await readOpencodeProject(fs, ['/work/app'], 0);

    expect(read).toEqual({ conversations: [], rows: [], unreadable: 1 });
  });
});
