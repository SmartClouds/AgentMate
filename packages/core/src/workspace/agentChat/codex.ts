import {
  blockText,
  type ChatReader,
  type ChatState,
  type ChatToolStatus,
  describeTool,
  draft,
  find,
  imageCount,
  parseLine,
  record,
  text,
  timeOf,
  upsert,
} from './types.js';

/** User messages Codex writes itself before the first prompt: context, not something typed. */
const INJECTED = /^(<environment_context>|<user_instructions>|# AGENTS\.md instructions)/;

/**
 * A Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). The conversation is the
 * `response_item` lines: messages, reasoning summaries, and tool calls whose output follows in
 * a separate line with the same `call_id`. Lines carry no id, so items are keyed by position.
 */
export const applyCodexLines: ChatReader = (state, lines) => {
  const next = draft(state);
  for (const line of lines) {
    next.seq += 1;
    const entry = parseLine(line);
    const payload = record(entry?.payload);
    if (!entry || !payload) continue;
    const at = timeOf(entry.timestamp);
    const key = `line-${next.seq}`;
    if (entry.type === 'response_item') readItem(next, key, at, payload);
    else if (entry.type === 'event_msg' && payload.type === 'turn_aborted') {
      upsert(next, { kind: 'notice', key, at, text: 'Interrupted', tone: 'warning' });
    }
  }
  return next;
};

function readItem(
  state: ChatState,
  key: string,
  at: number | null,
  item: Record<string, unknown>,
): void {
  switch (item.type) {
    case 'message': {
      const body = blockText(item.content).trim();
      const images = item.role === 'user' ? imageCount(item.content) : 0;
      if (!body && images === 0) return;
      if (item.role === 'user' && !INJECTED.test(body)) {
        upsert(state, { kind: 'user', key, at, text: body, ...(images > 0 ? { images } : {}) });
      } else if (item.role === 'assistant') {
        upsert(state, { kind: 'assistant', key, at, text: body });
      }
      return;
    }
    case 'reasoning': {
      const summary = blockText(item.summary).trim();
      if (summary) upsert(state, { kind: 'thinking', key, at, text: summary });
      return;
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
      readCall(state, at, item);
      return;
    case 'function_call_output':
    case 'custom_tool_call_output':
      readOutput(state, item);
      return;
    case 'web_search_call': {
      const action = record(item.action);
      const query = text(action?.query) ?? text(action?.url) ?? 'Web search';
      upsert(state, {
        kind: 'tool',
        key,
        at,
        callId: key,
        name: 'web_search',
        toolKind: 'web',
        title: query,
        detail: null,
        edit: null,
        status: item.status === 'failed' ? 'error' : item.status === 'completed' ? 'ok' : 'running',
        output: null,
      });
      return;
    }
  }
}

function callInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === 'local_shell_call') return record(record(item.action)) ?? {};
  if (typeof item.arguments === 'string') {
    try {
      return record(JSON.parse(item.arguments)) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

/** The files a patch touches, from its `*** Update File:` style headers. */
function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

function readCall(state: ChatState, at: number | null, item: Record<string, unknown>): void {
  const callId = text(item.call_id) ?? text(item.id);
  if (!callId || find(state, `tool:${callId}`)) return;
  const name = text(item.name) ?? (item.type === 'local_shell_call' ? 'shell' : 'tool');
  const input = callInput(item);
  const patch = typeof item.input === 'string' ? item.input : text(input.input);
  const described =
    name === 'apply_patch' && patch
      ? {
          toolKind: 'edit' as const,
          title: patchFiles(patch).join(', ') || 'Patch',
          detail: patch,
          edit: null,
        }
      : describeTool(name, input);
  upsert(state, {
    kind: 'tool',
    key: `tool:${callId}`,
    at,
    callId,
    name,
    ...described,
    status: 'running',
    output: null,
  });
}

/**
 * Tool output comes as plain text or as JSON with the exit code alongside. Plain text from
 * `exec_command` says how the process exited in its header.
 */
function readOutput(state: ChatState, item: Record<string, unknown>): void {
  const callId = text(item.call_id);
  const tool = callId ? find(state, `tool:${callId}`) : undefined;
  if (tool?.kind !== 'tool') return;
  let output =
    typeof item.output === 'string' ? item.output : blockText(record(item.output)?.content);
  let status: ChatToolStatus = 'ok';
  const wrapped = record(item.output) ?? jsonRecord(output);
  if (wrapped) {
    if (typeof wrapped.output === 'string') output = wrapped.output;
    else if (typeof wrapped.content === 'string') output = wrapped.content;
    const exit = record(wrapped.metadata)?.exit_code;
    if ((typeof exit === 'number' && exit !== 0) || wrapped.success === false) status = 'error';
  } else {
    const exit = /(?:exited with code|^Exit code:)\s*(-?\d+)/m.exec(output);
    if (exit && exit[1] !== '0') status = 'error';
    const body = /^Output:\n([\s\S]*)$/m.exec(output);
    if (body) output = body[1];
  }
  upsert(state, { ...tool, status, output: output.trim() || null });
}

function jsonRecord(value: string): Record<string, unknown> | null {
  if (!value.startsWith('{')) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}
