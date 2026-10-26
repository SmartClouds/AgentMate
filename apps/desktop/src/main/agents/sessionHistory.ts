import { copyFileSync, mkdtempSync } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHistoryProvider,
  type AgentHistorySession,
  claudeProjectDirName,
  codexRolloutMeta,
  type FreebuffChatMeta,
  freebuffProjectDirName,
  type OpencodeSessionRow,
  parseFreebuffMeta,
  promptPreview,
  type SessionSummary,
  sameFolder,
  summarizeClaudeTranscript,
  summarizeClineSession,
  summarizeCodexRollout,
  summarizeContinueSession,
  summarizeCursorSession,
  summarizeFreebuffChat,
  summarizeGeminiChat,
  summarizeGrokChat,
  summarizeOpencodeSession,
} from '@runova/core';
import Database from 'better-sqlite3';
import { rememberHistorySource } from './historySources';
import {
  type OpencodeSessionTable,
  opencodePromptSql,
  opencodeSessionTable,
} from './opencodeStore';

// Past conversations for the workspace's history section. Each CLI keeps its own store:
// Claude Code (and OpenClaude, same format) one transcript per session in a folder named
// after the project path; Codex rollouts by date with the folder on the first line;
// Gemini/Qwen JSONL chats under tmp/<hash>/chats with the folder in a sibling
// `.project_root`; Cursor meta.json + prompt_history.json; Continue one JSON per
// session; Grok chat_history.jsonl under a url-encoded folder dir; Cline one JSON
// per session; OpenCode rows in a SQLite store queried for metadata plus the first
// and last user prompt; FreeBuff chats under a per-project dir with a sidecar
// preview. Only the first and last chunk of a file is read, and the
// result is cached against the file's size and mtime, so listing again is nearly free.
//
// The reading goes through a small HistoryFs, so the same logic lists this machine's history
// and, over SFTP, a saved server's.

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
const FIRST_LINE_STEP = 64 * 1024;
const FIRST_LINE_LIMIT = 2 * 1024 * 1024;
const THREAD_INDEX_LIMIT = 8 * 1024 * 1024;
const MAX_SESSIONS = 200;
const CONCURRENCY = 6;

export interface HistoryDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

/** The few file operations the history reader needs, on this machine or a remote one. */
export interface HistoryFs {
  /** Cache namespace, e.g. 'local' or 'ssh:<serverId>'. */
  readonly scope: string;
  readonly caseInsensitive: boolean;
  /** Join path segments with the target's separator. */
  join(...parts: string[]): string;
  home(): Promise<string>;
  env(name: string): Promise<string | undefined>;
  /** Entries with attributes in one call; rejects or returns [] when the dir is missing. */
  list(dir: string): Promise<HistoryDirEntry[]>;
  /** Decoded UTF-8 text of bytes [start, start+length). */
  readRange(path: string, start: number, length: number): Promise<string>;
  /**
   * Rows from a local SQLite database. Only the local reader implements it:
   * SQL cannot run over SFTP, so remote targets skip SQLite-backed CLIs.
   */
  queryDb?(dbPath: string, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface CollectHistoryOptions {
  /** Only sessions started in this folder. Without it, every session on the target. */
  folder?: string;
  limit?: number;
  headBytes?: number;
  tailBytes?: number;
  /** How many files are read at once. */
  concurrency?: number;
  /**
   * Only these agents are read; the others are not even looked for. OpenCode keeps its sessions
   * in a database that is queried synchronously, so a caller that does not need it can leave it
   * out and keep the main process free.
   */
  providers?: readonly AgentHistoryProvider[];
}

interface Settings {
  folder: string | undefined;
  limit: number;
  headBytes: number;
  tailBytes: number;
  concurrency: number;
  providers: readonly AgentHistoryProvider[] | undefined;
}

interface FileInfo {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
}

type CodexMeta = { id: string; cwd: string | null; background: boolean } | null;

const summaryCache = new Map<string, { key: string; summary: SessionSummary | null }>();
/** A rollout's folder never changes, so its first line is read once per app run. */
const codexMetaCache = new Map<string, CodexMeta>();

/** Forgets every cached summary and rollout folder. For tests. */
export function clearHistoryCaches(): void {
  summaryCache.clear();
  codexMetaCache.clear();
}

const cacheKey = (fs: HistoryFs, path: string): string => `${fs.scope}\u0000${path}`;

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

async function listDir(fs: HistoryFs, dir: string): Promise<HistoryDirEntry[]> {
  try {
    return await fs.list(dir);
  } catch {
    return [];
  }
}

const fileInfo = (fs: HistoryFs, dir: string, entry: HistoryDirEntry): FileInfo => ({
  path: fs.join(dir, entry.name),
  name: entry.name,
  mtimeMs: entry.mtimeMs,
  size: entry.size,
});

/** The file's first and last lines. Lines cut by a chunk edge fail to parse and are skipped. */
async function readHeadAndTail(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<{ head: string[]; tail: string[] }> {
  const head = (await fs.readRange(file.path, 0, Math.min(settings.headBytes, file.size))).split(
    '\n',
  );
  if (file.size <= settings.headBytes) return { head, tail: [] };
  const start = Math.max(settings.headBytes, file.size - settings.tailBytes);
  const tail = (await fs.readRange(file.path, start, file.size - start)).split('\n');
  return { head, tail };
}

/**
 * The first line, read in steps from `start` on top of `text` already read. A multi-byte
 * character cut by a step edge only garbles a JSON string value, so the line still parses.
 */
async function readFirstLine(fs: HistoryFs, file: FileInfo, start = 0, text = ''): Promise<string> {
  let offset = start;
  let line = text;
  while (offset < file.size && offset < FIRST_LINE_LIMIT) {
    const length = Math.min(FIRST_LINE_STEP, file.size - offset);
    const chunk = await fs.readRange(file.path, offset, length);
    if (!chunk) break;
    const newline = chunk.indexOf('\n');
    if (newline >= 0) return line + chunk.slice(0, newline);
    line += chunk;
    offset += length;
  }
  return line;
}

async function summarize(
  fs: HistoryFs,
  file: FileInfo,
  read: (file: FileInfo) => Promise<SessionSummary | null>,
): Promise<SessionSummary | null> {
  const key = `${file.size}:${file.mtimeMs}`;
  const cached = summaryCache.get(cacheKey(fs, file.path));
  if (cached?.key === key) return cached.summary;
  let summary: SessionSummary | null = null;
  try {
    summary = await read(file);
  } catch {
    summary = null;
  }
  summaryCache.set(cacheKey(fs, file.path), { key, summary });
  return summary;
}

function toSession(
  provider: AgentHistoryProvider,
  file: FileInfo,
  summary: SessionSummary,
): AgentHistorySession {
  return { ...summary, provider, updatedAt: file.mtimeMs, sizeBytes: file.size };
}

// --- Claude Code ------------------------------------------------------------

async function claudeRoots(fs: HistoryFs, home: string): Promise<string[]> {
  const roots: string[] = [];
  const configDir = await fs.env('CLAUDE_CONFIG_DIR');
  if (configDir) roots.push(fs.join(configDir, 'projects'));
  roots.push(fs.join(home, '.claude', 'projects'), fs.join(home, '.config', 'claude', 'projects'));
  return [...new Set(roots)];
}

/** Transcript files, from the folder's project dirs or, without a folder, from all of them. */
async function claudeFiles(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const wanted = settings.folder === undefined ? null : claudeProjectDirName(settings.folder);
  const dirs: string[] = [];
  for (const root of await claudeRoots(fs, home)) {
    // The drive letter's case follows however the CLI was started, so both spellings exist.
    for (const entry of await listDir(fs, root)) {
      if (!entry.isDirectory) continue;
      const matches =
        wanted === null ||
        (fs.caseInsensitive
          ? entry.name.toLowerCase() === wanted.toLowerCase()
          : entry.name === wanted);
      if (matches) dirs.push(fs.join(root, entry.name));
    }
  }
  const lists = await mapLimit(dirs, settings.concurrency, async (dir) =>
    (await listDir(fs, dir))
      .filter((entry) => entry.isFile && entry.name.endsWith('.jsonl'))
      .map((entry) => fileInfo(fs, dir, entry)),
  );
  return lists.flat();
}

async function claudeSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeClaudeTranscript(f.name.slice(0, -'.jsonl'.length), head, tail);
  });
  if (!summary) return null;
  // Different paths can share a folder name (`a-b` and `a/b`), so check the real one.
  const { folder } = settings;
  if (folder !== undefined && summary.cwd && !sameFolder(summary.cwd, folder, fs.caseInsensitive)) {
    return null;
  }
  return toSession('claude-code', file, summary);
}

// --- Codex --------------------------------------------------------------------

async function codexHome(fs: HistoryFs, home: string): Promise<string> {
  return (await fs.env('CODEX_HOME')) || fs.join(home, '.codex');
}

async function codexRollouts(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    await mapLimit(await listDir(fs, dir), settings.concurrency, async (entry) => {
      if (entry.isDirectory && depth < 4) await walk(fs.join(dir, entry.name), depth + 1);
      else if (entry.isFile && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(fileInfo(fs, dir, entry));
      }
    });
  }
  await walk(fs.join(home, 'sessions'), 0);
  return out;
}

/** Rollouts worth reading: those started in the folder, or every one without a folder. */
async function codexFiles(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const rollouts = await codexRollouts(fs, home, settings);
  const { folder } = settings;
  if (folder === undefined) return rollouts;
  const metas = await mapLimit(rollouts, settings.concurrency, async (file) => {
    const key = cacheKey(fs, file.path);
    let meta = codexMetaCache.get(key);
    if (meta === undefined) {
      try {
        meta = codexRolloutMeta(await readFirstLine(fs, file));
      } catch {
        meta = null;
      }
      codexMetaCache.set(key, meta);
    }
    return meta;
  });
  return rollouts.filter((_, i) => {
    const cwd = metas[i]?.cwd;
    return cwd ? sameFolder(cwd, folder, fs.caseInsensitive) : false;
  });
}

async function codexSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    // The meta line can be longer than the head chunk; finish it and hand it over whole.
    const cut = head.length === 1 && f.size > settings.headBytes;
    const first = cut ? await readFirstLine(fs, f, settings.headBytes, head[0]) : head[0];
    return summarizeCodexRollout([first, ...head.slice(1)], tail);
  });
  return summary ? toSession('codex', file, summary) : null;
}

/** Thread names Codex shows in its own resume picker, by session id. */
async function codexThreadNames(fs: HistoryFs, home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const index = (await listDir(fs, home)).find(
    (entry) => entry.isFile && entry.name === 'session_index.jsonl',
  );
  if (!index) return names;
  try {
    const path = fs.join(home, index.name);
    const text = await fs.readRange(path, 0, Math.min(index.size, THREAD_INDEX_LIMIT));
    for (const line of text.split('\n')) {
      try {
        const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof record.id === 'string' && typeof record.thread_name === 'string') {
          names.set(record.id, record.thread_name);
        }
      } catch {
        /* partial or foreign line */
      }
    }
  } catch {
    /* removed while reading */
  }
  return names;
}

// --- OpenClaude (Claude-compatible transcripts) ----------------------------------

async function openclaudeRoots(fs: HistoryFs, home: string): Promise<string[]> {
  const roots: string[] = [fs.join(home, '.openclaude', 'projects')];
  const override = await fs.env('OPENCLAUDE_CONFIG_DIR');
  if (override) roots.unshift(fs.join(override, 'projects'));
  return [...new Set(roots)];
}

async function openclaudeFiles(
  fs: HistoryFs,
  home: string,
  settings: Settings,
): Promise<FileInfo[]> {
  const wanted = settings.folder === undefined ? null : claudeProjectDirName(settings.folder);
  const dirs: string[] = [];
  for (const root of await openclaudeRoots(fs, home)) {
    for (const entry of await listDir(fs, root)) {
      if (!entry.isDirectory) continue;
      const matches =
        wanted === null ||
        (fs.caseInsensitive
          ? entry.name.toLowerCase() === wanted.toLowerCase()
          : entry.name === wanted);
      if (matches) dirs.push(fs.join(root, entry.name));
    }
  }
  const lists = await mapLimit(dirs, settings.concurrency, async (dir) =>
    (await listDir(fs, dir))
      .filter((entry) => entry.isFile && entry.name.endsWith('.jsonl'))
      .map((entry) => fileInfo(fs, dir, entry)),
  );
  return lists.flat();
}

async function openclaudeSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeClaudeTranscript(f.name.slice(0, -'.jsonl'.length), head, tail);
  });
  if (!summary) return null;
  const { folder } = settings;
  if (folder !== undefined && summary.cwd && !sameFolder(summary.cwd, folder, fs.caseInsensitive)) {
    return null;
  }
  return toSession('openclaude', file, summary);
}

// --- Gemini / Qwen ------------------------------------------------------------

/** `<hash> -> folder` from each `tmp/<hash>/.project_root` sidecar file. */
async function geminiHashRoots(
  fs: HistoryFs,
  tmpRoot: string,
  settings: Settings,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const hashes = (await listDir(fs, tmpRoot)).filter((e) => e.isDirectory);
  await mapLimit(hashes, settings.concurrency, async (entry) => {
    try {
      const text = (
        await fs.readRange(fs.join(tmpRoot, entry.name, '.project_root'), 0, 4096)
      ).trim();
      if (text) map.set(entry.name, text);
    } catch {
      /* no sidecar */
    }
  });
  return map;
}

async function geminiChats(
  fs: HistoryFs,
  tmpRoot: string,
  settings: Settings,
): Promise<{ file: FileInfo; cwd: string | null }[]> {
  const out: { file: FileInfo; cwd: string | null }[] = [];
  const hashCwd = await geminiHashRoots(fs, tmpRoot, settings).catch(
    () => new Map<string, string>(),
  );
  const hashes = (await listDir(fs, tmpRoot).catch(() => [] as HistoryDirEntry[])).filter(
    (e) => e.isDirectory,
  );
  // Without a folder every hash counts; with one, only hashes whose sidecar matches.
  const wanted = hashes.filter((entry) => {
    if (settings.folder === undefined) return true;
    const cwd = hashCwd.get(entry.name);
    return cwd ? sameFolder(cwd, settings.folder, fs.caseInsensitive) : false;
  });
  await mapLimit(wanted, settings.concurrency, async (entry) => {
    const chatsDir = fs.join(tmpRoot, entry.name, 'chats');
    const chats = (await listDir(fs, chatsDir).catch(() => [] as HistoryDirEntry[]))
      .filter((e) => e.isFile && e.name.startsWith('session-') && e.name.endsWith('.jsonl'))
      .map((e) => ({ file: fileInfo(fs, chatsDir, e), cwd: hashCwd.get(entry.name) ?? null }));
    out.push(...chats);
  });
  return out;
}

async function geminiSession(
  provider: 'gemini-cli' | 'qwen-cli',
  fs: HistoryFs,
  file: FileInfo,
  cwd: string | null,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  // The summary cache key covers the chat file; the sidecar cwd is stable per hash.
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeGeminiChat(f.name.replace(/\.jsonl$/, ''), head, tail);
  });
  if (!summary) return null;
  return toSession(provider, file, { ...summary, cwd: cwd ?? summary.cwd });
}

// --- Cursor -------------------------------------------------------------------

interface CursorCandidate extends FileInfo {
  promptPath: string | null;
  promptSize: number;
  promptMtime: number;
}

async function cursorFiles(
  fs: HistoryFs,
  home: string,
  settings: Settings,
): Promise<CursorCandidate[]> {
  const out: CursorCandidate[] = [];
  const chatsRoot = fs.join(home, '.cursor', 'chats');
  const workspaces = (await listDir(fs, chatsRoot).catch(() => [] as HistoryDirEntry[])).filter(
    (e) => e.isDirectory,
  );
  await mapLimit(workspaces, settings.concurrency, async (ws) => {
    const ids = (
      await listDir(fs, fs.join(chatsRoot, ws.name)).catch(() => [] as HistoryDirEntry[])
    ).filter((e) => e.isDirectory);
    await mapLimit(ids, settings.concurrency, async (id) => {
      const dir = fs.join(chatsRoot, ws.name, id.name);
      const entries = await listDir(fs, dir).catch(() => [] as HistoryDirEntry[]);
      const meta = entries.find((e) => e.isFile && e.name === 'meta.json');
      if (!meta) return;
      const prompt = entries.find((e) => e.isFile && e.name === 'prompt_history.json');
      out.push({
        ...fileInfo(fs, dir, meta),
        promptPath: prompt ? fs.join(dir, prompt.name) : null,
        promptSize: prompt?.size ?? 0,
        promptMtime: prompt?.mtimeMs ?? 0,
      });
    });
  });
  if (settings.folder === undefined) return out;
  // meta.json is tiny: read it to filter by cwd before the limit cut.
  const kept: CursorCandidate[] = [];
  await mapLimit(out, settings.concurrency, async (file) => {
    try {
      const text = await fs.readRange(file.path, 0, Math.min(file.size, settings.headBytes));
      const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
      if (cwd) {
        try {
          const parsed = JSON.parse(`"${cwd}"`) as string;
          if (sameFolder(parsed, settings.folder as string, fs.caseInsensitive)) kept.push(file);
          return;
        } catch {
          /* fall through */
        }
      }
      // Unparseable cwd: keep rather than hide a possibly-matching session.
      kept.push(file);
    } catch {
      /* removed while reading */
    }
  });
  return kept;
}

async function cursorSession(
  fs: HistoryFs,
  file: CursorCandidate,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  // Prompt text lives beside meta.json; fold its size+mtime into the cache key.
  const key = `${file.size}:${file.mtimeMs}:${file.promptSize}:${file.promptMtime}`;
  const cacheId = cacheKey(fs, file.path);
  const cached = summaryCache.get(cacheId);
  if (cached?.key === key) {
    const summary = cached.summary;
    if (!summary) return null;
    if (
      settings.folder !== undefined &&
      summary.cwd &&
      !sameFolder(summary.cwd, settings.folder, fs.caseInsensitive)
    ) {
      return null;
    }
    return toSession('cursor-cli', file, summary);
  }
  let summary: SessionSummary | null = null;
  try {
    const metaText = await fs.readRange(file.path, 0, Math.min(file.size, settings.headBytes));
    let promptText = '';
    if (file.promptPath) {
      try {
        promptText = await fs.readRange(
          file.promptPath,
          0,
          Math.min(file.promptSize, settings.headBytes),
        );
      } catch {
        promptText = '';
      }
    }
    summary = summarizeCursorSession(file.name, [metaText, promptText], []);
  } catch {
    summary = null;
  }
  summaryCache.set(cacheId, { key, summary });
  if (!summary) return null;
  if (
    settings.folder !== undefined &&
    summary.cwd &&
    !sameFolder(summary.cwd, settings.folder, fs.caseInsensitive)
  ) {
    return null;
  }
  return toSession('cursor-cli', file, summary);
}

// --- Continue -----------------------------------------------------------------

async function continueFiles(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const dir = fs.join(home, '.continue', 'sessions');
  const files = (await listDir(fs, dir).catch(() => [] as HistoryDirEntry[]))
    .filter((e) => e.isFile && e.name.endsWith('.json'))
    .map((e) => fileInfo(fs, dir, e));
  if (settings.folder === undefined) return files;
  const kept: FileInfo[] = [];
  await mapLimit(files, settings.concurrency, async (file) => {
    try {
      const text = await fs.readRange(file.path, 0, Math.min(file.size, settings.headBytes));
      const ws = /"workspaceDirectory"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
      if (!ws) {
        kept.push(file);
        return;
      }
      let cwd = ws;
      try {
        const url = new URL(JSON.parse(`"${ws}"`) as string);
        cwd = decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      } catch {
        /* raw value */
      }
      if (!cwd || sameFolder(cwd, settings.folder as string, fs.caseInsensitive)) kept.push(file);
    } catch {
      /* removed while reading */
    }
  });
  return kept;
}

async function continueSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeContinueSession(f.name.replace(/\.json$/, ''), head, tail);
  });
  if (!summary) return null;
  if (
    settings.folder !== undefined &&
    summary.cwd &&
    !sameFolder(summary.cwd, settings.folder, fs.caseInsensitive)
  ) {
    return null;
  }
  return toSession('continue-cli', file, summary);
}

// --- Grok ---------------------------------------------------------------------

async function grokFiles(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const root = fs.join(home, '.grok', 'sessions');
  const dirs = (await listDir(fs, root).catch(() => [] as HistoryDirEntry[])).filter(
    (e) => e.isDirectory && !e.name.endsWith('.sqlite'),
  );
  const wanted = dirs.filter((entry) => {
    if (settings.folder === undefined) return true;
    try {
      return sameFolder(decodeURIComponent(entry.name), settings.folder, fs.caseInsensitive);
    } catch {
      return false;
    }
  });
  const out: FileInfo[] = [];
  await mapLimit(wanted, settings.concurrency, async (entry) => {
    const sessions = (
      await listDir(fs, fs.join(root, entry.name)).catch(() => [] as HistoryDirEntry[])
    ).filter((e) => e.isDirectory);
    await mapLimit(sessions, settings.concurrency, async (session) => {
      const chat = fs.join(root, entry.name, session.name, 'chat_history.jsonl');
      try {
        const text = await fs.readRange(chat, 0, 1);
        void text;
        // Size/mtime come from a list of the parent dir to avoid an extra stat shape.
        const siblings = await listDir(fs, fs.join(root, entry.name, session.name)).catch(
          () => [] as HistoryDirEntry[],
        );
        const hit = siblings.find((e) => e.isFile && e.name === 'chat_history.jsonl');
        if (hit) out.push(fileInfo(fs, fs.join(root, entry.name, session.name), hit));
      } catch {
        /* no chat history */
      }
    });
  });
  return out;
}

function grokCwdFor(file: FileInfo, _fs: HistoryFs): string | null {
  // .../sessions/<url-encoded-cwd>/<session-id>/chat_history.jsonl
  const parts = file.path.split(/[\\/]/);
  const encoded = parts[parts.length - 3] ?? '';
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

async function grokSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeGrokChat(f.name, head, tail);
  });
  if (!summary) return null;
  return toSession('grok-cli', file, { ...summary, cwd: grokCwdFor(file, fs) });
}

// --- Cline --------------------------------------------------------------------

async function clineFiles(fs: HistoryFs, home: string, settings: Settings): Promise<FileInfo[]> {
  const root = fs.join(home, '.cline', 'data', 'sessions');
  const groups = (await listDir(fs, root).catch(() => [] as HistoryDirEntry[])).filter(
    (e) => e.isDirectory,
  );
  const out: FileInfo[] = [];
  await mapLimit(groups, settings.concurrency, async (group) => {
    const entries = (
      await listDir(fs, fs.join(root, group.name)).catch(() => [] as HistoryDirEntry[])
    ).filter((e) => e.isFile && e.name.endsWith('.json') && !e.name.endsWith('.messages.json'));
    for (const entry of entries) out.push(fileInfo(fs, fs.join(root, group.name), entry));
  });
  if (settings.folder === undefined) return out;
  const kept: FileInfo[] = [];
  await mapLimit(out, settings.concurrency, async (file) => {
    try {
      const text = await fs.readRange(file.path, 0, Math.min(file.size, settings.headBytes));
      const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
      if (!cwd) {
        kept.push(file);
        return;
      }
      try {
        if (
          sameFolder(
            JSON.parse(`"${cwd}"`) as string,
            settings.folder as string,
            fs.caseInsensitive,
          )
        ) {
          kept.push(file);
        }
      } catch {
        kept.push(file);
      }
    } catch {
      /* removed while reading */
    }
  });
  return kept;
}

async function clineSession(
  fs: HistoryFs,
  file: FileInfo,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeClineSession(f.name.replace(/\.json$/, ''), head, tail);
  });
  if (!summary) return null;
  if (
    settings.folder !== undefined &&
    summary.cwd &&
    !sameFolder(summary.cwd, settings.folder, fs.caseInsensitive)
  ) {
    return null;
  }
  return toSession('cline-cli', file, summary);
}

// --- OpenCode (SQLite session store) ----------------------------------------------

const OPENCODE_DB_HEADER = 'SQLite format 3\0';

/**
 * Where OpenCode keeps `opencode.db`. The XDG-style path holds on Linux and
 * Windows; macOS uses Application Support. Probed in order, so a missing file
 * just falls through to the next candidate.
 */
export async function findOpencodeDb(fs: HistoryFs, home: string): Promise<string | null> {
  const candidates = [
    fs.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    fs.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'),
  ];
  for (const dbPath of candidates) {
    try {
      const header = await fs.readRange(dbPath, 0, OPENCODE_DB_HEADER.length);
      if (header === OPENCODE_DB_HEADER) return dbPath;
    } catch {
      /* missing or unreadable: try the next candidate */
    }
  }
  return null;
}

interface OpencodeCandidate {
  file: FileInfo;
  row: OpencodeSessionRow;
  dbPath: string;
  /** Which tables this database keeps its sessions in, which decides where the prompts are. */
  table: OpencodeSessionTable;
}

async function opencodeCandidates(
  fs: HistoryFs,
  home: string,
  settings: Settings,
): Promise<OpencodeCandidate[]> {
  // SQL cannot run over SFTP, so only targets with a queryDb (this machine) read OpenCode.
  if (!fs.queryDb) return [];
  const dbPath = await findOpencodeDb(fs, home).catch(() => null);
  if (!dbPath) return [];
  const { queryDb } = fs;
  let table: OpencodeSessionTable;
  let rows: Record<string, unknown>[];
  try {
    table = await opencodeSessionTable((sql) => queryDb(dbPath, sql));
    rows = await queryDb(
      dbPath,
      `SELECT id, directory, title, model, time_created, time_updated FROM ${table} ORDER BY time_updated DESC`,
    );
  } catch {
    return [];
  }
  const out: OpencodeCandidate[] = [];
  for (const record of rows) {
    if (typeof record.id !== 'string' || !record.id) continue;
    const cwd = typeof record.directory === 'string' && record.directory ? record.directory : null;
    if (
      settings.folder !== undefined &&
      cwd &&
      !sameFolder(cwd, settings.folder, fs.caseInsensitive)
    ) {
      continue;
    }
    const timeUpdated = typeof record.time_updated === 'number' ? record.time_updated : 0;
    out.push({
      // Pseudo-file: the summary cache keys on `size:mtimeMs`, i.e. the session's
      // last update, so an edited session is re-read and the rest is free.
      file: { path: `${dbPath}#${record.id}`, name: record.id, mtimeMs: timeUpdated, size: 0 },
      row: {
        id: record.id,
        directory: cwd,
        title: typeof record.title === 'string' ? record.title : null,
        model: typeof record.model === 'string' ? record.model : null,
        time_created: typeof record.time_created === 'number' ? record.time_created : null,
        time_updated: typeof record.time_updated === 'number' ? record.time_updated : null,
      },
      dbPath,
      table,
    });
  }
  return out;
}

async function opencodePrompt(
  fs: HistoryFs,
  dbPath: string,
  sessionId: string,
  sql: string,
): Promise<string | null> {
  try {
    const rows = await fs.queryDb?.(dbPath, sql, [sessionId]);
    const data = rows?.[0]?.data;
    if (typeof data !== 'string') return null;
    let text: string | null = null;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        const value = (parsed as { text?: unknown }).text;
        if (typeof value === 'string') text = value;
      }
    } catch {
      return null;
    }
    return text ? promptPreview(text) : null;
  } catch {
    return null;
  }
}

async function opencodeSession(
  fs: HistoryFs,
  candidate: OpencodeCandidate,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, candidate.file, async () => {
    const [first, last] = await Promise.all([
      opencodePrompt(
        fs,
        candidate.dbPath,
        candidate.row.id,
        opencodePromptSql(candidate.table, 'first'),
      ),
      opencodePrompt(
        fs,
        candidate.dbPath,
        candidate.row.id,
        opencodePromptSql(candidate.table, 'last'),
      ),
    ]);
    return summarizeOpencodeSession(candidate.row, first, last);
  });
  if (!summary) return null;
  const { folder } = settings;
  if (folder !== undefined && summary.cwd && !sameFolder(summary.cwd, folder, fs.caseInsensitive)) {
    return null;
  }
  return toSession('opencode', candidate.file, summary);
}

// --- FreeBuff -------------------------------------------------------------------

interface FreebuffCandidate extends FileInfo {
  /** The chat dir name, which is the id the CLI resumes by. */
  chatId: string;
  metaPath: string | null;
}

async function freebuffRoots(fs: HistoryFs, home: string): Promise<string[]> {
  const roots: string[] = [];
  const override = await fs.env('FREEBUFF_CONFIG_DIR');
  if (override) roots.push(override);
  roots.push(fs.join(home, '.config', 'manicode'));
  return [...new Set(roots)];
}

/**
 * FreeBuff chats live under a per-project dir named for the folder's basename:
 * `<config>/projects/<basename>/chats/<chatId>/chat-messages.json`, with a
 * tiny `chat-meta.json` sidecar preview. The transcript holds no folder, so a
 * folder query matches on the basename and the session's cwd stays unknown.
 */
async function freebuffChats(
  fs: HistoryFs,
  home: string,
  settings: Settings,
): Promise<FreebuffCandidate[]> {
  const out: FreebuffCandidate[] = [];
  const wanted =
    settings.folder === undefined ? null : freebuffProjectDirName(settings.folder).toLowerCase();
  for (const root of await freebuffRoots(fs, home)) {
    const projects = (await listDir(fs, fs.join(root, 'projects'))).filter((e) => e.isDirectory);
    const matching = projects.filter(
      (entry) =>
        wanted === null ||
        (fs.caseInsensitive ? entry.name.toLowerCase() === wanted : entry.name === wanted),
    );
    // Basename matching is case-sensitive on disk even where folder matching
    // is not, so fall back to a loose match before giving up on the folder.
    const dirs =
      matching.length > 0 || wanted === null
        ? matching
        : projects.filter((entry) => entry.name.toLowerCase() === wanted);
    await mapLimit(dirs, settings.concurrency, async (project) => {
      const chatsDir = fs.join(root, 'projects', project.name, 'chats');
      const chats = (await listDir(fs, chatsDir)).filter((e) => e.isDirectory);
      await mapLimit(chats, settings.concurrency, async (chat) => {
        const dir = fs.join(chatsDir, chat.name);
        const entries = await listDir(fs, dir);
        const messages = entries.find((e) => e.isFile && e.name === 'chat-messages.json');
        if (!messages) return;
        const meta = entries.find((e) => e.isFile && e.name === 'chat-meta.json');
        out.push({
          ...fileInfo(fs, dir, messages),
          chatId: chat.name,
          metaPath: meta ? fs.join(dir, meta.name) : null,
        });
      });
    });
  }
  return out;
}

async function freebuffSession(
  fs: HistoryFs,
  file: FreebuffCandidate,
  settings: Settings,
): Promise<AgentHistorySession | null> {
  const summary = await summarize(fs, file, async (f) => {
    let meta: FreebuffChatMeta | null = null;
    if (file.metaPath) {
      try {
        // The sidecar is a few hundred bytes; one small read covers it whole.
        meta = parseFreebuffMeta(await fs.readRange(file.metaPath, 0, 4096));
      } catch {
        meta = null;
      }
    }
    const { head, tail } = await readHeadAndTail(fs, f, settings);
    return summarizeFreebuffChat(file.chatId, meta, f.size, f.mtimeMs, head, tail);
  });
  if (!summary) return null;
  return toSession('freebuff-cli', file, summary);
}

// --- All ---------------------------------------------------------------------

/**
 * Past conversations from every supported CLI on the target, newest first.
 * Candidate files are capped to the newest `limit` before any transcript is
 * read, so a server with thousands of sessions costs `limit` reads, not thousands.
 */
export async function collectHistory(
  fs: HistoryFs,
  options: CollectHistoryOptions = {},
): Promise<AgentHistorySession[]> {
  const settings: Settings = {
    folder: options.folder,
    limit: options.limit ?? MAX_SESSIONS,
    headBytes: options.headBytes ?? HEAD_BYTES,
    tailBytes: options.tailBytes ?? TAIL_BYTES,
    concurrency: options.concurrency ?? CONCURRENCY,
    providers: options.providers,
  };
  // A reader that fails finds nothing, so one broken agent never hides the others; an agent the
  // caller did not ask for is not looked for at all.
  const candidatesOf = <Candidate>(
    provider: AgentHistoryProvider,
    load: () => Promise<Candidate[]>,
  ): Promise<Candidate[]> =>
    settings.providers === undefined || settings.providers.includes(provider)
      ? load().catch((): Candidate[] => [])
      : Promise.resolve([]);
  const home = await fs.home();
  const codex = await codexHome(fs, home);
  const geminiTmp = fs.join(home, '.gemini', 'tmp');
  const qwenTmp = fs.join(home, '.qwen', 'tmp');
  const [
    claudeCandidates,
    openclaudeCandidates,
    codexCandidates,
    geminiCandidates,
    qwenCandidates,
    cursorCandidates,
    continueCandidates,
    grokCandidates,
    clineCandidates,
    opencodeSessions,
    freebuffCandidates,
  ] = await Promise.all([
    candidatesOf('claude-code', () => claudeFiles(fs, home, settings)),
    candidatesOf('openclaude', () => openclaudeFiles(fs, home, settings)),
    candidatesOf('codex', () => codexFiles(fs, codex, settings)),
    candidatesOf('gemini-cli', () => geminiChats(fs, geminiTmp, settings)),
    candidatesOf('qwen-cli', () => geminiChats(fs, qwenTmp, settings)),
    candidatesOf('cursor-cli', () => cursorFiles(fs, home, settings)),
    candidatesOf('continue-cli', () => continueFiles(fs, home, settings)),
    candidatesOf('grok-cli', () => grokFiles(fs, home, settings)),
    candidatesOf('cline-cli', () => clineFiles(fs, home, settings)),
    candidatesOf('opencode', () => opencodeCandidates(fs, home, settings)),
    candidatesOf('freebuff-cli', () => freebuffChats(fs, home, settings)),
  ]);
  type Picked =
    | {
        provider: Exclude<AgentHistoryProvider, 'opencode' | 'freebuff-cli'>;
        file: FileInfo;
        cwd?: string | null;
      }
    | {
        provider: Exclude<AgentHistoryProvider, 'opencode' | 'freebuff-cli'>;
        file: CursorCandidate;
      }
    | ({ provider: 'opencode' } & OpencodeCandidate)
    | { provider: 'freebuff-cli'; file: FreebuffCandidate };
  const picked: Picked[] = [
    ...claudeCandidates.map((file) => ({ provider: 'claude-code' as const, file })),
    ...openclaudeCandidates.map((file) => ({ provider: 'openclaude' as const, file })),
    ...codexCandidates.map((file) => ({ provider: 'codex' as const, file })),
    ...geminiCandidates.map(({ file, cwd }) => ({ provider: 'gemini-cli' as const, file, cwd })),
    ...qwenCandidates.map(({ file, cwd }) => ({ provider: 'qwen-cli' as const, file, cwd })),
    ...cursorCandidates.map((file) => ({ provider: 'cursor-cli' as const, file })),
    ...continueCandidates.map((file) => ({ provider: 'continue-cli' as const, file })),
    ...grokCandidates.map((file) => ({ provider: 'grok-cli' as const, file })),
    ...clineCandidates.map((file) => ({ provider: 'cline-cli' as const, file })),
    ...opencodeSessions.map((candidate) => ({ provider: 'opencode' as const, ...candidate })),
    ...freebuffCandidates.map((file) => ({ provider: 'freebuff-cli' as const, file })),
  ]
    .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
    .slice(0, settings.limit);

  const read = await mapLimit(picked, settings.concurrency, (item) => {
    switch (item.provider) {
      case 'claude-code':
        return claudeSession(fs, item.file, settings);
      case 'openclaude':
        return openclaudeSession(fs, item.file, settings);
      case 'codex':
        return codexSession(fs, item.file, settings);
      case 'gemini-cli':
        return geminiSession(
          'gemini-cli',
          fs,
          item.file,
          (item as { cwd?: string | null }).cwd ?? null,
          settings,
        );
      case 'qwen-cli':
        return geminiSession(
          'qwen-cli',
          fs,
          item.file,
          (item as { cwd?: string | null }).cwd ?? null,
          settings,
        );
      case 'cursor-cli':
        return cursorSession(fs, item.file as CursorCandidate, settings);
      case 'continue-cli':
        return continueSession(fs, item.file, settings);
      case 'grok-cli':
        return grokSession(fs, item.file, settings);
      case 'cline-cli':
        return clineSession(fs, item.file, settings);
      case 'opencode':
        return opencodeSession(fs, item, settings);
      case 'freebuff-cli':
        return freebuffSession(fs, item.file, settings);
    }
  });
  let sessions = read.filter((s): s is AgentHistorySession => s !== null);

  // `read` lines up with `picked`. Only this machine's files can be read again for usage later.
  if (fs.scope === localHistoryFs.scope) {
    read.forEach((session, i) => {
      if (!session) return;
      const item = picked[i];
      rememberHistorySource(session.provider, session.id, {
        path: item.file.path,
        mtimeMs: item.file.mtimeMs,
        dbPath: item.provider === 'opencode' ? item.dbPath : undefined,
      });
    });
  }

  if (sessions.some((s) => s.provider === 'codex')) {
    const names = await codexThreadNames(fs, codex);
    sessions = sessions.map((s) =>
      s.provider === 'codex' ? { ...s, title: names.get(s.id) ?? null } : s,
    );
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, settings.limit);
}

// --- This machine -----------------------------------------------------------------

async function readChunk(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

export const localHistoryFs: HistoryFs = {
  scope: 'local',
  caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
  join: (...parts) => join(...parts),
  home: async () => homedir(),
  env: async (name) => process.env[name],
  list: async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry): Promise<HistoryDirEntry | null> => {
        if (entry.isDirectory()) {
          return { name: entry.name, isDirectory: true, isFile: false, size: 0, mtimeMs: 0 };
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) return null;
        // stat follows links, so a linked transcript or folder counts as what it points at.
        try {
          const info = await stat(join(dir, entry.name));
          return {
            name: entry.name,
            isDirectory: info.isDirectory(),
            isFile: info.isFile(),
            size: info.size,
            mtimeMs: info.mtimeMs,
          };
        } catch {
          return null; // removed while listing
        }
      }),
    );
    return listed.filter((entry): entry is HistoryDirEntry => entry !== null);
  },
  readRange: readChunk,
  queryDb: async (dbPath, sql, params = []) => {
    const run = (path: string): Record<string, unknown>[] => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return db.prepare(sql).all(...params) as Record<string, unknown>[];
      } finally {
        db.close();
      }
    };
    try {
      return run(dbPath);
    } catch {
      // The CLI may be running and hold the DB in WAL mode; a read-only open
      // can lose that race, so retry against a private copy (WAL sidecars
      // included, without them the copy reads as a stale snapshot).
      const dir = mkdtempSync(join(tmpdir(), 'runova-history-'));
      try {
        const copy = join(dir, 'history.db');
        copyFileSync(dbPath, copy);
        for (const ext of ['-wal', '-shm']) {
          try {
            copyFileSync(dbPath + ext, copy + ext);
          } catch {
            /* no such sidecar */
          }
        }
        return run(copy);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  },
};

/** Past conversations from every supported CLI started in `folder`, newest first. */
export async function listAgentHistory(folder: string): Promise<AgentHistorySession[]> {
  return collectHistory(localHistoryFs, { folder });
}
