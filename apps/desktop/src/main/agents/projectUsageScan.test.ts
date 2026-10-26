import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import type { FileScanState } from '../usage/logParsers';
import {
  localDay,
  type ScanJob,
  scanProjectBuckets,
  trimScanCache,
  type UsageBucket,
} from './projectUsageScan';

/**
 * The worker's half of the project usage report: read the transcripts of many conversations and
 * boil them down to token buckets. The transcripts are written to a temp folder, because the
 * point is what comes out of real files (dedupe, dates, what is skipped), not a parser mock.
 */

const MODEL = 'claude-opus-5-5';
const OTHER_MODEL = 'claude-sonnet-5-5';

/** A moment in the local time zone, so the expected day does not depend on where tests run. */
const at = (day: number, hour = 12): number => new Date(2026, 8, day, hour).getTime();

function claudeLine(fields: {
  at: number;
  id?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(fields.at).toISOString(),
    message: {
      id: fields.id,
      model: fields.model ?? MODEL,
      usage: {
        input_tokens: fields.input ?? 0,
        output_tokens: fields.output ?? 0,
        cache_read_input_tokens: fields.cacheRead ?? 0,
        cache_creation_input_tokens: fields.cacheWrite ?? 0,
      },
    },
  })}\n`;
}

function codexLines(when: number, model: string, input: number, cached: number, output: number) {
  return [
    JSON.stringify({
      timestamp: new Date(when).toISOString(),
      type: 'turn_context',
      payload: { type: 'turn_context', model },
    }),
    JSON.stringify({
      timestamp: new Date(when).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
  ].join('\n');
}

let seq = 0;

/** Writes a Claude transcript under `dir` and describes it as a scan job. */
function claudeJob(
  dir: string,
  lines: string[],
  overrides: Partial<ScanJob> = {},
): ScanJob & { id: string } {
  seq += 1;
  const id = `0a1b2c3d-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.join(''), 'utf-8');
  return {
    key: `claude-code\u0000${id}`,
    id,
    parser: 'claude-code',
    path,
    subagentDir: join(dir, id),
    order: seq,
    ...overrides,
  };
}

const forKey = (buckets: UsageBucket[], key: string): UsageBucket[] =>
  buckets.filter((bucket) => bucket.key === key);

const sum = (buckets: UsageBucket[]): number =>
  buckets.reduce((n, b) => n + b.input + b.output + b.cacheRead + b.cacheWrite, 0);

describe('localDay', () => {
  it('names the calendar day in the local time zone', () => {
    expect(localDay(at(17, 0))).toBe('2026-09-17');
    expect(localDay(at(17, 23))).toBe('2026-09-17');
    expect(localDay(at(18, 0))).toBe('2026-09-18');
  });
});

describe('scanProjectBuckets', () => {
  it('sums the four token counts per conversation, day and model', async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [
      claudeLine({ at: at(17, 9), id: 'm1', input: 10, output: 20 }),
      claudeLine({ at: at(17, 15), id: 'm2', input: 1, cacheRead: 300, cacheWrite: 40 }),
      claudeLine({ at: at(18, 9), id: 'm3', model: OTHER_MODEL, output: 7 }),
    ]);

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    expect(buckets).toHaveLength(2);
    expect(buckets).toContainEqual({
      key: job.key,
      day: '2026-09-17',
      model: MODEL,
      input: 11,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
    });
    expect(buckets).toContainEqual({
      key: job.key,
      day: '2026-09-18',
      model: OTHER_MODEL,
      input: 0,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('counts a message id once, however many lines carry it', async () => {
    const dir = tempDir('runova-project-usage-');
    const line = claudeLine({ at: at(17), id: 'dup', input: 5, output: 5 });
    const job = claudeJob(dir, [line, line, line]);

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    expect(sum(buckets)).toBe(10);
  });

  it('counts a message copied into a resumed conversation once, for the older one', async () => {
    const dir = tempDir('runova-project-usage-');
    const original = claudeJob(dir, [claudeLine({ at: at(10), id: 'shared', input: 100 })], {
      order: 1,
    });
    const resumed = claudeJob(
      dir,
      [
        claudeLine({ at: at(10), id: 'shared', input: 100 }),
        claudeLine({ at: at(12), id: 'fresh', input: 7 }),
      ],
      { order: 2 },
    );

    // The jobs arrive newest first, as the history list gives them.
    const { buckets } = await scanProjectBuckets({
      jobs: [resumed, original],
      sinceMs: 0,
      cache: {},
    });

    expect(sum(forKey(buckets, original.key))).toBe(100);
    expect(sum(forKey(buckets, resumed.key))).toBe(7);
  });

  it('leaves out events before the period and keeps the rest', async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [
      claudeLine({ at: at(3), id: 'old', input: 1000 }),
      claudeLine({ at: at(20), id: 'new', input: 5 }),
    ]);

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: at(10), cache: {} });

    expect(sum(buckets)).toBe(5);
    expect(buckets.map((b) => b.day)).toEqual(['2026-09-20']);
  });

  it('never opens a transcript untouched since before the period', async () => {
    const dir = tempDir('runova-project-usage-');
    const stale = claudeJob(dir, [claudeLine({ at: at(3), id: 'old', input: 1000 })]);
    const live = claudeJob(dir, [claudeLine({ at: at(20), id: 'new', input: 5 })]);
    const longAgo = new Date(at(3));
    utimesSync(stale.path, longAgo, longAgo);

    const { buckets, cache } = await scanProjectBuckets({
      jobs: [stale, live],
      sinceMs: at(10),
      cache: {},
    });

    expect(sum(buckets)).toBe(5);
    expect(Object.keys(cache)).toEqual([live.path]);
  });

  it("adds the conversation's subagent logs", async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [claudeLine({ at: at(17), id: 'main', input: 10 })]);
    mkdirSync(join(job.subagentDir ?? '', 'subagents'), { recursive: true });
    writeFileSync(
      join(job.subagentDir ?? '', 'subagents', 'agent-1.jsonl'),
      claudeLine({ at: at(17), id: 'sub', output: 90 }),
      'utf-8',
    );

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    expect(sum(forKey(buckets, job.key))).toBe(100);
  });

  it('skips placeholder messages that carry no tokens', async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [
      claudeLine({ at: at(17), id: 'synthetic', model: '<synthetic>' }),
      claudeLine({ at: at(17), id: 'real', input: 3 }),
    ]);

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    expect(buckets).toHaveLength(1);
    expect(buckets[0].model).toBe(MODEL);
  });

  it('reads Codex rollouts, with the model from the turn context', async () => {
    const dir = tempDir('runova-project-usage-');
    const path = join(dir, 'rollout-2026-09-17.jsonl');
    writeFileSync(path, `${codexLines(at(17), 'gpt-5', 1000, 400, 50)}\n`, 'utf-8');
    const job: ScanJob = { key: 'codex\u0000abc', parser: 'codex', path, order: 1 };

    const { buckets } = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    expect(buckets).toEqual([
      {
        key: job.key,
        day: '2026-09-17',
        model: 'gpt-5',
        // Codex counts cached tokens inside the input; they are split out here.
        input: 600,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
      },
    ]);
  });

  it('reads only the appended bytes the second time, without counting twice', async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [claudeLine({ at: at(17), id: 'a', input: 10 })]);
    const first = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });

    appendFileSync(job.path, claudeLine({ at: at(17), id: 'b', input: 5 }), 'utf-8');
    const second = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: first.cache });

    expect(sum(first.buckets)).toBe(10);
    expect(sum(second.buckets)).toBe(15);
    expect(second.cache[job.path].offset).toBe(statSync(job.path).size);
  });

  it('answers a repeat look from the cache when nothing changed', async () => {
    const dir = tempDir('runova-project-usage-');
    const job = claudeJob(dir, [claudeLine({ at: at(17), id: 'a', input: 10 })]);
    const first = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: {} });
    const second = await scanProjectBuckets({ jobs: [job], sinceMs: 0, cache: first.cache });

    expect(second.buckets).toEqual(first.buckets);
    expect(second.cache[job.path]).toBe(first.cache[job.path]);
  });

  it('reports a transcript that is gone instead of counting it as empty', async () => {
    const dir = tempDir('runova-project-usage-');
    const gone: ScanJob = {
      key: 'claude-code\u0000gone',
      parser: 'claude-code',
      path: join(dir, 'gone.jsonl'),
      order: 1,
    };
    const here = claudeJob(dir, [claudeLine({ at: at(17), id: 'a', input: 1 })]);

    const result = await scanProjectBuckets({ jobs: [gone, here], sinceMs: 0, cache: {} });

    expect(result.unreadable).toEqual([gone.key]);
    expect(sum(result.buckets)).toBe(1);
  });
});

describe('trimScanCache', () => {
  const state = (mtimeMs: number, entries: number): FileScanState => ({
    offset: 0,
    mtimeMs,
    size: 0,
    entries: Array.from({ length: entries }, () => ({
      at: 0,
      model: MODEL,
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
  });

  it('forgets the least recently written files first until the budget fits', () => {
    const cache = { old: state(1, 6), mid: state(2, 6), fresh: state(3, 6) };

    const trimmed = trimScanCache(cache, 12);

    expect(Object.keys(trimmed).sort()).toEqual(['fresh', 'mid']);
  });

  it('keeps everything when it already fits', () => {
    const cache = { a: state(1, 2), b: state(2, 2) };

    expect(trimScanCache(cache, 100)).toEqual(cache);
  });

  it('keeps the newest file even when it alone is over the budget', () => {
    const cache = { huge: state(5, 50) };

    expect(Object.keys(trimScanCache(cache, 10))).toEqual(['huge']);
  });
});
