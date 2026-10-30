/**
 * Summaries of past agent conversations, read from the transcripts the CLIs keep on disk.
 * Main reads the first and last chunk of each file; everything here works on those lines,
 * so a 20MB transcript costs the same as a short one.
 */

/**
 * Which CLI's transcript a history entry was read from. Values are the CLI's
 * history-provider id; most match a `CLI_REGISTRY` id, except `codex` which
 * maps to the `codex-cli` CLI (kept for backward compatibility).
 */
export type AgentHistoryProvider =
  | 'claude-code'
  | 'openclaude'
  | 'codex'
  | 'gemini-cli'
  | 'qwen-cli'
  | 'cursor-cli'
  | 'continue-cli'
  | 'grok-cli'
  | 'cline-cli'
  | 'opencode'
  | 'freebuff-cli';

/** Every provider `collectHistory` reads. Add a reader in main when extending. */
export const AGENT_HISTORY_PROVIDERS: readonly AgentHistoryProvider[] = [
  'claude-code',
  'openclaude',
  'codex',
  'gemini-cli',
  'qwen-cli',
  'cursor-cli',
  'continue-cli',
  'grok-cli',
  'cline-cli',
  'opencode',
  'freebuff-cli',
];

/**
 * CLIs with no readable session store (SQLite-only or no resumable id), or one not mapped yet.
 * Listed explicitly so the provider-coverage test fails loudly when a new
 * CLI is added to `CLI_REGISTRY` without a history decision.
 */
export const HISTORY_UNSUPPORTED_CLIS: readonly string[] = [
  'copilot-cli',
  'aider',
  'goose',
  'pi',
  'muse-code',
];

export interface AgentHistorySession {
  provider: AgentHistoryProvider;
  /** The id the CLI resumes the conversation by. */
  id: string;
  /** A name the user or the CLI gave the conversation, when there is one. */
  title: string | null;
  /** The first thing the user asked, cleaned up for a one-line preview. */
  firstPrompt: string | null;
  /** The most recent thing the user asked, when it differs from the first. */
  lastPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  /** The reasoning effort the session ran at, when the CLI records one. */
  effort: string | null;
  startedAt: number | null;
  updatedAt: number;
  sizeBytes: number;
  /** Started by a tool (`claude -p`, `codex exec`) rather than typed into by a person. */
  background: boolean;
}

export type SessionSummary = Omit<AgentHistorySession, 'provider' | 'updatedAt' | 'sizeBytes'>;

const PREVIEW_LIMIT = 240;

/** Claude Code names a project's transcript folder after its path, every other character a dash. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether two folder paths point at the same place, ignoring separators, a trailing slash and (on Windows) case. */
export function sameFolder(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const slashed = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/**
 * Turns a raw prompt into a preview line, or null when it is not something the user typed:
 * slash command wrappers, command output, system reminders and interrupted-request markers.
 */
export function promptPreview(text: string): string | null {
  const cleaned = cleanPromptText(text)?.replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.length > PREVIEW_LIMIT ? `${cleaned.slice(0, PREVIEW_LIMIT - 1)}…` : cleaned;
}

/**
 * What the user typed in a prompt, in full and with its line breaks, after the same clean-up as
 * `promptPreview`. Null when the text is only a wrapper the user did not type.
 */
export function cleanPromptText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (
    /^<(command-name|command-message|local-command-stdout|local-command-caveat|bash-stdout|bash-stderr)>/.test(
      trimmed,
    ) ||
    trimmed.startsWith('Caveat: The messages below') ||
    trimmed.startsWith('[Request interrupted')
  ) {
    return null;
  }
  const cleaned = trimmed
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, '! $1')
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || null;
}

function parse(line: string): Record<string, unknown> | null {
  if (!line || line[0] !== '{') return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function claudeUserText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null;
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return promptPreview(content);
  if (!Array.isArray(content)) return null;
  // Tool results come back as user messages too; only text blocks are the person talking.
  const text = content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
  return promptPreview(text);
}

/**
 * Summarizes a Claude Code transcript from its first and last lines. Returns null when the
 * file holds no conversation (only snapshots or hook records).
 */
export function summarizeClaudeTranscript(
  id: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: number | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let background = false;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summary: string | null = null;

  const readTitles = (record: Record<string, unknown>): void => {
    if (record.type === 'custom-title') customTitle = str(record.customTitle) ?? customTitle;
    else if (record.type === 'ai-title') aiTitle = str(record.aiTitle) ?? aiTitle;
    else if (record.type === 'summary') summary = str(record.summary) ?? summary;
  };

  for (const line of head) {
    const record = parse(line);
    if (!record) continue;
    readTitles(record);
    startedAt ??= time(record.timestamp);
    if (record.type === 'user' || record.type === 'assistant') {
      cwd ??= str(record.cwd);
      gitBranch ??= str(record.gitBranch);
      if (record.entrypoint === 'sdk-cli' || record.entrypoint === 'sdk-ts') background = true;
    }
    if (record.type === 'assistant') {
      model ??= str((record.message as { model?: unknown } | undefined)?.model);
      effort ??= str(record.perTurnEffort) ?? str(record.effort);
    }
    const text = claudeUserText(record);
    if (text) {
      firstPrompt ??= text;
      lastPrompt = text;
    }
  }

  for (const line of tail) {
    const record = parse(line);
    if (!record) continue;
    readTitles(record);
    if (record.type === 'last-prompt') {
      const text = typeof record.lastPrompt === 'string' ? promptPreview(record.lastPrompt) : null;
      if (text) lastPrompt = text;
    }
    if (record.type === 'assistant') {
      const tailModel = str((record.message as { model?: unknown } | undefined)?.model);
      // Synthetic placeholders are written for interrupted turns; they are not a model.
      if (tailModel && tailModel !== '<synthetic>') model = tailModel;
      effort = str(record.perTurnEffort) ?? str(record.effort) ?? effort;
    }
    if (record.type === 'user' || record.type === 'assistant') {
      gitBranch = str(record.gitBranch) ?? gitBranch;
      cwd ??= str(record.cwd);
    }
    const text = claudeUserText(record);
    if (text) {
      firstPrompt ??= text;
      lastPrompt = text;
    }
  }

  if (!firstPrompt && !customTitle && !aiTitle && !summary) return null;
  return {
    id,
    title: customTitle ?? aiTitle ?? summary,
    firstPrompt,
    lastPrompt: lastPrompt === firstPrompt ? null : lastPrompt,
    cwd,
    gitBranch,
    model: model === '<synthetic>' ? null : model,
    effort,
    startedAt,
    background,
  };
}

/** Just the working folder and id of a Codex rollout, from its first line. */
export function codexRolloutMeta(firstLine: string): {
  id: string;
  cwd: string | null;
  background: boolean;
} | null {
  const record = parse(firstLine);
  if (record?.type !== 'session_meta') return null;
  const payload = record.payload as Record<string, unknown> | undefined;
  const id = str(payload?.id) ?? str(payload?.session_id);
  if (!payload || !id) return null;
  return {
    id,
    cwd: str(payload.cwd),
    background: payload.originator === 'codex_exec' || payload.source === 'exec',
  };
}

/** Summarizes a Codex rollout from its first and last lines. */
export function summarizeCodexRollout(head: string[], tail: string[]): SessionSummary | null {
  const meta = head.length > 0 ? codexRolloutMeta(head[0]) : null;
  if (!meta) return null;
  const firstRecord = parse(head[0]);
  let startedAt = time((firstRecord?.payload as { timestamp?: unknown } | undefined)?.timestamp);
  startedAt ??= time(firstRecord?.timestamp);
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let gitBranch: string | null = null;

  const read = (line: string): void => {
    const record = parse(line);
    const payload = record?.payload as Record<string, unknown> | undefined;
    if (!record || !payload) return;
    if (record.type === 'turn_context') {
      model = str(payload.model) ?? model;
      effort = str(payload.effort) ?? str(payload.reasoning_effort) ?? effort;
    }
    if (record.type === 'session_meta') {
      const git = payload.git as { branch?: unknown } | undefined;
      gitBranch = str(git?.branch) ?? gitBranch;
    }
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      const text = typeof payload.message === 'string' ? promptPreview(payload.message) : null;
      if (text) {
        firstPrompt ??= text;
        lastPrompt = text;
      }
    }
  };
  for (const line of head) read(line);
  for (const line of tail) read(line);

  if (!firstPrompt) return null;
  return {
    id: meta.id,
    title: null,
    firstPrompt,
    lastPrompt: lastPrompt === firstPrompt ? null : lastPrompt,
    cwd: meta.cwd,
    gitBranch,
    model,
    effort,
    startedAt,
    background: meta.background,
  };
}

// --- Gemini / Qwen (Gemini-compatible JSONL chats) ----------------------------

/**
 * Gemini CLI keeps one JSONL chat per session under `~/.gemini/tmp/<hash>/chats/`.
 * Qwen Code is a fork with the same layout under `~/.qwen/`. The first line
 * carries `{sessionId, startTime}`; later lines carry `$set.messages[]` with
 * `{type: 'user', content: [{text}]}`. The folder is resolved by main from the
 * sibling `.project_root`, so the summary's cwd is null here.
 */
export function summarizeGeminiChat(
  fallbackId: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  let id: string | null = null;
  let startedAt: number | null = null;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;

  const readTexts = (line: string): void => {
    const record = parse(line);
    if (!record) return;
    if (typeof record.sessionId === 'string') id ??= record.sessionId;
    startedAt ??= time(record.startTime) ?? time(record.lastUpdated);
    const set = record.$set as { messages?: unknown } | undefined;
    const messages = set?.messages;
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const msg = message as { type?: unknown; content?: unknown };
      if (msg.type !== 'user') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((block) =>
          block &&
          typeof block === 'object' &&
          typeof (block as { text?: unknown }).text === 'string'
            ? String((block as { text?: unknown }).text)
            : '',
        )
        .join(' ');
      // The first user message is always the giant `<session_context>` setup
      // block; skip anything that is only context.
      if (
        text.includes('<session_context>') &&
        !/>\s*\S/.test(text.split('<session_context>')[0] ?? '')
      ) {
        // A message that is mostly context may still end with a real prompt,
        // but the setup message has no user text outside the context block.
        const outside = text.replace(/<session_context>[\s\S]*?(<\/session_context>|$)/, '').trim();
        if (!outside) continue;
      }
      const preview = promptPreview(text);
      if (preview) {
        firstPrompt ??= preview;
        lastPrompt = preview;
      }
    }
  };
  for (const line of head) readTexts(line);
  for (const line of tail) readTexts(line);

  if (!firstPrompt) return null;
  return {
    id: id ?? fallbackId,
    title: null,
    firstPrompt,
    lastPrompt: lastPrompt === firstPrompt ? null : lastPrompt,
    cwd: null,
    gitBranch: null,
    model: null,
    effort: null,
    startedAt,
    background: false,
  };
}

// --- Single-JSON providers (Continue, Cursor prompts, Cline) ------------------

function jsonField(source: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function allUserTexts(source: string): string[] {
  const out: string[] = [];
  const re = /"role"\s*:\s*"user"[\s\S]{0,800}?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    try {
      const text = JSON.parse(`"${match[1]}"`) as string;
      const preview = promptPreview(text);
      if (preview) out.push(preview);
    } catch {
      /* partial write */
    }
    if (out.length > 50) break;
  }
  return out;
}

/**
 * Continue keeps one JSON object per session in `~/.continue/sessions/*.json`
 * with `{sessionId, title, workspaceDirectory: 'file:///...', history[]}`.
 * Files are read as head+tail text chunks, so fields are regex-extracted
 * rather than fully parsed.
 */
export function summarizeContinueSession(
  fallbackId: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  const source = [...head, ...tail].join('\n');
  const id = jsonField(source, 'sessionId') ?? fallbackId;
  const rawTitle = jsonField(source, 'title');
  const title = rawTitle && rawTitle.toLowerCase() !== 'untitled' ? rawTitle : null;
  const workspace = jsonField(source, 'workspaceDirectory');
  let cwd: string | null = null;
  if (workspace) {
    try {
      const url = new URL(workspace);
      const decoded = decodeURIComponent(url.pathname);
      cwd = decoded.replace(/^\/([A-Za-z]:)/, '$1') || null;
    } catch {
      cwd = workspace || null;
    }
  }
  const texts = allUserTexts(source);
  if (texts.length === 0 && !title) return null;
  return {
    id,
    title,
    firstPrompt: texts[0] ?? null,
    lastPrompt:
      texts.length > 1 && texts[texts.length - 1] !== texts[0] ? texts[texts.length - 1] : null,
    cwd,
    gitBranch: null,
    model: jsonField(source, 'model') ?? jsonField(source, 'modelId'),
    effort: null,
    startedAt: null,
    background: false,
  };
}

/**
 * Cursor keeps `~/.cursor/chats/<...>/<id>/meta.json`
 * (`{cwd, title, createdAtMs}`) next to `prompt_history.json` (a JSON array
 * of past prompts). Both chunks are passed in; prompts win over the title.
 */
export function summarizeCursorSession(
  fallbackId: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  const source = [...head, ...tail].join('\n');
  const cwd = jsonField(source, 'cwd');
  const title = jsonField(source, 'title');
  const prompts: string[] = [];
  // prompt_history.json is a JSON array of prompt strings; parse each chunk as
  // one before falling back to string scanning, so meta.json keys ("cwd",
  // "title", paths) never become prompts.
  for (const chunk of [...head, ...tail]) {
    try {
      const parsed: unknown = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== 'string') continue;
          const preview = promptPreview(item);
          if (preview && preview.length > 1) prompts.push(preview);
          if (prompts.length > 50) break;
        }
        continue;
      }
    } catch {
      /* not a whole JSON array; scan below */
    }
  }
  if (prompts.length === 0) {
    const skip = new Set([
      'cwd',
      'title',
      'schemaVersion',
      'createdAtMs',
      'updatedAtMs',
      'hasConversation',
    ]);
    const stringRe = /"((?:[^"\\]|\\.){2,})"/g;
    let match: RegExpExecArray | null;
    while ((match = stringRe.exec(source)) !== null) {
      try {
        const text = JSON.parse(`"${match[1]}"`) as string;
        if (skip.has(text) || text === cwd || text === title || text.length < 2) continue;
        if (/^[A-Za-z]:\\/.test(text) && text.length < 260 && !text.includes(' ')) continue;
        const preview = promptPreview(text);
        if (preview && preview.length > 1) prompts.push(preview);
      } catch {
        /* partial write */
      }
      if (prompts.length > 50) break;
    }
  }
  const firstPrompt = prompts[0] ?? null;
  if (!firstPrompt && !title) return null;
  return {
    id: jsonField(source, 'session_id') ?? fallbackId,
    title,
    firstPrompt,
    lastPrompt:
      prompts.length > 1 && prompts[prompts.length - 1] !== firstPrompt
        ? prompts[prompts.length - 1]
        : null,
    cwd,
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    background: false,
  };
}

/**
 * Cline CLI keeps `~/.cline/data/sessions/<...>/<id>.json` with
 * `{session_id, cwd, prompt, model, started_at}`.
 */
export function summarizeClineSession(
  fallbackId: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  const source = [...head, ...tail].join('\n');
  const id = jsonField(source, 'session_id') ?? fallbackId;
  const prompt = jsonField(source, 'prompt');
  const firstPrompt = prompt
    ? promptPreview(prompt.replace(/<user_input[^>]*>|<\/user_input>/g, ' '))
    : null;
  if (!firstPrompt) return null;
  return {
    id,
    title: jsonField(source, 'title'),
    firstPrompt,
    lastPrompt: null,
    cwd: jsonField(source, 'cwd') ?? jsonField(source, 'workspace_root'),
    gitBranch: null,
    model: jsonField(source, 'model'),
    effort: null,
    startedAt: time(jsonField(source, 'started_at')),
    background: jsonField(source, 'interactive') === 'false',
  };
}

// --- Grok (JSONL chat_history) -------------------------------------------------

/**
 * Grok CLI keeps `~/.grok/sessions/<url-encoded-cwd>/<session-id>/chat_history.jsonl`
 * with `{type: 'user'|'assistant', content: [{text}], model_id}` lines. The
 * folder is encoded in the parent dir name, so cwd is resolved by main.
 */
export function summarizeGrokChat(
  fallbackId: string,
  head: string[],
  tail: string[],
): SessionSummary | null {
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let model: string | null = null;
  const read = (line: string): void => {
    const record = parse(line);
    if (!record) return;
    if (record.type === 'assistant') {
      model = str(record.model_id) ?? model;
      return;
    }
    if (record.type !== 'user') return;
    const content = record.content;
    if (!Array.isArray(content)) return;
    const text = content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? String((block as { text?: unknown }).text)
          : '',
      )
      .join(' ');
    // First user messages are system scaffolding (`<user_info>`, `<rules>`,
    // available-skills dumps); the real ask is wrapped in `<user_query>`.
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)?.[1]?.trim() ?? text;
    if (!query || /^(<user_info>|<rules>|<system-reminder>)/.test(query.trim())) return;
    const preview = promptPreview(query);
    if (preview) {
      firstPrompt ??= preview;
      lastPrompt = preview;
    }
  };
  for (const line of head) read(line);
  for (const line of tail) read(line);
  if (!firstPrompt) return null;
  return {
    id: fallbackId,
    title: null,
    firstPrompt,
    lastPrompt: lastPrompt === firstPrompt ? null : lastPrompt,
    cwd: null,
    gitBranch: null,
    model,
    effort: null,
    startedAt: null,
    background: false,
  };
}

// --- OpenCode (SQLite session store) -------------------------------------------

/** One row of OpenCode's `session` table, as read by main. */
export interface OpencodeSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  /** JSON like `{"id":"model-name","providerID":"..."}`. */
  model: string | null;
  time_created: number | null;
  time_updated: number | null;
}

function opencodeModel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === 'string' && id) return id;
    }
  } catch {
    /* not JSON: fall through */
  }
  return raw || null;
}

/** FreeBuff's per-project data dir holds one folder per project, named for its basename. */
export function freebuffProjectDirName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base || trimmed;
}

/** FreeBuff's `chat-meta.json` sidecar, binding a prompt preview to its transcript. */
export interface FreebuffChatMeta {
  messageCount: number;
  firstPrompt: string;
  messagesSize: number;
  messagesMtimeMs: number;
}

export function parseFreebuffMeta(text: string): FreebuffChatMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.messageCount !== 'number' ||
    typeof record.firstPrompt !== 'string' ||
    typeof record.messagesSize !== 'number' ||
    typeof record.messagesMtimeMs !== 'number'
  ) {
    return null;
  }
  return {
    messageCount: record.messageCount,
    firstPrompt: record.firstPrompt,
    messagesSize: record.messagesSize,
    messagesMtimeMs: record.messagesMtimeMs,
  };
}

function freebuffUserTexts(source: string, limit = 50): string[] {
  const out: string[] = [];
  const re = /"variant"\s*:\s*"user"[\s\S]{0,2000}?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    try {
      const text = JSON.parse(`"${match[1]}"`) as string;
      const preview = promptPreview(text);
      if (preview) out.push(preview);
    } catch {
      /* partial write */
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Summarizes a FreeBuff chat. The sidecar's first prompt wins when it still
 * matches the transcript it was written for (same size and mtime); otherwise
 * the transcript's first and last user messages are read from the chunks.
 * FreeBuff stores no folder, title or model per chat, so those stay null.
 */
export function summarizeFreebuffChat(
  fallbackId: string,
  meta: FreebuffChatMeta | null,
  messagesSize: number,
  messagesMtimeMs: number,
  head: string[],
  tail: string[],
): SessionSummary | null {
  const fresh =
    meta !== null && meta.messagesSize === messagesSize && meta.messagesMtimeMs === messagesMtimeMs;
  const headTexts = freebuffUserTexts(head.join('\n'));
  const tailTexts = freebuffUserTexts(tail.join('\n'));
  const metaPrompt = fresh ? promptPreview(meta.firstPrompt) : null;
  // The CLI writes '(empty chat)' when a chat has no user message yet.
  const usableMeta =
    metaPrompt && metaPrompt !== '(empty chat)' && metaPrompt !== '(unreadable chat)'
      ? metaPrompt
      : null;
  const firstPrompt = usableMeta ?? headTexts[0] ?? null;
  if (!firstPrompt) return null;
  const last =
    tailTexts.length > 0 ? tailTexts[tailTexts.length - 1] : headTexts[headTexts.length - 1];
  return {
    id: fallbackId,
    title: null,
    firstPrompt,
    lastPrompt: last && last !== firstPrompt ? last : null,
    cwd: null,
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    background: false,
  };
}

/**
 * Summarizes an OpenCode session. Untitled sessions are named
 * `New session - <timestamp>` by the CLI, which carries no information and
 * becomes a null title. Epoch times are milliseconds.
 */
export function summarizeOpencodeSession(
  row: OpencodeSessionRow,
  firstPrompt: string | null,
  lastPrompt: string | null,
): SessionSummary | null {
  const title =
    row.title && !/^New session - /.test(row.title) && row.title.toLowerCase() !== 'untitled'
      ? row.title
      : null;
  if (!firstPrompt && !title) return null;
  return {
    id: row.id,
    title,
    firstPrompt,
    lastPrompt: lastPrompt && lastPrompt !== firstPrompt ? lastPrompt : null,
    cwd: row.directory || null,
    gitBranch: null,
    model: opencodeModel(row.model),
    effort: null,
    startedAt: typeof row.time_created === 'number' ? row.time_created : null,
    background: false,
  };
}
