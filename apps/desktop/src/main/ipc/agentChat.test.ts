import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
} from '../../test/main/ipcHarness';

/**
 * The chat view's half of the agents IPC: a tab in chat mode subscribes to its session's
 * transcript, gets what is there, and is sent each line the CLI adds until it unsubscribes.
 */

const tracker = vi.hoisted(() => ({ transcriptPath: vi.fn((_id: string): string | null => null) }));
vi.mock('../agents/statusTracker', () => ({ agentStatus: tracker }));

const history = vi.hoisted(() => ({
  liveTranscriptCandidates: vi.fn(async () => [] as { path: string; startedAt: number | null }[]),
  localHistoryFs: { scope: 'local' },
}));
vi.mock('../agents/sessionHistory', () => history);

expectChannelsCovered(IPC.agentChat, [IPC.agentChat.onAppend]);

const spec = {
  sessionId: 'tab-1',
  cliId: 'claude-code',
  cwd: 'E:\\proj',
  startedAt: Date.parse('2026-10-30T05:00:00.000Z'),
};

let dir: string;
let file: string;
let module: typeof import('./agentChat');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'runova-chat-ipc-'));
  file = join(dir, 'abc.jsonl');
  tracker.transcriptPath.mockImplementation(() => file);
  module = await loadIpc(
    () => import('./agentChat'),
    (m) => m.registerAgentChatHandlers({ pollMs: 20 }),
  );
});

afterEach(() => {
  module.disposeAgentChat();
  rmSync(dir, { recursive: true, force: true });
});

describe('agentChat IPC', () => {
  it('answers with the transcript so far and sends what is added to the tab that asked', async () => {
    writeFileSync(file, '{"a":1}\n');
    const sender = fakeWebContents();
    expect(await invokeFrom(sender, IPC.agentChat.subscribe, spec)).toEqual({
      status: 'ready',
      lines: ['{"a":1}'],
    });
    expect(tracker.transcriptPath).toHaveBeenCalledWith('tab-1');

    appendFileSync(file, '{"b":2}\n');
    await vi.waitFor(() =>
      expect(sender.sentOn(IPC.agentChat.onAppend)).toEqual([
        [{ sessionId: 'tab-1', lines: ['{"b":2}'], reset: false }],
      ]),
    );
  });

  it('finds a Codex transcript among the folder rollouts', async () => {
    writeFileSync(file, '{"a":1}\n');
    history.liveTranscriptCandidates.mockResolvedValueOnce([
      { path: file, startedAt: spec.startedAt + 1_000 },
    ]);
    const result = await invoke(IPC.agentChat.subscribe, { ...spec, cliId: 'codex-cli' });
    expect(result).toEqual({ status: 'ready', lines: ['{"a":1}'] });
    expect(history.liveTranscriptCandidates).toHaveBeenCalledWith(
      history.localHistoryFs,
      'codex-cli',
      'E:\\proj',
    );
  });

  it('stops sending once the tab unsubscribes', async () => {
    writeFileSync(file, '{"a":1}\n');
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.agentChat.subscribe, spec);
    await invoke(IPC.agentChat.unsubscribe, 'tab-1');
    appendFileSync(file, '{"b":2}\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sender.sentOn(IPC.agentChat.onAppend)).toEqual([]);
  });

  it('refuses a request that is not a chat session', async () => {
    for (const bad of [null, 'tab-1', { ...spec, sessionId: '../x' }, { ...spec, cwd: 3 }]) {
      expect(await invoke(IPC.agentChat.subscribe, bad)).toEqual({ status: 'waiting' });
    }
    expect(tracker.transcriptPath).not.toHaveBeenCalled();
  });
});
