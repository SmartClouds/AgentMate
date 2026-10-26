import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app } from 'electron';
import type { SkillUsageProject, SkillUsageReport, SkillUsageStat } from '../../shared/apiTypes';
import { store } from '../store';

// Which skills an agent actually reached for, counted straight out of its session transcripts.
// Claude Code logs every skill invocation as a `Skill` tool_use block, so the count is what the
// agent did rather than what Runova installed.
//
// Transcripts are append-only JSONL and grow into the hundreds of MB, so this follows the same
// rule as the token-usage scanner: a file is never re-read. Each file's byte offset and the
// invocations found in it are cached on disk, and a rescan only streams the appended bytes.

const DAY_MS = 86_400_000;

/** One skill invocation, as plain JSON so it survives the disk cache. */
interface UsageEvent {
  skill: string;
  /** Epoch ms. */
  at: number;
}

/** Everything remembered about one already-parsed transcript. */
interface FileState {
  /** Bytes consumed so far, always landing on a line boundary. */
  offset: number;
  mtimeMs: number;
  size: number;
  /** Working directory the session ran in, taken from the first line that carries one. */
  cwd?: string;
  events: UsageEvent[];
}

interface UsageCache {
  version: number;
  /** Keyed by absolute transcript path. */
  files: Record<string, FileState>;
}

const CACHE_VERSION = 1;
const CACHE_FILE = 'skill-usage-cache.json';

function cachePath(): string {
  return join(app.getPath('userData'), 'data', CACHE_FILE);
}

/**
 * Where Claude Code keeps its session transcripts. `CLAUDE_CONFIG_DIR` overrides the location;
 * otherwise both well-known homes are checked, since either can be the live one.
 */
function transcriptRoots(): string[] {
  const roots: string[] = [];
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) roots.push(join(override, 'projects'));
  roots.push(join(homedir(), '.claude', 'projects'));
  roots.push(join(homedir(), '.config', 'claude', 'projects'));
  return [...new Set(roots)];
}

interface TranscriptFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Every `*.jsonl` under `root`, recursively. A missing root resolves to an empty list. */
async function collectTranscripts(root: string): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  async function recur(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await recur(full);
      } else if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
        try {
          const info = await stat(full);
          out.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
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
 * Stream `file` from `fromOffset`, handing each complete line to `onLine`, and return the new
 * offset. A trailing partial line (the CLI was mid-write) is left for the next scan to pick up
 * whole.
 */
async function readNewLines(
  file: string,
  fromOffset: number,
  onLine: (line: string) => void,
): Promise<number> {
  let consumed = fromOffset;
  let pending = '';
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

interface TranscriptLine {
  timestamp?: string;
  cwd?: string;
  message?: {
    content?: unknown;
  };
}

/** Pulls the session's working directory out of a raw line without parsing the whole record. */
const CWD_PATTERN = /"cwd":"((?:[^"\\]|\\.)*)"/;

/** A `Skill` tool_use block, which is how Claude Code records an invocation. */
function skillFromBlock(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null;
  const record = block as { type?: string; name?: string; input?: { skill?: unknown } };
  if (record.type !== 'tool_use' || record.name !== 'Skill') return null;
  const skill = record.input?.skill;
  return typeof skill === 'string' && skill.trim() !== '' ? skill.trim() : null;
}

function parseLine(line: string, state: FileState): void {
  // The session's folder is read off the first line that carries one, by regex rather than a
  // full parse: every line has a cwd, and only a handful hold a skill call.
  if (!state.cwd) {
    const match = CWD_PATTERN.exec(line);
    if (match) {
      try {
        const cwd = JSON.parse(`"${match[1]}"`) as string;
        if (cwd) state.cwd = cwd;
      } catch {
        /* malformed escape, try the next line */
      }
    }
  }

  // Cheap substring reject before paying for JSON.parse. Almost every transcript line is a
  // message or a different tool call, and a skill invocation always names the tool.
  if (!line.includes('"Skill"')) return;

  let parsed: TranscriptLine;
  try {
    parsed = JSON.parse(line) as TranscriptLine;
  } catch {
    return;
  }

  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  const at = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Number.NaN;
  if (Number.isNaN(at)) return;

  for (const block of content) {
    const skill = skillFromBlock(block);
    if (skill) state.events.push({ skill, at });
  }
}

async function readCache(): Promise<UsageCache> {
  try {
    const raw = await readFile(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as UsageCache;
    if (parsed.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    /* absent or unreadable: start over */
  }
  return { version: CACHE_VERSION, files: {} };
}

async function writeCache(cache: UsageCache): Promise<void> {
  const target = cachePath();
  await mkdir(join(app.getPath('userData'), 'data'), { recursive: true });
  // Write beside the real file and swap it in, so a crash mid-write cannot leave half a cache
  // behind (a truncated one would silently re-read every transcript).
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), 'utf-8');
  await rename(tmp, target);
}

/** Folder name, or the Runova project's name when one points at the same folder. */
function projectLabel(path: string, projectNames: Map<string, string>): string {
  return projectNames.get(path.toLowerCase()) ?? basename(path) ?? path;
}

/** How many days of daily counts the Usage tab charts. */
const TREND_DAYS = 30;

/** Local midnight for a timestamp, so a day bucket matches the calendar the user reads. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

interface SkillTotals {
  count: number;
  count7d: number;
  count30d: number;
  first: number;
  last: number;
  /** One slot per day of the trend window, oldest first. */
  daily: number[];
}

function buildReport(
  cache: UsageCache,
  roots: string[],
  projectNames: Map<string, string>,
): SkillUsageReport {
  const now = Date.now();
  const today = startOfDay(now);
  const days = Array.from({ length: TREND_DAYS }, (_, i) =>
    dayKey(today - (TREND_DAYS - 1 - i) * DAY_MS),
  );
  const dailyTotals = new Array<number>(TREND_DAYS).fill(0);

  const bySkill = new Map<string, SkillTotals>();
  // skill -> cwd -> count
  const byProject = new Map<string, Map<string, number>>();
  let total = 0;

  for (const state of Object.values(cache.files)) {
    for (const event of state.events) {
      total += 1;
      const current = bySkill.get(event.skill) ?? {
        count: 0,
        count7d: 0,
        count30d: 0,
        first: event.at,
        last: event.at,
        daily: new Array<number>(TREND_DAYS).fill(0),
      };
      current.count += 1;
      if (now - event.at <= 7 * DAY_MS) current.count7d += 1;
      if (now - event.at <= 30 * DAY_MS) current.count30d += 1;
      current.first = Math.min(current.first, event.at);
      current.last = Math.max(current.last, event.at);

      // Anything older than the window, or stamped in the future by a clock skew, is counted in
      // the totals but sits outside the trend.
      const slot = TREND_DAYS - 1 - Math.round((today - startOfDay(event.at)) / DAY_MS);
      if (slot >= 0 && slot < TREND_DAYS) {
        current.daily[slot] += 1;
        dailyTotals[slot] += 1;
      }
      bySkill.set(event.skill, current);

      if (state.cwd) {
        const projects = byProject.get(event.skill) ?? new Map<string, number>();
        projects.set(state.cwd, (projects.get(state.cwd) ?? 0) + 1);
        byProject.set(event.skill, projects);
      }
    }
  }

  const stats: SkillUsageStat[] = [...bySkill.entries()]
    .map(([skill, totals]) => {
      const projects: SkillUsageProject[] = [...(byProject.get(skill) ?? new Map())]
        .map(([path, count]) => ({ path, label: projectLabel(path, projectNames), count }))
        .sort((a, b) => b.count - a.count);
      return {
        skill,
        count: totals.count,
        count7d: totals.count7d,
        count30d: totals.count30d,
        firstUsedAt: new Date(totals.first).toISOString(),
        lastUsedAt: new Date(totals.last).toISOString(),
        projects,
        daily: totals.daily,
      };
    })
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));

  return {
    stats,
    totalInvocations: total,
    days,
    dailyTotals,
    filesScanned: Object.keys(cache.files).length,
    sourceRoots: roots,
    scannedAt: new Date().toISOString(),
  };
}

let inFlight: Promise<SkillUsageReport> | null = null;

async function runScan(): Promise<SkillUsageReport> {
  const cache = await readCache();
  const next: UsageCache = { version: CACHE_VERSION, files: {} };
  const rootsWithFiles: string[] = [];

  for (const root of transcriptRoots()) {
    const files = await collectTranscripts(root);
    if (files.length > 0) rootsWithFiles.push(root);
    for (const file of files) {
      const cached = cache.files[file.path];
      // Unchanged since the last scan: reuse what was parsed then.
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        next.files[file.path] = cached;
        continue;
      }
      // A file that shrank was rotated or rewritten, so its offset means nothing any more.
      const resumable = cached && file.size >= cached.offset;
      const state: FileState = resumable
        ? { ...cached, mtimeMs: file.mtimeMs, size: file.size, events: [...cached.events] }
        : { offset: 0, mtimeMs: file.mtimeMs, size: file.size, events: [] };
      try {
        state.offset = await readNewLines(file.path, state.offset, (line) =>
          parseLine(line, state),
        );
      } catch {
        // Unreadable right now (locked, deleted mid-scan). Keep whatever was cached.
        if (!cached) continue;
      }
      next.files[file.path] = state;
    }
  }

  await writeCache(next);

  const projects = await store.getProjects();
  const projectNames = new Map(projects.map((p) => [p.folderPath.toLowerCase(), p.name]));
  return buildReport(next, rootsWithFiles, projectNames);
}

/**
 * Aggregated skill usage. Concurrent callers share one scan, since the whole cost is streaming
 * the same transcripts.
 */
export function getSkillUsage(): Promise<SkillUsageReport> {
  inFlight ??= runScan().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Throws the cache away and re-reads every transcript from byte zero. */
export async function rescanSkillUsage(): Promise<SkillUsageReport> {
  await rm(cachePath(), { force: true });
  inFlight = null;
  return getSkillUsage();
}
