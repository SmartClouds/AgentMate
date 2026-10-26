import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODEX_LOG_FALLBACK_MODEL,
  COPILOT_LOG_FALLBACK_MODEL,
  GEMINI_LOG_FALLBACK_MODEL,
} from '@runova/core';
import { codexCwdFromHead, cwdsIn, launchFolder, topLevelDir } from './sessionFolders';

// Parsing for the local-log usage providers (Claude Code, Codex, Copilot, Gemini
// CLI). Deliberately free of any `electron` import so this module can be loaded
// both by the main process and by the scan worker thread.
//
// Session logs are append-only JSONL and get big, a few hundred MB of Claude
// transcripts is normal. So we never re-read a file we've already seen: each
// file's byte offset and the token events extracted from it are cached, and a
// rescan only streams the bytes appended since last time.

const DAY_MS = 86_400_000;

/** Retention horizon for token events (a day of slack over the 30d we report). */
export function retentionSinceMs(): number {
  return Date.now() - 31 * DAY_MS;
}

/** One token event, as plain JSON so it survives structured-clone + disk cache. */
export interface RawUsageEntry {
  /** Epoch ms. */
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider message id when the log has one; used to dedupe across files. */
  id?: string;
}

/** A quota snapshot plus when it was observed, so newer ones win. */
export interface RawWindow {
  label: string;
  used: number;
  total: number;
  percent: number;
  resetAt: string | null;
  at: number;
}

/** One rolling limit from a Codex rate-limit snapshot. */
export interface RawLimit {
  /** How long the window runs (300 for the 5h session, 10080 for a week). */
  minutes: number | null;
  /** 0-100 consumed. */
  percent: number;
  resetAt: string | null;
}

/** Every rolling limit Codex reported in one snapshot, plus the plan it named. */
export interface RawLimits {
  windows: RawLimit[];
  planType: string | null;
  at: number;
}

/** Everything we remember about one already-parsed log file. */
export interface FileScanState {
  /** Bytes consumed so far, always landing on a line boundary. */
  offset: number;
  mtimeMs: number;
  size: number;
  /** Carry-over parser state (Codex's current model) across a resumed read. */
  model?: string;
  entries: RawUsageEntry[];
  window?: RawWindow;
  limits?: RawLimits;
  /** The folder a Codex rollout started in, read from its first lines. */
  cwd?: string;
  /** True once a Codex rollout's first lines were read, so a folder-less one is not read again. */
  cwdChecked?: boolean;
}

/** Scan cache for one provider, keyed by absolute file path. */
export type ScanCache = Record<string, FileScanState>;

/** A run of consecutive entries that came from one session folder. */
export interface ScanSource {
  /** The folder the sessions ran in, or null when the log does not say. */
  folder: string | null;
  count: number;
}

export interface ScanResult {
  entries: RawUsageEntry[];
  window?: RawWindow;
  /** The newest full rate-limit snapshot (Codex only). */
  limits?: RawLimits;
  /** The cache to persist for the next scan. */
  cache: ScanCache;
  /** Which folder each run of `entries` came from. The runs add up to `entries.length`, in order. */
  sources?: ScanSource[];
}

export type LocalLogProvider = 'claude-code' | 'codex' | 'copilot' | 'gemini-cli';

// --- file discovery -------------------------------------------------------

export interface LogFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Recursively collect `*.jsonl` files under `root`, skipping any whose mtime is
 * older than `sinceMs`. A file untouched for over a month cannot hold an event
 * inside our retention horizon. A missing root resolves to an empty list.
 */
export async function collectLogFiles(root: string, sinceMs: number): Promise<LogFile[]> {
  const out: LogFile[] = [];
  async function recur(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist / not readable
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await recur(full);
      } else if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
        try {
          const info = await stat(full);
          if (info.mtimeMs >= sinceMs) {
            out.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
          }
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  await recur(root);
  return out;
}

/**
 * Stream `file` from `fromOffset`, handing each complete line to `onLine`, and
 * return the new byte offset. A trailing partial line (the CLI was mid-write)
 * is left unconsumed so the next scan picks it up whole.
 */
async function readNewLines(
  file: string,
  fromOffset: number,
  onLine: (line: string) => void,
): Promise<number> {
  let consumed = fromOffset;
  let pending = '';
  // setEncoding lets the stream, not us, deal with multi-byte characters that
  // straddle a chunk boundary.
  const stream = createReadStream(file, { start: fromOffset, encoding: 'utf-8' });
  for await (const chunk of stream) {
    pending += chunk as string;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      consumed += Buffer.byteLength(line, 'utf-8') + 1;
      onLine(line);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
  }
  return consumed;
}

// --- Claude Code ----------------------------------------------------------

// Claude Code writes one JSONL file per session under its config dir. Assistant
// lines carry `message.model` + `message.usage` with input/output and the two
// cache token counters. `CLAUDE_CONFIG_DIR` overrides the location; otherwise we
// check the two well-known homes.
function claudeRoots(): string[] {
  const roots: string[] = [];
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) roots.push(join(override, 'projects'));
  roots.push(join(homedir(), '.claude', 'projects'));
  roots.push(join(homedir(), '.config', 'claude', 'projects'));
  return roots;
}

interface ClaudeLine {
  timestamp?: string;
  message?: {
    model?: string;
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function parseClaudeLine(line: string, state: FileScanState): void {
  // Cheap substring reject before paying for JSON.parse. Most transcript lines
  // are user/tool records with no usage block at all.
  if (!line.includes('"usage"')) return;
  let parsed: ClaudeLine;
  try {
    parsed = JSON.parse(line) as ClaudeLine;
  } catch {
    return;
  }
  const usage = parsed.message?.usage;
  const model = parsed.message?.model;
  const ts = parsed.timestamp;
  if (!usage || !model || !ts) return;

  const at = new Date(ts).getTime();
  if (Number.isNaN(at)) return;

  state.entries.push({
    at,
    model,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    id: parsed.message?.id,
  });
}

// --- Codex ----------------------------------------------------------------

// Codex writes rollout JSONL under `~/.codex/sessions/<yyyy>/<mm>/<dd>/`.
// `turn_context` lines carry the active `model`; `event_msg` lines with
// `payload.type === 'token_count'` carry per-turn token deltas in
// `info.last_token_usage`, plus a `rate_limits` object we surface as the quota
// window. `CODEX_HOME` overrides the base dir.
function codexRoots(): string[] {
  const base = process.env.CODEX_HOME || join(homedir(), '.codex');
  return [join(base, 'sessions')];
}

interface CodexTokenBreakdown {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // unix seconds
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: { last_token_usage?: CodexTokenBreakdown; total_token_usage?: CodexTokenBreakdown };
    rate_limits?: {
      primary?: CodexRateLimitWindow | null;
      secondary?: CodexRateLimitWindow | null;
      plan_type?: string | null;
    } | null;
  };
}

function windowFromRateLimit(
  rl: CodexRateLimitWindow,
  label: string,
  at: number,
): RawWindow | null {
  if (typeof rl.used_percent !== 'number') return null;
  return {
    label,
    used: Math.round(rl.used_percent),
    total: 100,
    percent: Math.max(0, Math.min(100, rl.used_percent)),
    resetAt: rl.resets_at ? new Date(rl.resets_at * 1000).toISOString() : null,
    at,
  };
}

function limitFromRateLimit(rl: CodexRateLimitWindow | null | undefined): RawLimit | null {
  if (!rl || typeof rl.used_percent !== 'number') return null;
  return {
    minutes: typeof rl.window_minutes === 'number' ? rl.window_minutes : null,
    percent: Math.max(0, Math.min(100, rl.used_percent)),
    resetAt: rl.resets_at ? new Date(rl.resets_at * 1000).toISOString() : null,
  };
}

function parseCodexLine(line: string, state: FileScanState): void {
  if (!line) return;
  let parsed: CodexLine;
  try {
    parsed = JSON.parse(line) as CodexLine;
  } catch {
    return;
  }
  const payload = parsed.payload;
  if (!payload) return;

  // Model is set on turn_context lines and applies to the token_count events
  // that follow it within the same session file.
  if (payload.model) state.model = payload.model;
  if (payload.type !== 'token_count') return;

  const at = parsed.timestamp ? new Date(parsed.timestamp).getTime() : NaN;
  if (Number.isNaN(at)) return;

  // Prefer the per-turn delta; it's what makes daily bucketing correct.
  const delta = payload.info?.last_token_usage;
  if (delta) {
    const input = delta.input_tokens ?? 0;
    const cached = delta.cached_input_tokens ?? 0;
    // `reasoning_output_tokens` is a share of `output_tokens`, not on top of it: every logged
    // turn has total_tokens = input_tokens + output_tokens. Adding it again counted it twice.
    const output = delta.output_tokens ?? 0;
    if (input + cached + output > 0) {
      state.entries.push({
        at,
        model: state.model ?? CODEX_LOG_FALLBACK_MODEL,
        // Codex's input_tokens already includes cached; split so we don't
        // double-count in the total.
        input: Math.max(0, input - cached),
        output,
        cacheRead: cached,
        cacheWrite: 0,
      });
    }
  }

  const primary = payload.rate_limits?.primary;
  if (primary && (!state.window || at > state.window.at)) {
    const w = windowFromRateLimit(primary, 'Quota', at);
    if (w) state.window = w;
  }

  // The whole snapshot, for the plan's limits: a ChatGPT plan reports a 5h
  // session and a weekly window, a free one a single 30-day window.
  const rateLimits = payload.rate_limits;
  if (rateLimits && (!state.limits || at > state.limits.at)) {
    const windows = [rateLimits.primary, rateLimits.secondary].flatMap((rl) => {
      const limit = limitFromRateLimit(rl);
      return limit ? [limit] : [];
    });
    if (windows.length > 0) {
      state.limits = { windows, planType: rateLimits.plan_type ?? null, at };
    }
  }
}

// --- Copilot ---------------------------------------------------------------

// The Copilot CLI persists every session as `~/.copilot/session-state/<id>/events.jsonl`
// (see "About GitHub Copilot CLI session data" in the GitHub docs): one
// `{type, data, timestamp}` event per line. Token counts live on `session.usage_record`
// events in `data.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`,
// `cacheWriteTokens`, plus the model that served them). `reasoningTokens` is a share of
// `outputTokens`, not on top of it, so it is never added again. `session.start` names the
// folder the session ran in (`data.context.cwd`), and `session.model_change` tracks the
// active model for records that do not name one. `COPILOT_HOME` is the CLI's own
// documented override; otherwise the default home is read.
function copilotRoots(): string[] {
  const roots: string[] = [];
  const home = process.env.COPILOT_HOME || process.env.COPILOT_CONFIG_DIR;
  if (home) roots.push(join(home, 'session-state'));
  roots.push(join(homedir(), '.copilot', 'session-state'));
  return roots;
}

interface CopilotUsageRecord {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface CopilotEvent {
  type?: string;
  id?: string;
  timestamp?: string;
  data?: {
    context?: { cwd?: string };
    newModel?: string;
    usage?: CopilotUsageRecord;
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * One Copilot token event from a `session.usage_record` transcript line, or null when the
 * line is not one. Pure (no state) so the Copilot usage tests can pin the real event shape
 * without touching the disk. `model` is the session's active model, used only when the
 * record itself does not name one.
 */
export function parseCopilotUsageRecord(line: string, model?: string): RawUsageEntry | null {
  let parsed: CopilotEvent;
  try {
    parsed = JSON.parse(line) as CopilotEvent;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'session.usage_record') return null;
  const usage = parsed.data?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite <= 0) return null;

  const at = parsed.timestamp ? new Date(parsed.timestamp).getTime() : NaN;
  if (Number.isNaN(at)) return null;

  return {
    at,
    model: usage.model ?? model ?? COPILOT_LOG_FALLBACK_MODEL,
    input,
    output,
    cacheRead,
    cacheWrite,
    id: parsed.id,
  };
}

function parseCopilotStateLine(line: string, state: FileScanState): void {
  // Cheap substring reject before paying for JSON.parse. Usage records are rare next to
  // the tool-call chatter, so most lines are skipped here.
  if (
    !line.includes('session.usage_record') &&
    !line.includes('session.model_change') &&
    !line.includes('session.start')
  ) {
    return;
  }
  let parsed: CopilotEvent;
  try {
    parsed = JSON.parse(line) as CopilotEvent;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  // Model is set on model_change lines and applies to the usage records that follow it
  // within the same session file.
  if (parsed.type === 'session.model_change' && typeof parsed.data?.newModel === 'string') {
    state.model = parsed.data.newModel;
    return;
  }
  // The folder the session ran in, read from its first lines. Kept on the state (which the
  // driver persists) so later scans of an appended file don't need it again.
  if (parsed.type === 'session.start') {
    const cwd = parsed.data?.context?.cwd;
    if (typeof cwd === 'string' && cwd && !state.cwd) state.cwd = cwd;
    return;
  }
  if (parsed.type === 'session.usage_record') {
    const entry = parseCopilotUsageRecord(line, state.model);
    if (entry) state.entries.push(entry);
  }
}

// --- Gemini CLI ------------------------------------------------------------

// Gemini CLI keeps one JSONL chat per session under `~/.gemini/tmp/<hash>/chats/`
// (`session-*.jsonl`), with a `.project_root` sidecar per hash naming the folder
// the sessions ran in. `GEMINI_HOME` overrides the home dir; otherwise the
// default home is read.
//
// The files logged today carry only user prompts and context: no token counts.
// The parser therefore reads the Gemini API's own `usageMetadata` vocabulary
// (plus a generic `tokens` object) whenever a record carries one, and otherwise
// contributes nothing, so the card stays at zero until the CLI persists token
// usage. `thoughtsTokenCount` is a share of the candidates total, not on top of
// it, so it is never added again (same rule as Codex reasoning tokens).
function geminiRoots(): string[] {
  const roots: string[] = [];
  const home = process.env.GEMINI_HOME;
  if (home) roots.push(join(home, 'tmp'));
  roots.push(join(homedir(), '.gemini', 'tmp'));
  return roots;
}

interface GeminiUsageMetadata {
  promptTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
}

interface GeminiTokenObject {
  inputTokens?: unknown;
  input_tokens?: unknown;
  input?: unknown;
  outputTokens?: unknown;
  output_tokens?: unknown;
  output?: unknown;
  cacheReadTokens?: unknown;
  cache_read_input_tokens?: unknown;
  cacheRead?: unknown;
  cacheWriteTokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cacheWrite?: unknown;
}

function geminiCounts(
  metadata: unknown,
  tokens: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (metadata && typeof metadata === 'object') {
    const usage = metadata as GeminiUsageMetadata;
    const prompt = num(usage.promptTokenCount);
    const cached = num(usage.cachedContentTokenCount);
    const candidates = num(usage.candidatesTokenCount);
    if (prompt + candidates <= 0) return null;
    // The prompt count already includes the cached ones; split so the total
    // does not count them twice.
    const cacheRead = Math.min(cached, prompt);
    return { input: Math.max(0, prompt - cacheRead), output: candidates, cacheRead, cacheWrite: 0 };
  }
  if (tokens && typeof tokens === 'object') {
    const slice = tokens as GeminiTokenObject;
    const input = num(slice.inputTokens ?? slice.input_tokens ?? slice.input);
    const output = num(slice.outputTokens ?? slice.output_tokens ?? slice.output);
    const cacheRead = num(
      slice.cacheReadTokens ?? slice.cache_read_input_tokens ?? slice.cacheRead,
    );
    const cacheWrite = num(
      slice.cacheWriteTokens ?? slice.cache_creation_input_tokens ?? slice.cacheWrite,
    );
    if (input + output + cacheRead + cacheWrite <= 0) return null;
    return { input, output, cacheRead, cacheWrite };
  }
  return null;
}

function geminiTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * One Gemini CLI token event from a usage-bearing record, or null when the
 * record carries no token payload. Pure (no state) so the usage tests can pin
 * the shape without touching the disk. `fallbackAt` dates records that name no
 * time of their own; `fallbackModel` names the session's model when the record
 * does not.
 */
export function parseGeminiUsageRecord(
  record: Record<string, unknown>,
  fallbackAt: number | null,
  fallbackModel?: string,
): RawUsageEntry | null {
  const counts = geminiCounts(record.usageMetadata, record.tokens);
  if (!counts) return null;
  const at = geminiTime(record.timestamp) ?? fallbackAt;
  if (at == null || Number.isNaN(at)) return null;
  const model =
    typeof record.model === 'string' && record.model
      ? record.model
      : typeof fallbackModel === 'string' && fallbackModel
        ? fallbackModel
        : GEMINI_LOG_FALLBACK_MODEL;
  const entry: RawUsageEntry = { at, model, ...counts };
  if (typeof record.id === 'string' && record.id) entry.id = record.id;
  return entry;
}

function parseGeminiLine(line: string, state: FileScanState): void {
  // Cheap substring reject before paying for JSON.parse. Session files are
  // mostly user prompts and context dumps with no token payload at all.
  if (!line.includes('usageMetadata') && !line.includes('tokens')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const record = parsed as Record<string, unknown>;
  const lineAt = geminiTime(record.timestamp ?? record.lastUpdated);
  const lineModel = typeof record.model === 'string' ? record.model : undefined;

  // A usage event on the line itself.
  const direct = parseGeminiUsageRecord(record, lineAt, lineModel);
  if (direct) state.entries.push(direct);

  // ...or batched inside the file's message list, one token-bearing message at
  // a time. Each entry keeps its message id, so a batch repeated across lines
  // dedupes to one event downstream.
  const set = record.$set as { messages?: unknown } | undefined;
  const batches: unknown[] = [
    ...(Array.isArray(set?.messages) ? set.messages : []),
    ...(Array.isArray(record.messages) ? (record.messages as unknown[]) : []),
  ];
  for (const item of batches) {
    if (!item || typeof item !== 'object') continue;
    const entry = parseGeminiUsageRecord(item as Record<string, unknown>, lineAt, lineModel);
    if (entry) state.entries.push(entry);
  }
}

/**
 * The folder a Gemini CLI chat ran in, from the `.project_root` sidecar next
 * to its `chats/` directory. Null when the sidecar is missing, so the entries
 * still count, just without a project split.
 */
async function geminiFolder(filePath: string): Promise<string | null> {
  // `<tmp>/<hash>/chats/session-*.jsonl` → `<tmp>/<hash>/.project_root`
  const sidecar = join(dirname(dirname(filePath)), '.project_root');
  try {
    const text = (await readFile(sidecar, 'utf-8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- driver ---------------------------------------------------------------

const PARSERS: Record<
  LocalLogProvider,
  { roots: () => string[]; line: (line: string, state: FileScanState) => void }
> = {
  'claude-code': { roots: claudeRoots, line: parseClaudeLine },
  codex: { roots: codexRoots, line: parseCodexLine },
  copilot: { roots: copilotRoots, line: parseCopilotStateLine },
  'gemini-cli': { roots: geminiRoots, line: parseGeminiLine },
};

/**
 * Bring one file's scan state up to date: untouched since `prev` reuses it as is, a file that
 * only grew streams just the appended bytes, and a new or truncated one is read from the start.
 * Null when the file cannot be read (gone mid-scan), so the caller can skip it.
 */
export async function scanLogFile(
  provider: LocalLogProvider,
  file: LogFile,
  prev: FileScanState | undefined,
): Promise<FileScanState | null> {
  if (prev && prev.mtimeMs === file.mtimeMs && prev.size === file.size) return prev;
  const resumable = prev !== undefined && file.size >= prev.offset ? prev : null;
  const state: FileScanState = resumable
    ? { ...resumable, mtimeMs: file.mtimeMs, size: file.size }
    : { offset: 0, mtimeMs: file.mtimeMs, size: file.size, entries: [] };
  try {
    state.offset = await readNewLines(file.path, resumable?.offset ?? 0, (l) =>
      PARSERS[provider].line(l, state),
    );
  } catch {
    return null;
  }
  return state;
}

// --- session folders -------------------------------------------------------

// A head read takes the first 32 KB, which holds the folder of nearly every transcript. A file
// whose first lines hold none gets one more read, up to 256 KB.
const HEAD_BYTES = 32 * 1024;
const HEAD_MAX_BYTES = 256 * 1024;
/** How many of a Claude Code project directory's newest transcripts are read to name its folder. */
const SAMPLE_FILES = 3;
/** How many distinct cwds a project directory's samples keep. */
const SAMPLE_CWDS = 50;

/**
 * The whole lines at the start of `path`, reading at most `maxBytes`. Text after the last newline
 * may still be being written, so it is left out.
 */
async function readHeadLines(path: string, maxBytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const pieces = buffer.toString('utf-8', 0, bytesRead).split('\n');
    pieces.pop();
    return pieces.map((line) => line.replace(/\r$/, ''));
  } finally {
    await handle.close();
  }
}

/**
 * The folder every transcript in each Claude Code project directory was launched in. The
 * directory name is that folder encoded, and the cwds in a few of its newest transcripts settle
 * its spelling, so this costs a handful of small reads per directory. Falls back to the first cwd
 * seen when no encoding matches, which happens for names Claude shortened.
 */
async function claudeLaunchFolders(
  found: readonly { root: string; file: LogFile }[],
): Promise<Map<string, string | null>> {
  const byDir = new Map<string, LogFile[]>();
  for (const { root, file } of found) {
    const dir = topLevelDir(root, file.path);
    if (dir) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }

  const folders = new Map<string, string | null>();
  for (const [dir, files] of byDir) {
    const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, SAMPLE_FILES);
    const cwds: string[] = [];
    let folder: string | null = null;
    for (const file of newest) {
      try {
        let lines = await readHeadLines(file.path, HEAD_BYTES);
        if (cwdsIn(lines).length === 0 && file.size > HEAD_BYTES) {
          lines = await readHeadLines(file.path, HEAD_MAX_BYTES);
        }
        for (const cwd of cwdsIn(lines, SAMPLE_CWDS)) {
          if (cwds.length < SAMPLE_CWDS && !cwds.includes(cwd)) cwds.push(cwd);
        }
      } catch {
        continue; // vanished or unreadable: the next sample may still name the folder
      }
      folder = launchFolder(dir, cwds);
      if (folder) break;
    }
    folders.set(dir, folder ?? cwds[0] ?? null);
  }
  return folders;
}

/**
 * The folder a Codex rollout started in. `checked` stays false while no complete line exists yet,
 * because the rollout was only just created and the next scan should look again.
 */
async function codexFolder(file: LogFile): Promise<{ cwd: string | null; checked: boolean }> {
  let lines = await readHeadLines(file.path, HEAD_BYTES);
  let cwd = codexCwdFromHead(lines);
  if (!cwd && file.size > HEAD_BYTES) {
    lines = await readHeadLines(file.path, HEAD_MAX_BYTES);
    cwd = codexCwdFromHead(lines);
  }
  return { cwd, checked: lines.length > 0 };
}

/** The state with its Codex folder filled in. A copy, so the cache the caller passed in is left alone. */
async function withCodexFolder(state: FileScanState, file: LogFile): Promise<FileScanState> {
  try {
    const { cwd, checked } = await codexFolder(file);
    if (!checked) return state;
    return cwd ? { ...state, cwd, cwdChecked: true } : { ...state, cwdChecked: true };
  } catch {
    return state;
  }
}

function pushSource(sources: ScanSource[], folder: string | null, count: number): void {
  const last = sources[sources.length - 1];
  if (last && last.folder === folder) last.count += count;
  else sources.push({ folder, count });
}

/**
 * Scan a provider's logs, reusing `cache` so only newly-appended bytes are read.
 * Returns the merged entries, the newest quota window, the folder of each run of entries, and the
 * cache to persist.
 */
export async function scanProviderLogs(
  provider: LocalLogProvider,
  cache: ScanCache,
  sinceMs: number,
): Promise<ScanResult> {
  const parser = PARSERS[provider];
  const next: ScanCache = {};
  const entries: RawUsageEntry[] = [];
  const sources: ScanSource[] = [];
  let window: RawWindow | undefined;
  let limits: RawLimits | undefined;

  const found: { root: string; file: LogFile }[] = [];
  for (const root of parser.roots()) {
    for (const file of await collectLogFiles(root, sinceMs)) found.push({ root, file });
  }
  const claudeFolders =
    provider === 'claude-code'
      ? await claudeLaunchFolders(found)
      : new Map<string, string | null>();

  for (const { root, file } of found) {
    // Unreadable / vanished mid-scan: skip it rather than fail the whole scan.
    let state = await scanLogFile(provider, file, cache[file.path]);
    if (!state) continue;

    let folder: string | null = null;
    if (provider === 'claude-code') {
      const dir = topLevelDir(root, file.path);
      folder = dir ? (claudeFolders.get(dir) ?? null) : null;
    } else if (provider === 'gemini-cli') {
      folder = await geminiFolder(file.path);
    } else {
      if (!state.cwdChecked) state = await withCodexFolder(state, file);
      folder = state.cwd ?? null;
    }

    // Keep the cache bounded: events past the retention horizon can never be
    // reported again, so drop them rather than carry them forever.
    state.entries = state.entries.filter((e) => e.at >= sinceMs);
    next[file.path] = state;

    for (const entry of state.entries) entries.push(entry);
    if (state.entries.length > 0) pushSource(sources, folder, state.entries.length);
    if (state.window && (!window || state.window.at > window.at)) window = state.window;
    if (state.limits && (!limits || state.limits.at > limits.at)) limits = state.limits;
  }

  return { entries, window, limits, cache: next, sources };
}
