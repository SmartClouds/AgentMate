import { cleanPromptText } from '../sessionHistory.js';
import {
  blockText,
  type ChatReader,
  type ChatState,
  type ChatToolStatus,
  describeTool,
  draft,
  emptyChatState,
  parseLine,
  record,
  text,
  timeOf,
  upsert,
} from './types.js';

/**
 * A Gemini CLI chat (`~/.gemini/tmp/<project>/chats/session-*.jsonl`). After a header line the
 * file is a log of changes: `$set.messages` replaces the whole list, and a line with an `id` and
 * `type` adds that message or rewrites it. Qwen Code writes the same format.
 */
export const applyGeminiLines: ChatReader = (state, lines) => {
  let next = draft(state);
  for (const line of lines) {
    next.seq += 1;
    const entry = parseLine(line);
    if (!entry) continue;
    const messages = record(entry.$set)?.messages;
    if (Array.isArray(messages)) {
      next = { ...emptyChatState(), seq: next.seq };
      for (const message of messages) readMessage(next, record(message));
    } else if (typeof entry.id === 'string' && typeof entry.type === 'string') {
      readMessage(next, entry);
    }
  }
  return next;
};

const NOTICE_TONES = { info: 'info', warning: 'warning', error: 'error' } as const;

function readMessage(state: ChatState, message: Record<string, unknown> | null): void {
  if (!message || typeof message.id !== 'string') return;
  const id = message.id;
  const at = timeOf(message.timestamp);
  const type = message.type;
  if (type === 'user') {
    const shown = blockText(message.displayContent ?? message.content);
    // The first message of every chat is the CLI's own setup context.
    const typed = shown.replace(/<session_context>[\s\S]*?(<\/session_context>|$)/, '');
    const body = cleanPromptText(typed);
    if (body) upsert(state, { kind: 'user', key: id, at, text: body });
    return;
  }
  if (type === 'gemini') {
    readReply(state, id, at, message);
    return;
  }
  if (typeof type === 'string' && type in NOTICE_TONES) {
    const body = blockText(message.content).trim();
    const tone = NOTICE_TONES[type as keyof typeof NOTICE_TONES];
    if (body) upsert(state, { kind: 'notice', key: id, at, text: body, tone });
  }
}

function readReply(
  state: ChatState,
  id: string,
  at: number | null,
  message: Record<string, unknown>,
): void {
  if (Array.isArray(message.thoughts)) {
    const thoughts = message.thoughts
      .map((thought) => {
        const value = record(thought);
        const subject = text(value?.subject);
        const description = text(value?.description);
        return [subject ? `**${subject}**` : null, description].filter(Boolean).join('\n\n');
      })
      .filter(Boolean)
      .join('\n\n');
    if (thoughts) upsert(state, { kind: 'thinking', key: `${id}:thoughts`, at, text: thoughts });
  }
  const body = blockText(message.content).trim();
  if (body) upsert(state, { kind: 'assistant', key: `${id}:text`, at, text: body });
  if (!Array.isArray(message.toolCalls)) return;
  message.toolCalls.forEach((raw, i) => {
    const call = record(raw);
    if (!call) return;
    const callId = text(call.id) ?? `${id}:${i}`;
    const name = text(call.name) ?? 'tool';
    upsert(state, {
      kind: 'tool',
      key: `tool:${callId}`,
      at: timeOf(call.timestamp) ?? at,
      callId,
      name,
      ...describeTool(name, record(call.args) ?? {}),
      status: toolStatus(call.status),
      output: resultText(call) || null,
    });
  });
}

function toolStatus(status: unknown): ChatToolStatus {
  if (status === 'success') return 'ok';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'running';
}

function resultText(call: Record<string, unknown>): string {
  const display = call.resultDisplay;
  if (typeof display === 'string') return display.trim();
  const result = call.result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        const response = record(record(record(part)?.functionResponse)?.response);
        return typeof response?.output === 'string' ? response.output : '';
      })
      .join('\n')
      .trim();
  }
  return '';
}
