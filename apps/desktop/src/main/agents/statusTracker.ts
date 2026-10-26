import { type FSWatcher, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  type AgentHookEvent,
  type AgentStatus,
  type AgentStatusState,
  CLAUDE_FAMILIES,
  getCliDefinition,
  initialAgentStatus,
  reduceAgentStatus,
} from '@runova/core';
import type {
  AgentRunInfo,
  AgentRunInfoMap,
  AgentSessionEntry,
  AgentStatusMap,
  LastRunInfoByCli,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { getMainWindow } from '../mainWindow';
import { showOsNotification } from '../notifications/osNotification';
import { speakOnPet } from '../notifications/petNotifier';
import { keepAwake } from '../power/keepAwake';
import { store } from '../store';
import { scopeDisplayName } from '../worktrees/resolve';

/**
 * Follows what the agent in each workspace tab is doing, from the output stream and (for
 * Claude Code) its hooks. Lives in main because main sees every session's output, including
 * tabs that are not on screen, and because notifications have to fire with the window hidden.
 */

interface Tracked {
  state: AgentStatusState;
  projectId: string;
  cliId?: string;
  title: string;
}

/** How much of a transcript's end to scan for the model the latest reply came from. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const runInfos = new Map<string, AgentRunInfo>();

/** "Set model to `Opus 5.5 (1M context)`", for every Claude family the model catalog knows. */
const MODEL_SWITCH_LINE = new RegExp(
  `^\\s*<local-command-stdout>Set model to (?:.\\[1m|\`)?(${CLAUDE_FAMILIES.join('|')}) (\\d+(?:\\.\\d+)*)( \\(1M context\\))?`,
  'i',
);

/**
 * The model id a `/model` switch in a transcript picked. Claude Code records only the display
 * name ("Set model to `Opus 5.5 (1M context)`"), so this turns the usual family names back into
 * an id and leaves anything else (e.g. "Default") alone.
 */
function modelFromSwitchLine(line: string): string | undefined {
  try {
    const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    const content = entry.message?.content;
    if (entry.type !== 'user' || typeof content !== 'string') return undefined;
    const match = MODEL_SWITCH_LINE.exec(content);
    if (!match) return undefined;
    const [, family, version, longContext] = match;
    return `claude-${family.toLowerCase()}-${version.replace(/\./g, '-')}${longContext ? '[1m]' : ''}`;
  } catch {
    return undefined;
  }
}

/**
 * The model of the newest assistant reply in a Claude Code transcript, or of a `/model` switch
 * made after it. Reading it each turn is what keeps the tab current after a switch mid-session.
 */
async function modelFromTranscript(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      // A `/model` switch newer than the last reply: the next reply comes from that model.
      if (line?.includes('Set model to')) {
        const switched = modelFromSwitchLine(line);
        if (switched) return switched;
      }
      if (!line?.includes('"assistant"') || !line.includes('"model"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
        const model = entry.message?.model;
        if (entry.type === 'assistant' && typeof model === 'string' && !model.startsWith('<')) {
          return model;
        }
      } catch {
        // The first line of the tail is usually cut in half.
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return undefined;
}

/**
 * Transcripts being watched, by session id, so a `/model` switch shows before any hook fires. A
 * path reported before Claude Code has written the file (SessionStart comes first) is kept with no
 * watcher: the Relay context meter still needs to know where to read, and the next hook tries to
 * watch it again.
 */
const followed = new Map<
  string,
  { path: string; watcher: FSWatcher | null; timer?: NodeJS.Timeout }
>();

function unfollowTranscript(id: string): void {
  const follow = followed.get(id);
  if (!follow) return;
  clearTimeout(follow.timer);
  follow.watcher?.close();
  followed.delete(id);
}

/**
 * Re-reads a session's transcript whenever Claude Code writes to it. The hooks only fire around
 * prompts, so without this a `/model` switch stayed hidden until the next reply finished.
 */
function followTranscript(id: string, path: string): void {
  const current = followed.get(id);
  if (current?.path === path && current.watcher) return;
  unfollowTranscript(id);
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return;
  const follow: { path: string; watcher: FSWatcher | null; timer?: NodeJS.Timeout } = {
    path,
    watcher: null,
  };
  followed.set(id, follow);
  try {
    follow.watcher = watch(path, { persistent: false }, () => {
      clearTimeout(follow.timer);
      follow.timer = setTimeout(() => void agentStatus.runInfo(id, {}), 300);
    });
    follow.watcher.on('error', () => unfollowTranscript(id));
  } catch {
    // The transcript may not exist yet; the next hook tries again.
  }
}

let lastRunInfoWrite: Promise<unknown> = Promise.resolve();

/**
 * Remembers the model and effort a CLI was last actually run on, across app restarts, so a
 * fresh tab for that CLI can be opened the same way instead of some other default. Chained
 * onto the previous write so two hooks landing close together don't race each other's
 * read-modify-write and drop one.
 */
function persistLastRunInfo(cliId: string, model: string, effort?: string): Promise<void> {
  lastRunInfoWrite = lastRunInfoWrite
    .catch(() => undefined)
    .then(async () => {
      const known = await store.getLastRunInfoByCli();
      if (known[cliId]?.model === model && known[cliId]?.effort === effort) return;
      const next: LastRunInfoByCli = { ...known, [cliId]: { model, effort } };
      await store.setLastRunInfoByCli(next);
    });
  return lastRunInfoWrite as Promise<void>;
}

const TICK_MS = 500;
const BROADCAST_MS = 100;
/** Two agents finishing together make one notification, not a burst. */
const NOTIFY_COALESCE_MS = 1500;

const tracked = new Map<string, Tracked>();
let ticker: NodeJS.Timeout | null = null;
let pendingBroadcast: AgentStatusMap | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;
let viewing: { visible: Set<string>; focused: string | null } = {
  visible: new Set(),
  focused: null,
};
let pendingNotices: { id: string; status: AgentStatus; hookMessage?: string }[] = [];
/**
 * Sessions main started itself (Relay legs). They are tracked from the start, before any tab
 * shows them, and a sync from a renderer that has not added their tab yet does not drop them.
 */
const pinned = new Set<string>();
const statusListeners = new Set<(id: string, status: AgentStatus) => void>();
let noticeTimer: NodeJS.Timeout | null = null;

function broadcastLater(id: string, status: AgentStatus): void {
  pendingBroadcast ??= {};
  pendingBroadcast[id] = status;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = pendingBroadcast;
    pendingBroadcast = null;
    if (!payload) return;
    broadcastToWindows(IPC.agents.onStatus, payload);
  }, BROADCAST_MS);
}

function syncTicker(): void {
  const anyWorking = [...tracked.values()].some((t) => t.state.status === 'working');
  // What "stay awake while an agent is working" watches.
  keepAwake.setBusy('agents', anyWorking);
  if (anyWorking && !ticker) {
    ticker = setInterval(() => {
      const at = Date.now();
      for (const id of tracked.keys()) apply(id, { type: 'tick', at });
    }, TICK_MS);
  } else if (!anyWorking && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function isLookingAt(id: string): boolean {
  const win = getMainWindow();
  return Boolean(win?.isFocused() && !win.isMinimized() && viewing.visible.has(id));
}

async function flushNotices(): Promise<void> {
  noticeTimer = null;
  const notices = pendingNotices.filter(({ id }) => tracked.has(id) && !isLookingAt(id));
  pendingNotices = [];
  if (notices.length === 0) return;
  const settings = await store.getSettings().catch(() => null);

  const needsInput = notices.filter((n) => n.status === 'needs-input');
  // A question outranks a finished run: it is the one blocking work.
  const lead = needsInput[0] ?? notices[0];
  const entry = tracked.get(lead.id);
  if (!entry) return;
  const agent = (entry.cliId && getCliDefinition(entry.cliId)?.name) || 'Agent';
  const project = (entry.projectId && (await scopeDisplayName(entry.projectId))) || 'Workspace';
  const others = notices.length - 1;
  const isQuestion = lead.status === 'needs-input';

  if (!(settings && settings.workspaceNotifications === false)) {
    const title = isQuestion ? `${agent} needs your input` : `${agent} finished`;
    const where = `${project}: ${entry.title}`;
    const body = [
      lead.hookMessage ? `${where}\n${lead.hookMessage}` : where,
      others > 0 ? `and ${others} more tab${others === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const route = `/workspace/${entry.projectId}?session=${encodeURIComponent(lead.id)}`;
    if (showOsNotification({ title, body, route }) && needsInput.length > 0) {
      getMainWindow()?.flashFrame(true);
    }
  }

  if (settings?.desktopPetAgentStatus) {
    const text = isQuestion
      ? `${agent} needs your input in ${entry.title}.`
      : `${agent} finished in ${entry.title}.`;
    speakOnPet(settings, project, text, isQuestion ? 'warn' : 'pass');
  }
}

function queueNotice(id: string, status: AgentStatus, hookMessage?: string): void {
  pendingNotices = pendingNotices.filter((n) => n.id !== id);
  pendingNotices.push({ id, status, hookMessage });
  if (!noticeTimer) noticeTimer = setTimeout(() => void flushNotices(), NOTIFY_COALESCE_MS);
}

function apply(
  id: string,
  event: Parameters<typeof reduceAgentStatus>[1],
  hookMessage?: string,
): void {
  const entry = tracked.get(id);
  if (!entry) return;
  const before = entry.state.status;
  entry.state = reduceAgentStatus(entry.state, event);
  const after = entry.state.status;
  if (after === before) return;
  for (const listener of statusListeners) listener(id, after);
  broadcastLater(id, after);
  syncTicker();
  if ((after === 'done' || after === 'needs-input') && !isLookingAt(id)) {
    queueNotice(id, after, hookMessage);
  }
}

export const agentStatus = {
  /**
   * Makes the tracked set match the workspace's terminal tabs. New ids start tracking,
   * known ones get their names refreshed, and ids that are gone stop.
   */
  sync(entries: AgentSessionEntry[]): string[] {
    const wanted = new Set(entries.map((e) => e.sessionId));
    for (const id of [...tracked.keys()]) {
      if (wanted.has(id) || pinned.has(id)) continue;
      tracked.delete(id);
      unfollowTranscript(id);
    }
    const added: string[] = [];
    for (const entry of entries) {
      const existing = tracked.get(entry.sessionId);
      if (existing) {
        existing.title = entry.title;
        existing.projectId = entry.projectId;
        existing.cliId = entry.cliId;
        continue;
      }
      tracked.set(entry.sessionId, {
        state: initialAgentStatus(Boolean(entry.cliId)),
        projectId: entry.projectId,
        cliId: entry.cliId,
        title: entry.title,
      });
      added.push(entry.sessionId);
    }
    syncTicker();
    return added;
  },

  output(id: string, bytes: number): void {
    apply(id, { type: 'output', bytes, at: Date.now() });
  },
  input(id: string): void {
    apply(id, { type: 'input', at: Date.now() });
  },
  resize(id: string): void {
    apply(id, { type: 'resize', at: Date.now() });
  },
  exit(id: string): void {
    apply(id, { type: 'exit', at: Date.now() });
  },
  hook(id: string, event: AgentHookEvent, message?: string): boolean {
    if (!tracked.has(id)) return false;
    apply(id, { type: 'hook', event, at: Date.now() }, message);
    return true;
  },
  /** Best-effort nudge for CLIs with no hooks: their output looked like a question. */
  guessNeedsInput(id: string): void {
    apply(id, { type: 'guess-needs-input', at: Date.now() });
  },
  acknowledge(id: string): void {
    apply(id, { type: 'ack' });
  },

  setViewing(visible: string[], focused: string | null): void {
    viewing = { visible: new Set(visible), focused };
    // Looking at a tab that asked for attention is the acknowledgement.
    const win = getMainWindow();
    if (win?.isFocused()) {
      win.flashFrame(false);
      for (const id of visible) {
        if (tracked.get(id)?.state.status === 'done') apply(id, { type: 'ack' });
      }
    }
  },

  /** Records the model and effort an agent reports, telling the renderer when either changed. */
  async runInfo(
    id: string,
    input: { model?: string; effort?: string; transcriptPath?: string },
  ): Promise<void> {
    if (!tracked.has(id)) return;
    if (input.transcriptPath) followTranscript(id, input.transcriptPath);
    const current = runInfos.get(id) ?? {};
    const transcriptPath = input.transcriptPath ?? followed.get(id)?.path;
    const fromTranscript = transcriptPath ? await modelFromTranscript(transcriptPath) : undefined;
    const next: AgentRunInfo = {
      model: fromTranscript ?? input.model ?? current.model,
      effort: input.effort ?? current.effort,
      // Claude Code names the transcript after the session, which `--resume` takes.
      conversationId: input.transcriptPath
        ? basename(input.transcriptPath, '.jsonl')
        : current.conversationId,
    };
    if (
      next.model === current.model &&
      next.effort === current.effort &&
      next.conversationId === current.conversationId
    ) {
      return;
    }
    runInfos.set(id, next);
    broadcastToWindows(IPC.agents.onRunInfo, { [id]: next } satisfies AgentRunInfoMap);
    // So the next fresh launch of this CLI starts on what it was actually last run
    // on, not a default computed elsewhere in the app.
    const cliId = tracked.get(id)?.cliId;
    if (cliId && next.model) void persistLastRunInfo(cliId, next.model, next.effort);
  },

  /** Starts tracking a session main started, whatever the renderer's tabs say. */
  pin(entry: AgentSessionEntry): void {
    pinned.add(entry.sessionId);
    if (!tracked.has(entry.sessionId)) {
      tracked.set(entry.sessionId, {
        state: initialAgentStatus(Boolean(entry.cliId)),
        projectId: entry.projectId,
        cliId: entry.cliId,
        title: entry.title,
      });
      syncTicker();
    }
  },

  /** Leaves a pinned session to the renderer's tabs again. */
  unpin(id: string): void {
    pinned.delete(id);
  },

  /** Calls `listener` whenever a session's status changes, until the returned function runs. */
  subscribe(listener: (id: string, status: AgentStatus) => void): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },

  status(id: string): AgentStatus | null {
    return tracked.get(id)?.state.status ?? null;
  },

  /** The transcript a Claude Code session reported through its hooks, if it did. */
  transcriptPath(id: string): string | null {
    return followed.get(id)?.path ?? null;
  },

  model(id: string): string | undefined {
    return runInfos.get(id)?.model;
  },

  runInfos(): AgentRunInfoMap {
    return Object.fromEntries([...runInfos].filter(([id]) => tracked.has(id)));
  },

  list(): AgentStatusMap {
    const map: AgentStatusMap = {};
    for (const [id, entry] of tracked) map[id] = entry.state.status;
    return map;
  },

  /** The project's session most in need of a reply, for routing an answer typed elsewhere. */
  sessionAwaitingInput(projectId: string): string | null {
    for (const [id, entry] of tracked) {
      if (entry.projectId === projectId && entry.state.status === 'needs-input') return id;
    }
    return null;
  },
};
