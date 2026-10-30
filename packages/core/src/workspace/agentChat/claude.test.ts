import { describe, expect, it } from 'vitest';
import { applyClaudeLines } from './claude.js';
import { type ChatItem, emptyChatState } from './types.js';

const line = (value: unknown): string => JSON.stringify(value);
const at = '2026-10-30T05:00:00.000Z';

function user(uuid: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return line({ type: 'user', uuid, timestamp: at, message: { role: 'user', content }, ...extra });
}

function assistant(uuid: string, messageId: string, block: unknown): string {
  return line({
    type: 'assistant',
    uuid,
    timestamp: at,
    message: { id: messageId, role: 'assistant', model: 'claude-opus-5-5', content: [block] },
  });
}

function read(lines: string[]): ChatItem[] {
  return applyClaudeLines(emptyChatState(), lines).items;
}

describe('claude chat reader', () => {
  it('turns prompts and replies into chat messages, keeping line breaks', () => {
    const items = read([
      user('u1', 'fix the header\n\nand the footer'),
      assistant('a1', 'msg_1', { type: 'text', text: 'Done. I changed **two** files.' }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'fix the header\n\nand the footer' }),
      expect.objectContaining({ kind: 'assistant', text: 'Done. I changed **two** files.' }),
    ]);
    expect(items[0].at).toBe(Date.parse(at));
  });

  it('skips records that are not the conversation', () => {
    const items = read([
      line({ type: 'file-history-snapshot', messageId: 'x' }),
      line({ type: 'ai-title', aiTitle: 'Header fix' }),
      line({ type: 'system', subtype: 'turn_duration', durationMs: 10 }),
      user('m1', 'Caveat: The messages below were generated', { isMeta: true }),
      user('s1', 'side work', { isSidechain: true }),
      user('r1', '<system-reminder>only a reminder</system-reminder>'),
      user('t1', '<task-notification>\n<task-id>1</task-id>\n</task-notification>'),
      assistant('a0', 'msg_0', { type: 'text', text: '' }),
      'not json',
    ]);

    expect(items).toEqual([]);
  });

  it('strips reminders out of what the user typed', () => {
    const items = read([user('u1', 'run the tests<system-reminder>hidden</system-reminder>')]);
    expect(items).toEqual([expect.objectContaining({ kind: 'user', text: 'run the tests' })]);
  });

  it('shows a slash command as a notice', () => {
    const items = read([
      user(
        'u1',
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
      ),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: 'notice', text: '/compact' })]);
  });

  it('shows an interrupted request as a notice', () => {
    const items = read([user('u1', [{ type: 'text', text: '[Request interrupted by user]' }])]);
    expect(items).toEqual([expect.objectContaining({ kind: 'notice', text: 'Interrupted' })]);
  });

  it('shows thinking that has text, and drops redacted thinking', () => {
    const items = read([
      assistant('a1', 'msg_1', { type: 'thinking', thinking: '', signature: 'sig' }),
      assistant('a2', 'msg_1', { type: 'thinking', thinking: 'Look at the CSS first.' }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'thinking', text: 'Look at the CSS first.' }),
    ]);
  });

  it('follows a tool call from start to its result', () => {
    const call = assistant('a1', 'msg_1', {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'pnpm test', description: 'Run the tests' },
    });
    const running = applyClaudeLines(emptyChatState(), [call]);
    expect(running.items).toEqual([
      expect.objectContaining({
        kind: 'tool',
        callId: 'toolu_1',
        name: 'Bash',
        toolKind: 'shell',
        title: 'Run the tests',
        detail: 'pnpm test',
        status: 'running',
        output: null,
      }),
    ]);

    const done = applyClaudeLines(running, [
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12 passed' }]),
    ]);
    expect(done.items).toEqual([
      expect.objectContaining({ kind: 'tool', status: 'ok', output: '12 passed' }),
    ]);
    // The earlier state is left alone, so a store can compare the two.
    expect(running.items[0]).toEqual(expect.objectContaining({ status: 'running' }));
  });

  it('marks a failed tool and reads text blocks out of its result', () => {
    const items = read([
      assistant('a1', 'msg_1', {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Read',
        input: { file_path: 'E:\\app\\missing.ts' },
      }),
      user('u2', [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: [{ type: 'text', text: 'File does not exist.' }],
        },
      ]),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        toolKind: 'read',
        title: 'missing.ts',
        detail: 'E:\\app\\missing.ts',
        status: 'error',
        output: 'File does not exist.',
      }),
    ]);
  });

  it('keeps the before and after of an edit', () => {
    const items = read([
      assistant('a1', 'msg_1', {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Edit',
        input: { file_path: '/repo/src/app.ts', old_string: 'a = 1', new_string: 'a = 2' },
      }),
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({
        toolKind: 'edit',
        title: 'app.ts',
        edit: { path: '/repo/src/app.ts', before: 'a = 1', after: 'a = 2' },
      }),
    );
  });

  it('does not repeat a tool call written twice', () => {
    const call = assistant('a1', 'msg_1', {
      type: 'tool_use',
      id: 'toolu_4',
      name: 'Grep',
      input: { pattern: 'TODO' },
    });
    const items = read([call, call]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ toolKind: 'search', title: 'TODO' }));
  });

  it('shows a message sent while Claude was working', () => {
    const queued = (uuid: string, prompt: string, origin: unknown) =>
      line({
        type: 'attachment',
        uuid,
        timestamp: at,
        attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin },
      });
    const items = read([
      queued('q1', 'also fix the footer', { kind: 'human' }),
      queued('q2', '<task-notification>\n<task-id>1</task-id>', { kind: 'task' }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', key: 'q1', text: 'also fix the footer' }),
    ]);
  });

  it('counts the images sent with a prompt', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } };
    const items = read([
      user('u1', [image, { type: 'text', text: 'what is wrong here?' }]),
      user('u2', [image, image]),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'what is wrong here?', images: 1 }),
      expect.objectContaining({ kind: 'user', text: '', images: 2 }),
    ]);
  });

  it('ends up the same whether the lines come at once or a few at a time', () => {
    const lines = [
      user('u1', 'hello'),
      assistant('a1', 'msg_1', {
        type: 'tool_use',
        id: 't',
        name: 'Bash',
        input: { command: 'ls' },
      }),
      user('u2', [{ type: 'tool_result', tool_use_id: 't', content: 'a.ts' }]),
      assistant('a2', 'msg_2', { type: 'text', text: 'One file.' }),
    ];
    const atOnce = applyClaudeLines(emptyChatState(), lines);
    let chunked = emptyChatState();
    for (const one of lines) chunked = applyClaudeLines(chunked, [one]);
    expect(chunked.items).toEqual(atOnce.items);
  });
});
