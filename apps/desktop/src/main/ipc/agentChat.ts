import { ipcMain, type WebContents } from 'electron';
import type { ChatSessionSpec, ChatSubscribeResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { type ChatFollower, createChatFollower, locateTranscript } from '../agents/chatTranscript';
import { liveTranscriptCandidates, localHistoryFs } from '../agents/sessionHistory';
import { agentStatus } from '../agents/statusTracker';

/** Same shape as a terminal session id, which is what a chat view's session id is. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isSpec(value: unknown): value is ChatSessionSpec {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Record<string, unknown>;
  return (
    typeof spec.sessionId === 'string' &&
    SESSION_ID.test(spec.sessionId) &&
    typeof spec.cliId === 'string' &&
    typeof spec.cwd === 'string' &&
    spec.cwd.length > 0 &&
    typeof spec.startedAt === 'number' &&
    Number.isFinite(spec.startedAt) &&
    (spec.conversationId === undefined || typeof spec.conversationId === 'string')
  );
}

let follower: ChatFollower | null = null;
/** The window showing each session's chat, which is where its new lines go. */
const owners = new Map<string, WebContents>();

export function registerAgentChatHandlers(options: { pollMs?: number } = {}): void {
  follower = createChatFollower({
    pollMs: options.pollMs,
    locate: (spec, claimed) =>
      locateTranscript(
        {
          claudeTranscriptPath: (id) => agentStatus.transcriptPath(id),
          candidates: (cliId, cwd) => liveTranscriptCandidates(localHistoryFs, cliId, cwd),
        },
        spec,
        claimed,
      ),
    send: (payload) => {
      const owner = owners.get(payload.sessionId);
      if (!owner || owner.isDestroyed()) {
        // The window is gone, so nothing is showing this chat any more.
        owners.delete(payload.sessionId);
        follower?.unsubscribe(payload.sessionId);
        return;
      }
      owner.send(IPC.agentChat.onAppend, payload);
    },
  });

  ipcMain.handle(
    IPC.agentChat.subscribe,
    async (event, spec: unknown): Promise<ChatSubscribeResult> => {
      if (!isSpec(spec) || !follower) return { status: 'waiting' };
      owners.set(spec.sessionId, event.sender);
      return follower.subscribe(spec);
    },
  );

  ipcMain.handle(IPC.agentChat.unsubscribe, (_event, sessionId: unknown): void => {
    if (typeof sessionId !== 'string') return;
    owners.delete(sessionId);
    follower?.unsubscribe(sessionId);
  });
}

/** Stops reading every transcript, when the app quits (and between tests). */
export function disposeAgentChat(): void {
  follower?.dispose();
  owners.clear();
}
