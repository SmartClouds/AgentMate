import { cleanPromptText } from '../sessionHistory.js';
import {
  blockText,
  type ChatReader,
  type ChatState,
  describeTool,
  draft,
  find,
  parseLine,
  record,
  timeOf,
  upsert,
} from './types.js';

/**
 * Claude Code's transcript (`~/.claude/projects/<folder>/<session>.jsonl`). Every content block
 * of a reply is its own `assistant` line, and tool results come back as `user` lines whose
 * blocks point at the `tool_use` they answer. OpenClaude writes the same format.
 */
export const applyClaudeLines: ChatReader = (state, lines) => {
  const next = draft(state);
  for (const line of lines) {
    next.seq += 1;
    const entry = parseLine(line);
    if (!entry || entry.isSidechain === true) continue;
    const at = timeOf(entry.timestamp);
    const id = typeof entry.uuid === 'string' ? entry.uuid : `line-${next.seq}`;
    const content = record(entry.message)?.content;
    if (entry.type === 'user' && entry.isMeta !== true) readUser(next, id, at, content);
    else if (entry.type === 'assistant' && Array.isArray(content)) {
      content.forEach((block, i) => readAssistantBlock(next, `${id}:${i}`, at, block));
    }
  }
  return next;
};

function readUser(state: ChatState, id: string, at: number | null, content: unknown): void {
  if (Array.isArray(content)) {
    for (const block of content) {
      const value = record(block);
      if (value?.type === 'tool_result') readToolResult(state, value);
    }
  }
  const raw = blockText(content).trim();
  if (!raw || raw.startsWith('<task-notification>')) return;
  if (raw.startsWith('[Request interrupted')) {
    upsert(state, { kind: 'notice', key: id, at, text: 'Interrupted', tone: 'warning' });
    return;
  }
  const command = /^<command-name>([^<]+)<\/command-name>/.exec(raw);
  if (command) {
    upsert(state, { kind: 'notice', key: id, at, text: command[1].trim(), tone: 'info' });
    return;
  }
  const text = cleanPromptText(raw);
  if (text) upsert(state, { kind: 'user', key: id, at, text });
}

function readToolResult(state: ChatState, block: Record<string, unknown>): void {
  if (typeof block.tool_use_id !== 'string') return;
  const tool = find(state, `tool:${block.tool_use_id}`);
  if (tool?.kind !== 'tool') return;
  upsert(state, {
    ...tool,
    status: block.is_error === true ? 'error' : 'ok',
    output: blockText(block.content).trim() || null,
  });
}

function readAssistantBlock(state: ChatState, key: string, at: number | null, raw: unknown): void {
  const block = record(raw);
  if (!block) return;
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
    upsert(state, { kind: 'assistant', key, at, text: block.text.trim() });
  } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
    // Redacted thinking is written with an empty text and only a signature.
    if (block.thinking.trim()) {
      upsert(state, { kind: 'thinking', key, at, text: block.thinking.trim() });
    }
  } else if (block.type === 'tool_use' && typeof block.id === 'string') {
    const toolKey = `tool:${block.id}`;
    if (find(state, toolKey)) return;
    const name = typeof block.name === 'string' ? block.name : 'Tool';
    upsert(state, {
      kind: 'tool',
      key: toolKey,
      at,
      callId: block.id,
      name,
      ...describeTool(name, record(block.input) ?? {}),
      status: 'running',
      output: null,
    });
  }
}
