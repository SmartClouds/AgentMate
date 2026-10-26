import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDaily } from '@runova/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-project split that the Usage page's chart reads, built by the local scanner from the
 * folders the transcripts name. The totals above it must not depend on it.
 */

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));
vi.mock('./claudeAccount', () => ({
  readClaudeAccount: async () => ({ mode: 'api' }),
  getLiveWindows: async () => null,
}));

const failure = vi.hoisted(() => ({ fail: false }));
vi.mock('./projectDaily', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectDaily')>();
  return {
    ...actual,
    buildProjectDaily: (...args: Parameters<typeof actual.buildProjectDaily>) => {
      if (failure.fail) throw new Error('split broke');
      return actual.buildProjectDaily(...args);
    },
  };
});

const HOUR_MS = 3_600_000;
let root: string;
let now: number;

function claudeLine(cwd: string, id: string, input = 1000): string {
  const record = {
    timestamp: new Date(now - HOUR_MS).toISOString(),
    cwd,
    message: { id, model: 'test-model', usage: { input_tokens: input, output_tokens: 0 } },
  };
  return `${JSON.stringify(record)}\n`;
}

function codexRollout(cwd: string, input = 100): string {
  const meta = { type: 'session_meta', payload: { id: `rollout-${cwd}`, cwd } };
  const count = {
    timestamp: new Date(now - HOUR_MS).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 } },
    },
  };
  return `${JSON.stringify(meta)}\n${JSON.stringify(count)}\n`;
}

function writeTranscript(relative: string, content: string): void {
  const path = join(root, 'claude', 'projects', relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

// The first import of the scanner loads the whole usage module graph cold, which takes longer than
// a test is allowed. Loading it here, with a longer limit, leaves the tests to time the scans alone.
beforeAll(async () => {
  await import('./localScanner');
}, 120_000);

/** A fresh module graph each time, since the scan cache is loaded once per process. */
async function scan(provider: 'claude-code' | 'codex', options = {}) {
  vi.resetModules();
  const { scanLocalProvider } = await import('./localScanner');
  return scanLocalProvider(provider, options);
}

function rowNamed(daily: ProjectDaily | undefined, name: string) {
  return daily?.projects.find((row) => row.name === name);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runova-project-split-'));
  paths.userData = join(root, 'userData');
  mkdirSync(paths.userData, { recursive: true });
  now = Date.now();
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
  // The missing worker is reported once per scan; it is expected here.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  failure.fail = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('scanLocalProvider project split for Claude Code', () => {
  it('names each folder after its registered project, folds worktrees in, and keeps the rest', async () => {
    writeTranscript('E--Runova/a.jsonl', claudeLine('E:\\Runova\\apps', 'a1'));
    writeTranscript(
      'E--Runova--claude-worktrees-feat/b.jsonl',
      claudeLine('E:\\Runova\\.claude\\worktrees\\feat', 'b1'),
    );
    writeTranscript('E--side-project/c.jsonl', claudeLine('E:\\side-project', 'c1'));
    const knownProjects = vi.fn(async () => ({
      projects: [{ id: 'p1', name: 'Runova', folderPath: 'E:\\Runova' }],
      worktrees: [],
    }));

    const usage = await scan('claude-code', { knownProjects });

    expect(knownProjects).toHaveBeenCalledTimes(1);
    expect(usage.projectDaily?.endDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const runova = usage.projectDaily?.projects.find((row) => row.key === 'project:p1');
    expect(runova?.name).toBe('Runova');
    expect(runova?.tokens.reduce((sum, value) => sum + value, 0)).toBe(2000);
    expect(rowNamed(usage.projectDaily as ProjectDaily, 'side-project')).toBeDefined();
    // The split is plain data, so it crosses the IPC boundary intact.
    expect(() => structuredClone(usage)).not.toThrow();
  });

  it('counts a message that two transcripts share once in the split as well as the totals', async () => {
    writeTranscript('E--Runova/a.jsonl', claudeLine('E:\\Runova', 'dup'));
    writeTranscript('E--side-project/b.jsonl', claudeLine('E:\\side-project', 'dup'));

    const usage = await scan('claude-code');

    expect(usage.last30d.tokens.total).toBe(1000);
    const total = usage.projectDaily?.projects.reduce(
      (sum, row) => sum + row.tokens.reduce((n, value) => n + value, 0),
      0,
    );
    expect(total).toBe(1000);
  });

  it('still names the folders when the project list cannot be read', async () => {
    writeTranscript('E--side-project/c.jsonl', claudeLine('E:\\side-project', 'c1'));

    const usage = await scan('claude-code', {
      knownProjects: async () => {
        throw new Error('store is down');
      },
    });

    expect(rowNamed(usage.projectDaily as ProjectDaily, 'side-project')).toMatchObject({
      name: 'side-project',
    });
  });

  it('leaves the split out, and not the totals, when building it fails', async () => {
    writeTranscript('E--side-project/c.jsonl', claudeLine('E:\\side-project', 'c1', 4000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    failure.fail = true;

    const usage = await scan('claude-code');

    expect(usage.projectDaily).toBeUndefined();
    expect(usage.last30d.tokens.total).toBe(4000);
    expect(warn).toHaveBeenCalledWith('[usage] project split failed:', expect.any(Error));
  });

  it('gives the same split on a second scan that reads the cache, and keeps the cache at version 4', async () => {
    writeTranscript('E--side-project/c.jsonl', claudeLine('E:\\side-project', 'c1'));

    const first = await scan('claude-code');
    const second = await scan('claude-code');

    expect(second.projectDaily).toEqual(first.projectDaily);
    const saved = JSON.parse(readFileSync(join(paths.userData, 'usage-scan-cache.json'), 'utf-8'));
    expect(saved.version).toBe(4);
  });
});

describe('scanLocalProvider project split for Codex', () => {
  it('gives each rollout its own folder row, named after the folder', async () => {
    const sessions = join(root, 'codex', 'sessions', '2026', '10', '13');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'one.jsonl'), codexRollout('E:\\MehrCare', 300), 'utf-8');
    writeFileSync(join(sessions, 'two.jsonl'), codexRollout('E:\\Galaxy', 500), 'utf-8');

    const usage = await scan('codex');

    expect(
      usage.projectDaily?.projects.map((row) => [row.name, row.tokens.reduce((n, v) => n + v, 0)]),
    ).toEqual([
      ['Galaxy', 500],
      ['MehrCare', 300],
    ]);
  });
});
