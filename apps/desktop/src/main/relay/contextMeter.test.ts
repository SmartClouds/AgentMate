import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextTokensFromLines, contextWindowFor, readContextTokens } from './contextMeter';

/** Lines shaped like the T0 spike's real Claude Code 2.1.305 transcript. */
function assistant(id: string, input: number, read: number, create: number, sidechain = false) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
        output_tokens: 99,
      },
    },
  });
}

describe('contextTokensFromLines', () => {
  it('sums the latest main-thread reply, not the largest', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant('m1', 10, 40_000, 2_000),
      // One reply split over two lines with the same usage: counted once, as the latest.
      assistant('m2', 5, 49_000, 600),
      assistant('m2', 5, 49_000, 600),
      // A side request reusing a shorter prefix comes after it.
      assistant('m3', 3, 31_700, 0),
    ];
    expect(contextTokensFromLines(lines)).toBe(31_703);
  });

  it('skips sidechain lines and lines cut in half', () => {
    const lines = [
      assistant('m1', 1, 50_000, 0),
      assistant('s1', 1, 900_000, 0, true),
      '{"type":"assistant","isSidech',
    ];
    expect(contextTokensFromLines(lines)).toBe(50_001);
  });

  it('is null with no reply yet', () => {
    expect(contextTokensFromLines(['{"type":"user"}'])).toBeNull();
  });
});

describe('readContextTokens', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-transcript-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the end of a transcript file', async () => {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, `${assistant('m1', 1, 2, 3)}\n${assistant('m2', 100, 200, 300)}\n`);
    expect(await readContextTokens(path)).toBe(600);
  });

  it('refuses a relative or non-transcript path', async () => {
    expect(await readContextTokens('session.jsonl')).toBeNull();
    expect(await readContextTokens(join(dir, 'x.txt'))).toBeNull();
    expect(await readContextTokens(join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('contextWindowFor', () => {
  it('knows the 1M variants', () => {
    expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-5-5')).toBe(200_000);
    expect(contextWindowFor(undefined)).toBeNull();
  });
});
