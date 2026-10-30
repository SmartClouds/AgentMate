import { describe, expect, it } from 'vitest';
import { applyGeminiLines } from './gemini.js';
import { type ChatItem, emptyChatState } from './types.js';

const at = '2026-10-30T05:00:00.000Z';
const line = (value: unknown): string => JSON.stringify(value);
const header = line({ sessionId: 's1', startTime: at, lastUpdated: at, kind: 'main' });
const setup = {
  id: 'm0',
  timestamp: at,
  type: 'user',
  content: [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }],
};

function read(lines: string[]): ChatItem[] {
  return applyGeminiLines(emptyChatState(), lines).items;
}

describe('gemini chat reader', () => {
  it('reads the messages a chat starts with and the ones added after', () => {
    const items = read([
      header,
      line({ $set: { messages: [setup] } }),
      line({ id: 'm1', timestamp: at, type: 'user', content: [{ text: 'open notepad' }] }),
      line({ $set: { lastUpdated: at } }),
      line({
        id: 'm2',
        timestamp: at,
        type: 'gemini',
        content: 'Opening it now.',
        thoughts: [{ subject: 'Finding the button', description: 'It is centered.' }],
        model: 'gemini-3.8-flash',
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'open notepad', at: Date.parse(at) }),
      expect.objectContaining({
        kind: 'thinking',
        text: '**Finding the button**\n\nIt is centered.',
      }),
      expect.objectContaining({ kind: 'assistant', text: 'Opening it now.' }),
    ]);
  });

  it('prefers what the user saw over the expanded prompt', () => {
    const items = read([
      line({
        id: 'm1',
        type: 'user',
        content: [{ text: 'read @a.ts\n--- Content from a.ts ---\nbody' }],
        displayContent: [{ text: 'read @a.ts' }],
      }),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: 'user', text: 'read @a.ts' })]);
  });

  it('updates a message written again with the same id', () => {
    const items = read([
      line({ id: 'm2', type: 'gemini', content: 'Work' }),
      line({ id: 'm2', type: 'gemini', content: 'Working on it.' }),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: 'assistant', text: 'Working on it.' })]);
  });

  it('starts over when the whole message list is set again', () => {
    const items = read([
      line({ id: 'm1', type: 'user', content: [{ text: 'old' }] }),
      line({ $set: { messages: [{ id: 'm9', type: 'user', content: [{ text: 'new' }] }] } }),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: 'user', text: 'new' })]);
  });

  it('shows tool calls with their result', () => {
    const items = read([
      line({
        id: 'm2',
        type: 'gemini',
        content: '',
        toolCalls: [
          {
            id: 'run_shell_command-1',
            name: 'run_shell_command',
            args: { command: 'npm test', description: 'Run tests' },
            status: 'success',
            resultDisplay: '5 passed',
          },
          {
            id: 'read_file-2',
            name: 'read_file',
            args: { absolute_path: '/repo/x.ts' },
            status: 'error',
            resultDisplay: 'not found',
          },
          {
            id: 'replace-3',
            name: 'replace',
            args: { file_path: '/repo/y.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'tool',
        toolKind: 'shell',
        title: 'Run tests',
        detail: 'npm test',
        status: 'ok',
        output: '5 passed',
      }),
      expect.objectContaining({ toolKind: 'read', title: 'x.ts', status: 'error' }),
      expect.objectContaining({
        toolKind: 'edit',
        status: 'running',
        edit: { path: '/repo/y.ts', before: 'a', after: 'b' },
      }),
    ]);
  });

  it('shows errors and info lines as notices', () => {
    const items = read([
      line({ id: 'e1', type: 'error', content: 'Quota exceeded' }),
      line({ id: 'i1', type: 'info', content: 'Request cancelled.' }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'notice', tone: 'error', text: 'Quota exceeded' }),
      expect.objectContaining({ kind: 'notice', tone: 'info', text: 'Request cancelled.' }),
    ]);
  });
});
