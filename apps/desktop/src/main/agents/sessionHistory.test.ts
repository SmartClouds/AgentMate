import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistorySources, historySource } from './historySources';
import {
  clearHistoryCaches,
  collectHistory,
  type HistoryDirEntry,
  type HistoryFs,
  localHistoryFs,
} from './sessionHistory';

// collectHistory runs against an in-memory file tree, so the same checks cover the local reader
// and the remote one that plugs in later.

interface FakeFile {
  content: string;
  mtimeMs: number;
}

interface FakeOptions {
  home?: string;
  env?: Record<string, string>;
  caseInsensitive?: boolean;
  scope?: string;
  /**
   * In-memory OpenCode store: sessions plus first/last user prompt per session id. A query that
   * names the other layout's tables throws, the way SQLite does for a table that is not there.
   */
  opencode?: {
    sessions: Record<string, unknown>[];
    prompts?: Record<string, { first: string | null; last: string | null }>;
    /** `session_v2` and `session_message` (OpenCode 2.x), else `session`, `message` and `part`. */
    layout?: 'v2';
  };
}

type FakeFs = HistoryFs & {
  files: Map<string, FakeFile>;
  reads: { path: string; start: number; length: number }[];
};

function fakeFs(files: Record<string, FakeFile>, options: FakeOptions = {}): FakeFs {
  const map = new Map(Object.entries(files));
  const reads: FakeFs['reads'] = [];
  const queryDb: HistoryFs['queryDb'] = options.opencode
    ? async (_dbPath, sql, params = []) => {
        const store = options.opencode;
        if (!store) return [];
        const v2 = store.layout === 'v2';
        if (sql.includes('sqlite_master')) {
          return v2 ? [{ name: 'session_v2' }, { name: 'session_message' }] : [];
        }
        if (sql.includes('ORDER BY time_updated')) {
          if (!sql.includes(v2 ? 'FROM session_v2 ' : 'FROM session ')) {
            throw new Error('no such table');
          }
          return [...store.sessions];
        }
        if (!sql.includes(v2 ? 'FROM session_message ' : 'FROM part ')) {
          throw new Error('no such table');
        }
        const prompts = (store.prompts ?? {})[params[0] as string];
        if (!prompts) return [];
        const text = sql.includes('DESC') ? prompts.last : prompts.first;
        if (text == null) return [];
        // A user message on 2.x holds its text at the top; before that it was a text part.
        const data = v2
          ? { time: { created: 1 }, text, files: [], agents: [] }
          : { type: 'text', text };
        return [{ data: JSON.stringify(data) }];
      }
    : undefined;
  return {
    files: map,
    reads,
    scope: options.scope ?? 'fake',
    caseInsensitive: options.caseInsensitive ?? false,
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    home: async () => options.home ?? '/home/me',
    env: async (name) => options.env?.[name],
    list: async (dir) => {
      const prefix = `${dir.replace(/\/+$/, '')}/`;
      const entries = new Map<string, HistoryDirEntry>();
      for (const [path, file] of map) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split('/');
        if (rest.length > 0) {
          entries.set(name, { name, isDirectory: true, isFile: false, size: 0, mtimeMs: 0 });
        } else {
          const size = Buffer.byteLength(file.content);
          entries.set(name, {
            name,
            isDirectory: false,
            isFile: true,
            size,
            mtimeMs: file.mtimeMs,
          });
        }
      }
      if (entries.size === 0) throw new Error(`ENOENT: ${dir}`);
      return [...entries.values()];
    },
    readRange: async (path, start, length) => {
      reads.push({ path, start, length });
      const file = map.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(file.content)
        .subarray(start, start + length)
        .toString('utf-8');
    },
    queryDb,
  };
}

const jsonl = (...records: unknown[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function claudeTranscript(cwd: string, prompt: string): string {
  return jsonl({
    type: 'user',
    cwd,
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'user', content: prompt },
  });
}

function codexRollout(id: string, cwd: string, prompt: string, extraMeta = ''): string {
  return jsonl(
    {
      type: 'session_meta',
      payload: { id, cwd, timestamp: '2026-09-01T10:00:00.000Z', instructions: extraMeta },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  );
}

const freebuffMessages = (...contents: [variant: string, content: string][]) =>
  JSON.stringify(
    contents.map(([variant, content], i) => ({
      id: `m${i + 1}`,
      variant,
      content,
      timestamp: `2026-10-12T07:3${i}:00.000Z`,
    })),
  );

/** A chat dir pair whose sidecar matches the transcript, so the preview path is covered. */
function freebuffChat(
  dir: string,
  chatId: string,
  firstPrompt: string,
  mtimeMs: number,
  extra: [variant: string, content: string][] = [],
): Record<string, FakeFile> {
  const messages = freebuffMessages(['user', firstPrompt], ...extra);
  return {
    [`${dir}/chats/${chatId}/chat-messages.json`]: { content: messages, mtimeMs },
    [`${dir}/chats/${chatId}/chat-meta.json`]: {
      content: JSON.stringify({
        messageCount: 1 + extra.length,
        firstPrompt,
        messagesSize: Buffer.byteLength(messages),
        messagesMtimeMs: mtimeMs,
      }),
      mtimeMs,
    },
  };
}

const claudeDir = '/home/me/.claude/projects';
const codexDir = '/home/me/.codex/sessions/2026/09/01';

const readPaths = (fs: FakeFs): string[] => [...new Set(fs.reads.map((r) => r.path))].sort();

beforeEach(() => {
  clearHistoryCaches();
});

describe('collectHistory for one folder', () => {
  it('returns only the folder sessions from Claude Code and Codex', async () => {
    const fs = fakeFs({
      [`${claudeDir}/-work-app/a.jsonl`]: {
        content: claudeTranscript('/work/app', 'Fix it'),
        mtimeMs: 10,
      },
      // Same encoded name, different real folder.
      [`${claudeDir}/-work-app/b.jsonl`]: {
        content: claudeTranscript('/work-app', 'Other'),
        mtimeMs: 20,
      },
      [`${claudeDir}/-work-other/c.jsonl`]: {
        content: claudeTranscript('/work/other', 'No'),
        mtimeMs: 30,
      },
      [`${codexDir}/rollout-1.jsonl`]: {
        content: codexRollout('x1', '/work/app', 'Codex yes'),
        mtimeMs: 40,
      },
      [`${codexDir}/rollout-2.jsonl`]: {
        content: codexRollout('x2', '/work/other', 'Codex no'),
        mtimeMs: 50,
      },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => [s.provider, s.id, s.firstPrompt])).toEqual([
      ['codex', 'x1', 'Codex yes'],
      ['claude-code', 'a', 'Fix it'],
    ]);
    expect(sessions[0]).toMatchObject({ cwd: '/work/app', updatedAt: 40 });
  });

  it('matches folder names case sensitively unless the target ignores case', async () => {
    const files = {
      [`${claudeDir}/-work-app/a.jsonl`]: {
        content: claudeTranscript('/work/app', 'Hi'),
        mtimeMs: 1,
      },
    };
    expect(await collectHistory(fakeFs(files), { folder: '/Work/App' })).toEqual([]);
    clearHistoryCaches();
    const loose = await collectHistory(fakeFs(files, { caseInsensitive: true }), {
      folder: '/Work/App',
    });
    expect(loose.map((s) => s.id)).toEqual(['a']);
  });
});

describe('collectHistory for a whole machine', () => {
  it('returns sessions from every folder with their cwd', async () => {
    const fs = fakeFs({
      [`${claudeDir}/-work-app/a.jsonl`]: {
        content: claudeTranscript('/work/app', 'One'),
        mtimeMs: 10,
      },
      [`${claudeDir}/-srv-api/b.jsonl`]: {
        content: claudeTranscript('/srv/api', 'Two'),
        mtimeMs: 20,
      },
      [`${codexDir}/rollout-1.jsonl`]: {
        content: codexRollout('x1', '/opt/tool', 'Three'),
        mtimeMs: 30,
      },
    });
    const sessions = await collectHistory(fs);
    expect(sessions.map((s) => [s.provider, s.id, s.cwd])).toEqual([
      ['codex', 'x1', '/opt/tool'],
      ['claude-code', 'b', '/srv/api'],
      ['claude-code', 'a', '/work/app'],
    ]);
  });

  it('reads only the newest files that fit the limit', async () => {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < 10; i++) {
      files[`${claudeDir}/-work-app/s${i}.jsonl`] = {
        content: claudeTranscript('/work/app', `Prompt ${i}`),
        mtimeMs: 100 + i,
      };
    }
    const fs = fakeFs(files);
    const sessions = await collectHistory(fs, { limit: 3 });
    expect(sessions.map((s) => s.id)).toEqual(['s9', 's8', 's7']);
    expect(readPaths(fs)).toEqual([
      `${claudeDir}/-work-app/s7.jsonl`,
      `${claudeDir}/-work-app/s8.jsonl`,
      `${claudeDir}/-work-app/s9.jsonl`,
    ]);
  });

  it('caps Codex rollouts before reading their first line', async () => {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < 5; i++) {
      files[`${codexDir}/rollout-${i}.jsonl`] = {
        content: codexRollout(`x${i}`, `/p/${i}`, `Prompt ${i}`),
        mtimeMs: 100 + i,
      };
    }
    const fs = fakeFs(files);
    const sessions = await collectHistory(fs, { limit: 2 });
    expect(sessions.map((s) => s.id)).toEqual(['x4', 'x3']);
    expect(readPaths(fs).filter((p) => p.includes('rollout-'))).toEqual([
      `${codexDir}/rollout-3.jsonl`,
      `${codexDir}/rollout-4.jsonl`,
    ]);
  });
});

describe('collectHistory caching', () => {
  it('reuses summaries until the file changes', async () => {
    const path = `${claudeDir}/-work-app/a.jsonl`;
    const fs = fakeFs({ [path]: { content: claudeTranscript('/work/app', 'First'), mtimeMs: 1 } });
    await collectHistory(fs, { folder: '/work/app' });
    expect(fs.reads.length).toBeGreaterThan(0);

    fs.reads.length = 0;
    const again = await collectHistory(fs, { folder: '/work/app' });
    expect(again.map((s) => s.firstPrompt)).toEqual(['First']);
    expect(fs.reads).toEqual([]);

    fs.files.set(path, { content: claudeTranscript('/work/app', 'Second'), mtimeMs: 2 });
    const changed = await collectHistory(fs, { folder: '/work/app' });
    expect(changed.map((s) => s.firstPrompt)).toEqual(['Second']);
    expect(readPaths(fs)).toEqual([path]);
  });

  it('keeps caches apart per scope', async () => {
    const path = `${claudeDir}/-work-app/a.jsonl`;
    const files = { [path]: { content: claudeTranscript('/work/app', 'Hi'), mtimeMs: 1 } };
    await collectHistory(fakeFs(files, { scope: 'one' }));
    const other = fakeFs(files, { scope: 'two' });
    await collectHistory(other);
    expect(readPaths(other)).toEqual([path]);
  });
});

describe('collectHistory locations', () => {
  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const fs = fakeFs(
      {
        '/cfg/claude/projects/-work-app/a.jsonl': {
          content: claudeTranscript('/work/app', 'Claude'),
          mtimeMs: 1,
        },
        '/cfg/codex/sessions/2026/09/01/rollout-1.jsonl': {
          content: codexRollout('x1', '/work/app', 'Codex'),
          mtimeMs: 2,
        },
      },
      { env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' } },
    );
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => s.id)).toEqual(['x1', 'a']);
  });

  it('also reads the XDG Claude folder', async () => {
    const fs = fakeFs({
      '/home/me/.config/claude/projects/-work-app/a.jsonl': {
        content: claudeTranscript('/work/app', 'Claude'),
        mtimeMs: 1,
      },
    });
    expect((await collectHistory(fs)).map((s) => s.id)).toEqual(['a']);
  });

  it('returns nothing when no folder exists', async () => {
    const fs = fakeFs({});
    await expect(collectHistory(fs, { folder: '/work/app' })).resolves.toEqual([]);
    await expect(collectHistory(fs)).resolves.toEqual([]);
  });
});

describe('collectHistory for Codex', () => {
  it('parses a first line longer than the head chunk', async () => {
    const long = 'é'.repeat(100 * 1024);
    const fs = fakeFs({
      [`${codexDir}/rollout-1.jsonl`]: {
        content: codexRollout('x1', '/work/app', 'Long meta', long),
        mtimeMs: 1,
      },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app', headBytes: 1024 });
    expect(sessions.map((s) => [s.id, s.firstPrompt])).toEqual([['x1', 'Long meta']]);

    clearHistoryCaches();
    const anywhere = await collectHistory(fs, { headBytes: 1024 });
    expect(anywhere.map((s) => [s.id, s.cwd])).toEqual([['x1', '/work/app']]);
  });

  it('titles sessions with the Codex thread name', async () => {
    const fs = fakeFs({
      [`${codexDir}/rollout-1.jsonl`]: {
        content: codexRollout('x1', '/work/app', 'Hi'),
        mtimeMs: 1,
      },
      [`${codexDir}/rollout-2.jsonl`]: {
        content: codexRollout('x2', '/work/app', 'Yo'),
        mtimeMs: 2,
      },
      '/home/me/.codex/session_index.jsonl': {
        content: jsonl(
          { id: 'x1', thread_name: 'Fix the login' },
          { id: 'zz', thread_name: 'Gone' },
        ),
        mtimeMs: 1,
      },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => [s.id, s.title])).toEqual([
      ['x2', null],
      ['x1', 'Fix the login'],
    ]);
  });

  it('skips the thread index when no Codex session is kept', async () => {
    const fs = fakeFs({
      [`${claudeDir}/-work-app/a.jsonl`]: {
        content: claudeTranscript('/work/app', 'Hi'),
        mtimeMs: 1,
      },
      '/home/me/.codex/session_index.jsonl': {
        content: jsonl({ id: 'x1', thread_name: 'Name' }),
        mtimeMs: 1,
      },
    });
    await collectHistory(fs, { folder: '/work/app' });
    expect(readPaths(fs)).toEqual([`${claudeDir}/-work-app/a.jsonl`]);
  });
});

describe('collectHistory for every CLI', () => {
  const geminiChat = (id: string) =>
    jsonl(
      { sessionId: id, startTime: '2026-10-07T04:30:07.225Z', kind: 'main' },
      {
        $set: {
          messages: [{ id: 'm1', type: 'user', content: [{ text: 'Gemini fix it' }] }],
        },
      },
    );

  const freebuffAppDir = '/home/me/.config/manicode/projects/app';

  function tree(): Record<string, FakeFile> {
    return {
      [`${claudeDir}/-work-app/a.jsonl`]: {
        content: claudeTranscript('/work/app', 'Claude here'),
        mtimeMs: 10,
      },
      [`${codexDir}/rollout-1.jsonl`]: {
        content: codexRollout('x1', '/work/app', 'Codex here'),
        mtimeMs: 20,
      },
      '/home/me/.openclaude/projects/-work-app/o.jsonl': {
        content: claudeTranscript('/work/app', 'OpenClaude here'),
        mtimeMs: 30,
      },
      '/home/me/.gemini/tmp/runova/.project_root': {
        content: '/work/app',
        mtimeMs: 1,
      },
      '/home/me/.gemini/tmp/runova/chats/session-2026-10-07T04-30-g1.jsonl': {
        content: geminiChat('g1'),
        mtimeMs: 40,
      },
      '/home/me/.qwen/tmp/runova/.project_root': {
        content: '/work/app',
        mtimeMs: 1,
      },
      '/home/me/.qwen/tmp/runova/chats/session-2026-10-07T04-30-q1.jsonl': {
        content: geminiChat('q1'),
        mtimeMs: 50,
      },
      '/home/me/.cursor/chats/ws1/c1/meta.json': {
        content: JSON.stringify({ cwd: '/work/app', title: 'Cursor work' }),
        mtimeMs: 60,
      },
      '/home/me/.cursor/chats/ws1/c1/prompt_history.json': {
        content: JSON.stringify(['Cursor fix it']),
        mtimeMs: 61,
      },
      '/home/me/.continue/sessions/n1.json': {
        content: JSON.stringify({
          sessionId: 'n1',
          title: 'Continue work',
          workspaceDirectory: 'file:///work/app',
          history: [
            { message: { role: 'user', content: [{ type: 'text', text: 'Continue fix it' }] } },
          ],
        }),
        mtimeMs: 70,
      },
      '/home/me/.grok/sessions/%2Fwork%2Fapp/gs1/chat_history.jsonl': {
        content: jsonl({
          type: 'user',
          content: [{ type: 'text', text: '<user_query>Grok fix it</user_query>' }],
        }),
        mtimeMs: 80,
      },
      '/home/me/.cline/data/sessions/111/claude.json': {
        content: JSON.stringify({
          session_id: 'cl1',
          cwd: '/work/app',
          prompt: 'Cline fix it',
          model: 'deepseek/deepseek-v4-flash',
          started_at: '2026-08-03T10:35:03.621Z',
        }),
        mtimeMs: 90,
      },
      // The header probe findOpencodeDb reads; the rows come from queryDb.
      '/home/me/.local/share/opencode/opencode.db': {
        content: 'SQLite format 3\0fake',
        mtimeMs: 1,
      },
      ...freebuffChat(freebuffAppDir, '2026-10-12T07-30-00-000Z', 'FreeBuff fix it', 120, [
        ['ai', 'On it'],
        ['user', 'FreeBuff follow-up'],
      ]),
    };
  }

  function opencodeStore() {
    return {
      sessions: [
        {
          id: 'ses_aaa',
          directory: '/work/app',
          title: 'OpenCode work',
          model: '{"id":"m1","providerID":"opencode"}',
          time_created: 90,
          time_updated: 100,
        },
        {
          id: 'ses_bbb',
          directory: '/elsewhere',
          title: 'Elsewhere work',
          model: '{"id":"m2","providerID":"opencode"}',
          time_created: 80,
          time_updated: 85,
        },
      ],
      prompts: {
        ses_aaa: { first: 'OpenCode fix it', last: 'OpenCode follow-up' },
        ses_bbb: { first: 'Not here', last: null },
      },
    };
  }

  const withOpencode = () => fakeFs(tree(), { opencode: opencodeStore() });

  it('lists sessions from every supported CLI in one folder', async () => {
    const sessions = await collectHistory(withOpencode(), { folder: '/work/app' });
    expect(sessions.map((s) => [s.provider, s.firstPrompt]).sort()).toEqual(
      [
        ['claude-code', 'Claude here'],
        ['cline-cli', 'Cline fix it'],
        ['codex', 'Codex here'],
        ['continue-cli', 'Continue fix it'],
        ['cursor-cli', 'Cursor fix it'],
        ['gemini-cli', 'Gemini fix it'],
        ['grok-cli', 'Grok fix it'],
        ['freebuff-cli', 'FreeBuff fix it'],
        ['openclaude', 'OpenClaude here'],
        ['opencode', 'OpenCode fix it'],
        ['qwen-cli', 'Gemini fix it'],
      ].sort(),
    );
    // Every session resolves to the requested folder (directly or via sidecar).
    for (const session of sessions) {
      expect(session.cwd === null || session.cwd === '/work/app').toBe(true);
    }
    const freebuff = sessions.find((s) => s.provider === 'freebuff-cli');
    expect(freebuff).toMatchObject({
      id: '2026-10-12T07-30-00-000Z',
      lastPrompt: 'FreeBuff follow-up',
      cwd: null,
    });
    const opencode = sessions.find((s) => s.provider === 'opencode');
    expect(opencode).toMatchObject({
      id: 'ses_aaa',
      title: 'OpenCode work',
      lastPrompt: 'OpenCode follow-up',
      model: 'm1',
    });
  });

  it('hides other folders without hiding sessions with no recorded folder', async () => {
    const files = tree();
    files['/home/me/.continue/sessions/other.json'] = {
      content: JSON.stringify({
        sessionId: 'other',
        title: 'Elsewhere',
        workspaceDirectory: 'file:///elsewhere',
        history: [{ message: { role: 'user', content: [{ type: 'text', text: 'Not here' }] } }],
      }),
      mtimeMs: 95,
    };
    const sessions = await collectHistory(fakeFs(files), { folder: '/work/app' });
    expect(sessions.some((s) => s.id === 'other')).toBe(false);
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('returns every folder when no folder is given', async () => {
    const sessions = await collectHistory(withOpencode());
    expect(
      sessions
        .filter((s) => s.provider === 'opencode')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['ses_aaa', 'ses_bbb']);
    expect([...new Set(sessions.map((s) => s.provider))].sort()).toEqual(
      [
        'claude-code',
        'cline-cli',
        'codex',
        'continue-cli',
        'cursor-cli',
        'freebuff-cli',
        'gemini-cli',
        'grok-cli',
        'openclaude',
        'opencode',
        'qwen-cli',
      ].sort(),
    );
  });

  it('resolves the provider for each stored session (no silent Claude-only fallback)', async () => {
    // Regression test for the reported bug: history must not collapse to claude-code.
    const sessions = await collectHistory(withOpencode(), { folder: '/work/app' });
    const providers = new Set(sessions.map((s) => s.provider));
    expect(providers.has('claude-code')).toBe(true);
    expect(providers.has('opencode')).toBe(true);
    expect(providers.has('freebuff-cli')).toBe(true);
    expect(providers.size).toBeGreaterThan(2);
  });

  it('reads only the agents it is asked for, and never queries the database of the others', async () => {
    const fs = withOpencode();
    const queryDb = vi.fn(fs.queryDb);
    fs.queryDb = queryDb;

    const sessions = await collectHistory(fs, {
      folder: '/work/app',
      providers: ['claude-code', 'codex'],
    });

    expect(sessions.map((s) => s.provider).sort()).toEqual(['claude-code', 'codex']);
    expect(queryDb).not.toHaveBeenCalled();
  });
});

describe('collectHistory for OpenCode', () => {
  const dbFile = (mtimeMs = 1): Record<string, FakeFile> => ({
    '/home/me/.local/share/opencode/opencode.db': { content: 'SQLite format 3\0fake', mtimeMs },
  });

  const store = (
    sessions: Record<string, unknown>[],
    prompts: Record<string, { first: string | null; last: string | null }> = {},
  ) => ({ sessions, prompts });

  it('reads sessions and prompts from the SQLite store', async () => {
    const fs = fakeFs(dbFile(), {
      opencode: store(
        [
          {
            id: 'ses_1',
            directory: '/work/app',
            title: 'Ship it',
            model: '{"id":"m1","providerID":"opencode"}',
            time_created: 10,
            time_updated: 20,
          },
        ],
        { ses_1: { first: 'First ask', last: 'Last ask' } },
      ),
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'opencode',
      id: 'ses_1',
      title: 'Ship it',
      firstPrompt: 'First ask',
      lastPrompt: 'Last ask',
      cwd: '/work/app',
      model: 'm1',
      startedAt: 10,
      updatedAt: 20,
    });
  });

  it('reads sessions and prompts from the 2.x tables', async () => {
    const fs = fakeFs(dbFile(), {
      opencode: {
        ...store(
          [
            {
              id: 'ses_titled',
              directory: '/work/app',
              title: 'Debugging the tracker',
              model: '{"id":"m1","providerID":"opencode"}',
              time_created: 10,
              time_updated: 20,
            },
            {
              id: 'ses_fresh',
              directory: '/work/app',
              title: null,
              model: '{"id":"m1","providerID":"opencode"}',
              time_created: 30,
              time_updated: 40,
            },
          ],
          {
            ses_titled: { first: 'First ask', last: 'Last ask' },
            ses_fresh: { first: 'Update the packages', last: null },
          },
        ),
        layout: 'v2',
      },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => [s.id, s.title, s.firstPrompt, s.lastPrompt])).toEqual([
      ['ses_fresh', null, 'Update the packages', null],
      ['ses_titled', 'Debugging the tracker', 'First ask', 'Last ask'],
    ]);
  });

  it('keeps folder filtering on the session directory', async () => {
    const fs = fakeFs(dbFile(), {
      opencode: store(
        [
          {
            id: 'here',
            directory: '/work/app',
            title: 'Here',
            model: null,
            time_created: 1,
            time_updated: 2,
          },
          {
            id: 'there',
            directory: '/elsewhere',
            title: 'There',
            model: null,
            time_created: 1,
            time_updated: 3,
          },
        ],
        {
          here: { first: 'Here ask', last: null },
          there: { first: 'There ask', last: null },
        },
      ),
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => s.id)).toEqual(['here']);
  });

  it('skips OpenCode without a database or without SQL support', async () => {
    // No db file at all.
    await expect(collectHistory(fakeFs({}, { opencode: store([]) }))).resolves.toEqual([]);
    // A remote target has no queryDb, so its OpenCode sessions stay hidden.
    const remote = fakeFs(dbFile());
    expect(remote.queryDb).toBeUndefined();
    await expect(collectHistory(remote, { folder: '/work/app' })).resolves.toEqual([]);
  });

  it('skips sessions with neither a prompt nor a real title', async () => {
    const fs = fakeFs(dbFile(), {
      opencode: store(
        [
          {
            id: 'empty',
            directory: '/work/app',
            title: 'New session - 2026-10-11T00:14:02.527Z',
            model: null,
            time_created: 1,
            time_updated: 2,
          },
        ],
        {},
      ),
    });
    await expect(collectHistory(fs, { folder: '/work/app' })).resolves.toEqual([]);
  });

  it('reads a real SQLite store through localHistoryFs', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(join(tmpdir(), 'opencode-'));
    try {
      const storeDir = join(dir, '.local', 'share', 'opencode');
      await mkdir(storeDir, { recursive: true });
      const dbPath = join(storeDir, 'opencode.db');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)',
        );
        db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
        db.exec(
          'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)',
        );
        db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
          'ses_real',
          'E:/App',
          'Real session',
          '{"id":"m-real","providerID":"opencode"}',
          100,
          200,
        );
        db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
          'msg_1',
          'ses_real',
          JSON.stringify({ role: 'user' }),
        );
        const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
        insertPart.run(
          'prt_1',
          'msg_1',
          'ses_real',
          101,
          JSON.stringify({ type: 'text', text: 'Real first prompt' }),
        );
        insertPart.run(
          'prt_2',
          'msg_1',
          'ses_real',
          102,
          JSON.stringify({ type: 'text', text: 'Real last prompt' }),
        );
      } finally {
        db.close();
      }
      const fs: HistoryFs = { ...localHistoryFs, scope: 'opencode-real', home: async () => dir };
      const sessions = await collectHistory(fs, { folder: 'E:/App' });
      expect(sessions.map((s) => [s.provider, s.id, s.firstPrompt, s.lastPrompt])).toEqual([
        ['opencode', 'ses_real', 'Real first prompt', 'Real last prompt'],
      ]);
      expect(sessions[0]).toMatchObject({ cwd: 'E:/App', model: 'm-real' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a real 2.x SQLite store and leaves the old tables it migrated from alone', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(join(tmpdir(), 'opencode-'));
    try {
      const storeDir = join(dir, '.local', 'share', 'opencode');
      await mkdir(storeDir, { recursive: true });
      const db = new DatabaseSync(join(storeDir, 'opencode.db'));
      try {
        const sessionColumns =
          '(id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)';
        db.exec(`CREATE TABLE session ${sessionColumns}`);
        db.exec(`CREATE TABLE session_v2 ${sessionColumns}`);
        db.exec(
          'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)',
        );
        // OpenCode stopped writing the old table when it upgraded, so this one is stale.
        db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
          'ses_old',
          'E:/App',
          'Old session',
          null,
          1,
          2,
        );
        // A session OpenCode has not titled yet has a NULL title.
        db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
          'ses_new',
          'E:/App',
          null,
          '{"id":"m-new","providerID":"opencode"}',
          100,
          200,
        );
        const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
        const message = (id: string, type: string, seq: number, data: unknown) =>
          insert.run(id, 'ses_new', type, seq, JSON.stringify(data));
        // Plan mode reminders are their own type, so they are never taken for a prompt.
        message('m1', 'synthetic', 5, {
          text: '<system-reminder>You are in Plan mode</system-reminder>',
        });
        message('m2', 'user', 6, { text: 'New first prompt', files: [], agents: [] });
        message('m3', 'assistant', 7, { content: [{ type: 'text', text: 'On it' }] });
        message('m4', 'user', 20, { text: 'New last prompt', files: [], agents: [] });
        message('m5', 'idle', 30, { outcome: 'succeeded' });
      } finally {
        db.close();
      }
      const fs: HistoryFs = { ...localHistoryFs, scope: 'opencode-real-v2', home: async () => dir };
      const sessions = await collectHistory(fs, { folder: 'E:/App' });
      expect(sessions.map((s) => [s.provider, s.id, s.title, s.firstPrompt, s.lastPrompt])).toEqual(
        [['opencode', 'ses_new', null, 'New first prompt', 'New last prompt']],
      );
      expect(sessions[0]).toMatchObject({ cwd: 'E:/App', model: 'm-new' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caches prompts until the session updates', async () => {
    const sessions = [
      {
        id: 'ses_1',
        directory: '/work/app',
        title: 'Cached',
        model: null,
        time_created: 1,
        time_updated: 2,
      },
    ];
    const options = {
      opencode: store(sessions, { ses_1: { first: 'Original', last: null } }),
    };
    const fs = fakeFs(dbFile(), options);
    const queryDb = vi.fn(fs.queryDb);
    fs.queryDb = queryDb;
    await collectHistory(fs, { folder: '/work/app' });
    const callsAfterFirst = queryDb.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await collectHistory(fs, { folder: '/work/app' });
    // Sessions list is re-read, but the cached prompts are not.
    expect(queryDb.mock.calls.length).toBeLessThan(callsAfterFirst * 2);
  });
});

describe('collectHistory for FreeBuff', () => {
  const projects = '/home/me/.config/manicode/projects';

  it('matches folders by basename and reads prompts via the sidecar', async () => {
    const fs = fakeFs({
      ...freebuffChat(`${projects}/app`, 'chat-app-1', 'App ask', 10),
      ...freebuffChat(`${projects}/other`, 'chat-other-1', 'Other ask', 20),
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => [s.provider, s.id, s.firstPrompt])).toEqual([
      ['freebuff-cli', 'chat-app-1', 'App ask'],
    ]);
    expect(sessions[0]).toMatchObject({ cwd: null, updatedAt: 10 });

    clearHistoryCaches();
    const other = await collectHistory(fs, { folder: 'E:\\srv\\other' });
    expect(other.map((s) => s.id)).toEqual(['chat-other-1']);
  });

  it('follows FREEBUFF_CONFIG_DIR', async () => {
    const fs = fakeFs(freebuffChat('/cfg/fb/projects/app', 'chat-cfg-1', 'Cfg ask', 5), {
      env: { FREEBUFF_CONFIG_DIR: '/cfg/fb' },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => s.id)).toEqual(['chat-cfg-1']);
  });

  it('falls back to the transcript when the sidecar is stale', async () => {
    const messages = JSON.stringify([
      { id: 'm1', variant: 'user', content: 'Transcript ask', timestamp: '2026-10-12T07:30:00Z' },
    ]);
    const fs = fakeFs({
      [`${projects}/app/chats/chat-stale-1/chat-messages.json`]: { content: messages, mtimeMs: 7 },
      [`${projects}/app/chats/chat-stale-1/chat-meta.json`]: {
        // Bound to an older snapshot of the transcript.
        content: JSON.stringify({
          messageCount: 1,
          firstPrompt: 'Stale preview',
          messagesSize: 1,
          messagesMtimeMs: 1,
        }),
        mtimeMs: 7,
      },
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => [s.id, s.firstPrompt])).toEqual([
      ['chat-stale-1', 'Transcript ask'],
    ]);
  });

  it('skips chats without a readable transcript', async () => {
    const fs = fakeFs({
      // Meta but no messages file.
      [`${projects}/app/chats/chat-nomsgs/chat-meta.json`]: {
        content: JSON.stringify({
          messageCount: 2,
          firstPrompt: 'Ghost',
          messagesSize: 10,
          messagesMtimeMs: 1,
        }),
        mtimeMs: 3,
      },
      // Corrupt messages file.
      [`${projects}/app/chats/chat-broken/chat-messages.json`]: {
        content: '[{"variant":"user","content":',
        mtimeMs: 4,
      },
      ...freebuffChat(`${projects}/app`, 'chat-good-1', 'Good ask', 5),
    });
    const sessions = await collectHistory(fs, { folder: '/work/app' });
    expect(sessions.map((s) => s.id)).toEqual(['chat-good-1']);
  });

  it('caches chats until their transcript changes', async () => {
    const files = freebuffChat(`${projects}/app`, 'chat-cache-1', 'Cached ask', 6);
    const fs = fakeFs(files);
    await collectHistory(fs, { folder: '/work/app' });
    expect(fs.reads.length).toBeGreaterThan(0);

    fs.reads.length = 0;
    const again = await collectHistory(fs, { folder: '/work/app' });
    expect(again.map((s) => s.firstPrompt)).toEqual(['Cached ask']);
    expect(fs.reads).toEqual([]);
  });

  it('returns nothing when no project dir exists', async () => {
    await expect(collectHistory(fakeFs({}), { folder: '/work/app' })).resolves.toEqual([]);
  });
});

describe('collectHistory remembering where sessions live', () => {
  // The usage menu opens a transcript by the provider and id the list handed out, so the list
  // has to leave that mapping behind. Only this machine's files can be opened later.
  beforeEach(() => {
    clearHistorySources();
  });

  const claudeFile = `${claudeDir}/-work-app/a.jsonl`;
  const opencodeDb = '/home/me/.local/share/opencode/opencode.db';

  it('remembers the transcript of every session it lists on this machine', async () => {
    const fs = fakeFs(
      {
        [claudeFile]: { content: claudeTranscript('/work/app', 'Fix it'), mtimeMs: 10 },
        [`${codexDir}/rollout-1.jsonl`]: {
          content: codexRollout('x1', '/work/app', 'Codex yes'),
          mtimeMs: 40,
        },
      },
      { scope: 'local' },
    );
    await collectHistory(fs, { folder: '/work/app' });

    expect(historySource('claude-code', 'a')).toEqual({ path: claudeFile, mtimeMs: 10 });
    // Codex lists by the session id inside the file, not by the file name.
    expect(historySource('codex', 'x1')).toEqual({
      path: `${codexDir}/rollout-1.jsonl`,
      mtimeMs: 40,
    });
  });

  it('remembers the database and the pseudo path of an OpenCode session', async () => {
    const fs = fakeFs(
      { [opencodeDb]: { content: 'SQLite format 3\0fake', mtimeMs: 1 } },
      {
        scope: 'local',
        opencode: {
          sessions: [
            {
              id: 'ses_1',
              directory: '/work/app',
              title: 'Ship it',
              model: null,
              time_created: 10,
              time_updated: 20,
            },
          ],
          prompts: { ses_1: { first: 'First ask', last: null } },
        },
      },
    );
    await collectHistory(fs, { folder: '/work/app' });

    // The mtime is the session's last update, which is what tells the usage cache to re-read.
    expect(historySource('opencode', 'ses_1')).toEqual({
      path: `${opencodeDb}#ses_1`,
      mtimeMs: 20,
      dbPath: opencodeDb,
    });
  });

  it('keeps the same id under two agents apart', async () => {
    const fs = fakeFs(
      {
        [claudeFile]: { content: claudeTranscript('/work/app', 'Claude'), mtimeMs: 10 },
        [`${codexDir}/rollout-1.jsonl`]: {
          content: codexRollout('a', '/work/app', 'Codex'),
          mtimeMs: 40,
        },
      },
      { scope: 'local' },
    );
    await collectHistory(fs, { folder: '/work/app' });

    expect(historySource('claude-code', 'a')?.path).toBe(claudeFile);
    expect(historySource('codex', 'a')?.path).toBe(`${codexDir}/rollout-1.jsonl`);
  });

  it('updates a session it lists again after it changed, and knows no other', async () => {
    const files = {
      [claudeFile]: { content: claudeTranscript('/work/app', 'Fix it'), mtimeMs: 10 },
    };
    await collectHistory(fakeFs(files, { scope: 'local' }), { folder: '/work/app' });
    expect(historySource('claude-code', 'a')?.mtimeMs).toBe(10);

    files[claudeFile] = { content: claudeTranscript('/work/app', 'Fix it'), mtimeMs: 99 };
    await collectHistory(fakeFs(files, { scope: 'local' }), { folder: '/work/app' });
    expect(historySource('claude-code', 'a')?.mtimeMs).toBe(99);
    expect(historySource('claude-code', 'never-listed')).toBeUndefined();
  });

  it('remembers nothing for a server, whose files this machine cannot open', async () => {
    const fs = fakeFs(
      { [claudeFile]: { content: claudeTranscript('/work/app', 'Fix it'), mtimeMs: 10 } },
      { scope: 'ssh:srv-1' },
    );
    const sessions = await collectHistory(fs, { folder: '/work/app' });

    expect(sessions.map((s) => s.id)).toEqual(['a']);
    expect(historySource('claude-code', 'a')).toBeUndefined();
  });

  it('skips a candidate that turned out to hold no conversation', async () => {
    const fs = fakeFs(
      {
        [claudeFile]: { content: claudeTranscript('/work/app', 'Fix it'), mtimeMs: 10 },
        // Only snapshots, so it is not a session and has nothing to remember.
        [`${claudeDir}/-work-app/empty.jsonl`]: {
          content: jsonl({ type: 'file-history-snapshot' }),
          mtimeMs: 20,
        },
      },
      { scope: 'local' },
    );
    await collectHistory(fs, { folder: '/work/app' });

    expect(historySource('claude-code', 'a')).toBeDefined();
    expect(historySource('claude-code', 'empty')).toBeUndefined();
  });
});

describe('localHistoryFs', () => {
  it('lists entries with sizes and reads byte ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-'));
    try {
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'a.jsonl'), 'héllo\nworld\n');
      const entries = await localHistoryFs.list(dir);
      const file = entries.find((e) => e.name === 'a.jsonl');
      expect(file).toMatchObject({ isFile: true, isDirectory: false, size: 13 });
      expect(file?.mtimeMs).toBeGreaterThan(0);
      expect(entries.find((e) => e.name === 'sub')).toMatchObject({ isDirectory: true });
      expect(await localHistoryFs.readRange(join(dir, 'a.jsonl'), 7, 5)).toBe('world');
      await expect(localHistoryFs.list(join(dir, 'missing'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
