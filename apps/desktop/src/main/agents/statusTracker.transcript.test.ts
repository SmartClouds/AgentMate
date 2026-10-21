import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc/send', () => ({ broadcastToWindows: () => undefined }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: () => undefined }));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: () => true }));
vi.mock('../power/keepAwake', () => ({ keepAwake: { setBusy: () => undefined } }));
vi.mock('../worktrees/resolve', () => ({ scopeDisplayName: () => null }));
vi.mock('../store', () => ({
  store: { getSettings: async () => ({}), updateSettings: async () => undefined },
}));

const { agentStatus } = await import('./statusTracker');

/**
 * Claude Code names its transcript on SessionStart, before it has written the file. The Relay
 * context meter reads that path later, so it must be kept even though it cannot be watched yet.
 */
describe('agentStatus transcript path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-transcript-'));

  afterEach(() => {
    agentStatus.unpin('leg-1');
    agentStatus.sync([]);
  });

  it('keeps a transcript path reported before the file exists', async () => {
    agentStatus.pin({ sessionId: 'leg-1', projectId: 'p1', cliId: 'claude-code', title: 'T001' });
    const path = join(dir, 'not-yet.jsonl');
    await agentStatus.runInfo('leg-1', { transcriptPath: path });
    expect(agentStatus.transcriptPath('leg-1')).toBe(path);

    // Once the file is there, a later hook with the same path starts watching it.
    writeFileSync(path, '');
    await agentStatus.runInfo('leg-1', { transcriptPath: path });
    expect(agentStatus.transcriptPath('leg-1')).toBe(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a path that is not a transcript', async () => {
    agentStatus.pin({ sessionId: 'leg-1', projectId: 'p1', cliId: 'claude-code', title: 'T001' });
    await agentStatus.runInfo('leg-1', { transcriptPath: 'relative/t.jsonl' });
    expect(agentStatus.transcriptPath('leg-1')).toBeNull();
  });
});
