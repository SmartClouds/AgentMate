/**
 * The chat view of an agent CLI's conversation, rebuilt from the transcript the CLI writes while
 * it runs. Each CLI has a reader that folds new transcript lines into a `ChatState`.
 */

/** What a tool call does, which picks its icon and how its details are shown. */
export type ChatToolKind = 'shell' | 'read' | 'edit' | 'search' | 'web' | 'task' | 'plan' | 'other';

export type ChatToolStatus = 'running' | 'ok' | 'error';

/** A single replaced span of a file, enough to draw a small diff. */
export interface ChatEdit {
  path: string;
  before: string;
  after: string;
}

interface ChatItemBase {
  /** Stable across re-reads, so a list can key on it and a later line can update the item. */
  key: string;
  at: number | null;
}

export type ChatItem =
  | (ChatItemBase & { kind: 'user'; text: string })
  | (ChatItemBase & { kind: 'assistant'; text: string })
  | (ChatItemBase & { kind: 'thinking'; text: string })
  | (ChatItemBase & {
      kind: 'tool';
      callId: string;
      name: string;
      toolKind: ChatToolKind;
      /** One line: the file, command or query the call is about. */
      title: string;
      /** The full command, path, pattern or patch, when there is more than the title shows. */
      detail: string | null;
      edit: ChatEdit | null;
      status: ChatToolStatus;
      output: string | null;
    })
  | (ChatItemBase & { kind: 'notice'; text: string; tone: 'info' | 'warning' | 'error' });

export type ChatToolItem = Extract<ChatItem, { kind: 'tool' }>;

export interface ChatState {
  items: ChatItem[];
  /** Where each key sits in `items`. */
  index: Record<string, number>;
  /** Counts lines read so far, for formats whose records carry no id of their own. */
  seq: number;
}

/** Folds transcript lines (complete ones only) into the chat, leaving the given state untouched. */
export type ChatReader = (state: ChatState, lines: string[]) => ChatState;

export function emptyChatState(): ChatState {
  return { items: [], index: {}, seq: 0 };
}

/** A copy of the state that one batch of lines can change in place. */
export function draft(state: ChatState): ChatState {
  return { items: [...state.items], index: { ...state.index }, seq: state.seq };
}

/** Adds an item, or replaces the one with the same key where it already is. */
export function upsert(state: ChatState, item: ChatItem): void {
  const at = state.index[item.key];
  if (at === undefined) {
    state.index[item.key] = state.items.length;
    state.items.push(item);
  } else {
    state.items[at] = item;
  }
}

export function find(state: ChatState, key: string): ChatItem | undefined {
  const at = state.index[key];
  return at === undefined ? undefined : state.items[at];
}

export function parseLine(line: string): Record<string, unknown> | null {
  if (!line || line[0] !== '{') return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** The text blocks of a content list, joined, or the content itself when it is a string. */
export function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const value = record(block);
      return typeof value?.text === 'string' ? value.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const TOOL_KINDS: [RegExp, ChatToolKind][] = [
  [
    /^(bash|shell|exec_command|local_shell|run_shell_command|powershell|run_terminal_cmd)$/i,
    'shell',
  ],
  [/^(read|read_file|read_many_files|view_image|notebookread|ls|list_directory)$/i, 'read'],
  [/^(edit|multiedit|write|write_file|replace|apply_patch|notebookedit)$/i, 'edit'],
  [/^(grep|glob|search_file_content|find|codebase_search|toolsearch)$/i, 'search'],
  [/^(webfetch|websearch|web_fetch|google_web_search|web_search)$/i, 'web'],
  [/^(task|agent)$/i, 'task'],
  [/^(todowrite|update_plan|write_todos|exitplanmode)$/i, 'plan'],
];

export function toolKindOf(name: string): ChatToolKind {
  for (const [pattern, kind] of TOOL_KINDS) if (pattern.test(name)) return kind;
  return 'other';
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * The title, detail and edit of a tool call from its input, reading the argument names the
 * three CLIs use. Anything unknown falls back to the tool's own name.
 */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
): Pick<ChatToolItem, 'toolKind' | 'title' | 'detail' | 'edit'> {
  const toolKind = toolKindOf(name);
  const path = text(input.file_path) ?? text(input.absolute_path) ?? text(input.path);
  const command = Array.isArray(input.command)
    ? shellCommand(input.command.map(String))
    : (text(input.command) ?? text(input.cmd));
  const description = text(input.description);
  let title = name;
  let detail: string | null = null;
  let edit: ChatEdit | null = null;

  if (toolKind === 'shell' && command) {
    title = description ?? firstLine(command);
    detail = command;
  } else if (toolKind === 'edit' && path) {
    title = fileName(path);
    detail = path;
    const before = typeof input.old_string === 'string' ? input.old_string : null;
    const after =
      typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.content === 'string'
          ? input.content
          : null;
    if (after !== null) edit = { path, before: before ?? '', after };
  } else if (path) {
    title = fileName(path);
    detail = path;
  } else if (toolKind === 'search' || toolKind === 'web') {
    const query = text(input.pattern) ?? text(input.query) ?? text(input.url) ?? text(input.prompt);
    if (query) title = firstLine(query);
  } else if (description) {
    title = firstLine(description);
  }
  return { toolKind, title, detail, edit };
}

/** A command given as an argument list, without the `bash -lc` wrapper Codex puts around it. */
function shellCommand(argv: string[]): string {
  if (argv.length === 3 && /(^|[\\/])(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) {
    return argv[2];
  }
  if (argv.length >= 2 && /powershell|pwsh/i.test(argv[0])) {
    const at = argv.findIndex((arg) => /^-c(ommand)?$/i.test(arg));
    if (at >= 0 && argv[at + 1]) return argv.slice(at + 1).join(' ');
  }
  return argv.join(' ');
}
