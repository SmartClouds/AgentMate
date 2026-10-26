import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FileScanState,
  type LogFile,
  type ScanCache,
  scanLogFile,
  scanProviderLogs,
} from './logParsers';

/**
 * Which folder each run of usage entries came from. Claude Code names the folder through its
 * project directory, and Codex records it on the first line of each rollout. The scan reads only
 * the head of a file for this, and the entries it returns are the same as before.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let root: string;
let now: number;

function claudeLine(cwd: string | null, id: string, at = now - HOUR): string {
  const record = {
    timestamp: new Date(at).toISOString(),
    ...(cwd ? { cwd } : {}),
    message: { id, model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 } },
  };
  return `${JSON.stringify(record)}\n`;
}

function codexMeta(cwd: string): string {
  return `${JSON.stringify({ type: 'session_meta', payload: { id: 'rollout-1', cwd } })}\n`;
}

function codexCount(at = now - HOUR): string {
  const record = {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    },
  };
  return `${JSON.stringify(record)}\n`;
}

function writeFile(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function claudeFile(dirName: string, name: string, content: string): string {
  return writeFile(join(root, 'claude', 'projects', dirName, name), content);
}

function scanClaude(cache: ScanCache = {}) {
  return scanProviderLogs('claude-code', cache, now - 31 * DAY);
}

function scanCodex(cache: ScanCache = {}) {
  return scanProviderLogs('codex', cache, now - 31 * DAY);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runova-log-folders-'));
  now = Date.now();
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Claude Code session folders', () => {
  it('names a project directory after the folder its transcripts were launched in', async () => {
    claudeFile('E--Runova', 'a.jsonl', claudeLine('E:\\Runova\\apps\\desktop', 'm1'));
    claudeFile('E--Runova', 'b.jsonl', claudeLine('E:\\Runova', 'm2'));

    const result = await scanClaude();

    expect(result.entries).toHaveLength(2);
    expect(result.sources).toEqual([{ folder: 'E:\\Runova', count: 2 }]);
  });

  it('reads deeper into a transcript when its first cwd is past the first 32 KB', async () => {
    // Summaries and tool output can push the first cwd far down a long transcript.
    const padding = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ type: 'summary', text: `${i}`.padEnd(1000, 'x') }),
    ).join('\n');
    claudeFile('E--Runova', 'long.jsonl', `${padding}\n${claudeLine('E:\\Runova', 'm1')}`);

    const result = await scanClaude();

    expect(result.sources).toEqual([{ folder: 'E:\\Runova', count: 1 }]);
  });

  it('falls back to the first cwd seen when the directory name matches no folder', async () => {
    // Claude Code shortens very long names with a hash, which the encoding cannot reverse.
    claudeFile(
      'E--a-very-long-project-name-with-a-hash-1f3a',
      'x.jsonl',
      claudeLine('E:\\Runova\\apps', 'm1'),
    );

    const result = await scanClaude();

    expect(result.sources).toEqual([{ folder: 'E:\\Runova\\apps', count: 1 }]);
  });

  it('gives a folder-less transcript a null folder rather than a wrong one', async () => {
    claudeFile('E--Runova', 'nocwd.jsonl', claudeLine(null, 'm1'));

    const result = await scanClaude();

    expect(result.entries).toHaveLength(1);
    expect(result.sources).toEqual([{ folder: null, count: 1 }]);
  });

  it('treats a transcript sitting directly in the projects folder as having no folder', async () => {
    writeFile(join(root, 'claude', 'projects', 'loose.jsonl'), claudeLine('E:\\Runova', 'm1'));

    const result = await scanClaude();

    expect(result.sources).toEqual([{ folder: null, count: 1 }]);
  });

  it("gives a subagent's transcript the folder of its project directory", async () => {
    claudeFile('E--Runova', 'parent.jsonl', claudeLine('E:\\Runova', 'p1', now - 2 * HOUR));
    claudeFile(
      'E--Runova',
      join('session-1', 'subagents', 'agent-1.jsonl'),
      claudeLine('E:\\Runova\\apps', 's1'),
    );

    const result = await scanClaude();

    expect(result.sources?.map((source) => source.folder)).toEqual(['E:\\Runova']);
    expect(result.sources?.reduce((sum, source) => sum + source.count, 0)).toBe(
      result.entries.length,
    );
  });

  it('keeps the runs in step with the entries when two projects are scanned together', async () => {
    claudeFile('E--Runova', 'a.jsonl', claudeLine('E:\\Runova', 'a1'));
    claudeFile('E--Galaxy', 'b.jsonl', claudeLine('E:\\Galaxy', 'b1'));
    claudeFile('E--Galaxy', 'c.jsonl', claudeLine('E:\\Galaxy\\docs', 'b2'));

    const result = await scanClaude();

    const byFolder = new Map(result.sources?.map((source) => [source.folder, source.count]));
    expect(byFolder.get('E:\\Runova')).toBe(1);
    expect(byFolder.get('E:\\Galaxy')).toBe(2);
    expect(result.entries).toHaveLength(3);
  });

  it('leaves the entries themselves free of any folder, so cached entries stay as they were', async () => {
    claudeFile('E--Runova', 'a.jsonl', claudeLine('E:\\Runova', 'a1'));

    const result = await scanClaude();

    expect(result.entries[0]).not.toHaveProperty('cwd');
    expect(Object.values(result.cache)[0]).not.toHaveProperty('cwd');
  });
});

describe('Codex session folders', () => {
  it("reads the folder from a rollout's first line and keeps it in the cache", async () => {
    const file = writeFile(
      join(root, 'codex', 'sessions', '2026', '10', '13', 'rollout.jsonl'),
      codexMeta('E:\\MehrCare') + codexCount() + codexCount(),
    );

    const result = await scanCodex();

    expect(result.sources).toEqual([{ folder: 'E:\\MehrCare', count: 2 }]);
    expect(result.cache[file]).toMatchObject({ cwd: 'E:\\MehrCare', cwdChecked: true });
  });

  it('reads a settled folder from the cache instead of the file', async () => {
    const file = writeFile(
      join(root, 'codex', 'sessions', 'rollout.jsonl'),
      codexMeta('E:\\OnDisk') + codexCount(),
    );
    const info = statSync(file);
    const cached: FileScanState = {
      offset: info.size,
      mtimeMs: info.mtimeMs,
      size: info.size,
      entries: [
        {
          at: now - HOUR,
          model: 'test-model',
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
      cwd: 'E:\\Cached',
      cwdChecked: true,
    };

    const result = await scanCodex({ [file]: cached });

    // The file's own first line says E:\OnDisk, but the folder already settled in the cache wins.
    expect(result.sources).toEqual([{ folder: 'E:\\Cached', count: 1 }]);
  });

  it('does not change the cache it was given, so the caller can keep using it', async () => {
    const file = writeFile(
      join(root, 'codex', 'sessions', 'rollout.jsonl'),
      codexMeta('E:\\MehrCare') + codexCount(),
    );
    const info = statSync(file);
    const given: ScanCache = {
      [file]: { offset: info.size, mtimeMs: info.mtimeMs, size: info.size, entries: [] },
    };

    const result = await scanCodex(given);

    expect(given[file].cwd).toBeUndefined();
    expect(given[file].cwdChecked).toBeUndefined();
    expect(result.cache[file].cwd).toBe('E:\\MehrCare');
  });

  it('waits for the first line to be complete before deciding there is no folder', async () => {
    const path = join(root, 'codex', 'sessions', 'rollout.jsonl');
    // The rollout was created a moment ago: its first line has no newline yet.
    writeFile(path, codexMeta('E:\\MehrCare').slice(0, 20));
    const first = await scanCodex();

    expect(first.cache[path].cwdChecked).toBeUndefined();

    writeFileSync(path, codexMeta('E:\\MehrCare') + codexCount(), 'utf-8');
    const second = await scanCodex(first.cache);

    expect(second.cache[path]).toMatchObject({ cwd: 'E:\\MehrCare', cwdChecked: true });
    expect(second.sources).toEqual([{ folder: 'E:\\MehrCare', count: 1 }]);
  });

  it('leaves the folder empty for a rollout whose first line names none', async () => {
    writeFile(
      join(root, 'codex', 'sessions', 'nofolder.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'x' } })}\n${codexCount()}`,
    );

    const result = await scanCodex();

    expect(result.sources).toEqual([{ folder: null, count: 1 }]);
  });
});

describe('scanLogFile', () => {
  it('still hands back the very same state for a file that has not changed', async () => {
    const path = claudeFile('E--Runova', 'a.jsonl', claudeLine('E:\\Runova', 'a1'));
    const info = statSync(path);
    const log: LogFile = { path, mtimeMs: info.mtimeMs, size: info.size };
    const first = await scanLogFile('claude-code', log, undefined);
    if (!first) throw new Error('the file should have been read');

    const again = await scanLogFile('claude-code', log, first);

    expect(again).toBe(first);
    expect(again).not.toHaveProperty('cwd');
  });
});
