import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedHeadlessRun } from './headlessPrompt';

/**
 * Runs a real child process (a small Node script standing in for a CLI), so the streaming,
 * stdin, cancel and timeout paths are the real ones. Only the CLI lookup is replaced.
 */

const prepared: {
  current: { ok: true; run: PreparedHeadlessRun } | { ok: false; result: unknown };
} = {
  current: { ok: false, result: null },
};

vi.mock('./headlessPrompt', async (importOriginal) => {
  const real = await importOriginal<typeof import('./headlessPrompt')>();
  return { ...real, prepareHeadlessRun: vi.fn(async () => prepared.current) };
});

const { streamHeadlessCliPrompt } = await import('./headlessStream');

let dir = '';
let script = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-stream-'));
  script = join(dir, 'fakecli.mjs');
  await writeFile(
    script,
    `
const mode = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (mode === 'answer') {
    process.stderr.write('Reading request\\n');
    await wait(20);
    process.stderr.write('\\u001b[32mThinking\\u001b[0m\\n');
    process.stdout.write('{"got": ' + JSON.stringify(input) + '}');
  } else if (mode === 'argv') {
    process.stdout.write(process.argv.at(-1));
  } else if (mode === 'split') {
    const bytes = Buffer.from('سلام', 'utf8');
    process.stdout.write(bytes.subarray(0, 3));
    await wait(30);
    process.stdout.write(bytes.subarray(3));
  } else if (mode === 'fail') {
    process.stderr.write('Error: not logged in\\n');
    process.exit(2);
  } else if (mode === 'slow') {
    process.stderr.write('working\\n');
    await wait(60000);
  }
});
`,
    'utf8',
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function useCli(mode: string, promptInputMode?: 'stdin') {
  prepared.current = {
    ok: true,
    run: {
      cli: { id: 'fake', name: 'Fake CLI', promptInputMode } as PreparedHeadlessRun['cli'],
      command: 'node',
      args: [script, mode],
      prompt: 'the whole request',
      env: process.env,
    },
  };
}

const base = () => ({ signal: new AbortController().signal, onLine: vi.fn(), timeoutMs: 20_000 });

beforeEach(() => {
  prepared.current = { ok: false, result: null };
});

describe('streamHeadlessCliPrompt', () => {
  it('sends the whole prompt on stdin, streams the progress and keeps the answer apart', async () => {
    useCli('answer', 'stdin');
    const options = base();
    const result = await streamHeadlessCliPrompt('the whole request', dir, options);
    expect(result).toMatchObject({
      ok: true,
      cliName: 'Fake CLI',
      text: '{"got": "the whole request"}',
    });
    expect(result.log).toContain('Reading request');
    expect(options.onLine).toHaveBeenCalledWith('Reading request');
    expect(options.onLine).toHaveBeenCalledWith('Thinking');
  });

  it('gives an argument-mode CLI the pointer prompt instead of the request', async () => {
    useCli('argv');
    const result = await streamHeadlessCliPrompt('x'.repeat(30_000), dir, {
      ...base(),
      pointerPrompt: 'Read request.md',
    });
    expect(result.text).toBe('Read request.md');
  });

  it('decodes a Persian answer that arrives split mid-character', async () => {
    useCli('split', 'stdin');
    expect((await streamHeadlessCliPrompt('p', dir, base())).text).toBe('سلام');
  });

  it('reports a failed run with the error line from its log', async () => {
    useCli('fail', 'stdin');
    const result = await streamHeadlessCliPrompt('p', dir, base());
    expect(result).toMatchObject({ ok: false, error: 'Fake CLI failed: not logged in' });
  });

  it('stops the run when the signal aborts', async () => {
    useCli('slow', 'stdin');
    const controller = new AbortController();
    const onLine = vi.fn(() => controller.abort());
    const started = Date.now();
    const result = await streamHeadlessCliPrompt('p', dir, {
      ...base(),
      signal: controller.signal,
      onLine,
    });
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops a run that outlives its time budget', async () => {
    useCli('slow', 'stdin');
    const result = await streamHeadlessCliPrompt('p', dir, { ...base(), timeoutMs: 500 });
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  it('does not start anything for a signal that is already aborted', async () => {
    useCli('answer', 'stdin');
    const controller = new AbortController();
    controller.abort();
    const result = await streamHeadlessCliPrompt('p', dir, {
      ...base(),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ cancelled: true, cliName: null });
  });

  it('passes on why no CLI could run', async () => {
    prepared.current = { ok: false, result: { ok: false, text: '', cliName: null, error: 'none' } };
    expect(await streamHeadlessCliPrompt('p', dir, base())).toEqual({
      ok: false,
      text: '',
      cliName: null,
      error: 'none',
    });
  });
});
