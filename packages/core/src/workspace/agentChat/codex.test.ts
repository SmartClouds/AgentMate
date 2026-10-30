import { describe, expect, it } from 'vitest';
import { applyCodexLines } from './codex.js';
import { type ChatItem, emptyChatState } from './types.js';

const at = '2026-10-30T05:00:00.000Z';
const line = (type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: at, type, payload });
const item = (payload: unknown): string => line('response_item', payload);

function read(lines: string[]): ChatItem[] {
  return applyCodexLines(emptyChatState(), lines).items;
}

describe('codex chat reader', () => {
  it('turns prompts and replies into chat messages', () => {
    const items = read([
      line('session_meta', { id: 's1', cwd: '/repo' }),
      item({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'add a test' }],
      }),
      item({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Added `app.test.ts`.' }],
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'add a test', at: Date.parse(at) }),
      expect.objectContaining({ kind: 'assistant', text: 'Added `app.test.ts`.' }),
    ]);
  });

  it('counts the images sent with a prompt', () => {
    const items = read([
      item({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,x' },
          { type: 'input_text', text: 'match this design' },
        ],
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'match this design', images: 1 }),
    ]);
  });

  it('skips the context Codex injects and developer messages', () => {
    const items = read([
      item({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'sandbox rules' }],
      }),
      item({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/repo</cwd>' }],
      }),
      item({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\nbe nice' }],
      }),
      line('event_msg', { type: 'token_count' }),
      line('turn_context', { model: 'gpt-6' }),
    ]);
    expect(items).toEqual([]);
  });

  it('shows the reasoning summary', () => {
    const items = read([
      item({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '**Planning the test**' }],
        encrypted_content: 'x',
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'thinking', text: '**Planning the test**' }),
    ]);
  });

  it('follows a shell call to its output', () => {
    const items = read([
      item({
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'pnpm test'], workdir: '/repo' }),
        call_id: 'call_1',
      }),
      item({
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ output: '3 passed', metadata: { exit_code: 0 } }),
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'tool',
        toolKind: 'shell',
        title: 'pnpm test',
        status: 'ok',
        output: '3 passed',
      }),
    ]);
  });

  it('marks a command that exited with an error', () => {
    const items = read([
      item({
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat nope.txt' }),
        call_id: 'call_2',
      }),
      item({
        type: 'function_call_output',
        call_id: 'call_2',
        output: 'Wall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nNo such file',
      }),
    ]);
    expect(items[0]).toEqual(expect.objectContaining({ title: 'cat nope.txt', status: 'error' }));
  });

  it('shows a patch as an edit', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n-a\n+b\n*** End Patch';
    const items = read([
      item({ type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'call_3' }),
      item({ type: 'custom_tool_call_output', call_id: 'call_3', output: 'Success.' }),
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({
        toolKind: 'edit',
        title: 'src/app.ts',
        detail: patch,
        status: 'ok',
      }),
    );
  });

  it('shows a web search', () => {
    const items = read([
      item({
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'vitest' },
      }),
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({ toolKind: 'web', title: 'vitest', status: 'ok' }),
    );
  });

  it('shows an aborted turn as a notice', () => {
    const items = read([line('event_msg', { type: 'turn_aborted', reason: 'interrupted' })]);
    expect(items).toEqual([expect.objectContaining({ kind: 'notice', text: 'Interrupted' })]);
  });

  it('ends up the same whether the lines come at once or one at a time', () => {
    const lines = [
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
      item({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c' }),
      item({ type: 'function_call_output', call_id: 'c', output: 'a.ts' }),
      item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    ];
    const atOnce = applyCodexLines(emptyChatState(), lines);
    let chunked = emptyChatState();
    for (const one of lines) chunked = applyCodexLines(chunked, [one]);
    expect(chunked.items).toEqual(atOnce.items);
  });
});
