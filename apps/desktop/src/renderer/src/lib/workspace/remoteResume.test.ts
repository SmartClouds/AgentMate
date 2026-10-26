import type { AgentHistorySession } from '@runova/core';
import type { SshSavedServer } from '@shared/apiTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { TERMINAL_DEFAULT_HEIGHT, useTerminalStore } from '@/stores/terminalStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import {
  openRemoteResume,
  prepareStatusHooks,
  remoteResumeCommand,
  resumedConversationId,
  statusHooksReady,
} from './launch';

/**
 * Resuming a conversation stored on a saved server: the command an SSH tab types, and the tab
 * that types it. The command runs on the server, so it is always quoted for a POSIX shell, and
 * it never carries status hooks (their settings file only exists on this machine).
 */

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { deliverPrompt: vi.fn(() => Promise.resolve(true)) },
}));

const server = { id: 'srv-1', nickname: 'build box' } as SshSavedServer;

function conversation(overrides: Partial<AgentHistorySession> = {}): AgentHistorySession {
  return {
    provider: 'claude-code',
    id: 'abc-12345',
    title: null,
    firstPrompt: 'Fix the flaky tests',
    lastPrompt: null,
    cwd: '/srv/app',
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    updatedAt: 0,
    sizeBytes: 0,
    background: false,
    ...overrides,
  };
}

function terminal() {
  return useTerminalStore.getState();
}

beforeEach(() => {
  installRunovaBridge({ platform: 'win32' });
  useCliStore.setState({ cliLaunchDefaults: {} });
  useTerminalStore.setState({
    isOpen: false,
    drawerHeight: TERMINAL_DEFAULT_HEIGHT,
    sessions: [],
    activeSessionId: null,
  });
});

describe('remoteResumeCommand', () => {
  it('changes into the folder, then resumes Claude Code', () => {
    expect(remoteResumeCommand(conversation())).toBe(
      'cd -- /srv/app && claude --resume abc-12345\r',
    );
  });

  it('puts the resume words right after codex', () => {
    expect(remoteResumeCommand(conversation({ provider: 'codex', id: '0199aabb-cc' }))).toBe(
      'cd -- /srv/app && codex resume 0199aabb-cc\r',
    );
  });

  it('quotes a folder with spaces and a single quote for a POSIX shell', () => {
    expect(remoteResumeCommand(conversation({ cwd: "/home/me/Bob's app" }))).toBe(
      "cd -- '/home/me/Bob'\\''s app' && claude --resume abc-12345\r",
    );
  });

  it('skips the cd when the conversation has no folder', () => {
    expect(remoteResumeCommand(conversation({ cwd: null }))).toBe('claude --resume abc-12345\r');
    expect(remoteResumeCommand(conversation({ cwd: '' }))).toBe('claude --resume abc-12345\r');
  });

  it('keeps the launch defaults from Settings', () => {
    const command = remoteResumeCommand(conversation(), { model: 'opus', mode: 'plan' });
    expect(command).toContain('--model opus');
    expect(command).toContain('--permission-mode plan');
    expect(command).toContain('--resume abc-12345');
  });

  it('never adds status hooks, whose settings file only exists on this machine', async () => {
    // Local tabs of both CLIs would carry this hook file by now.
    installRunovaBridge({
      platform: 'win32',
      'agents.statusHookSettings': async () => 'C:\\hooks.json',
    });
    prepareStatusHooks(['claude-code', 'codex-cli']);
    await statusHooksReady('claude-code');
    await statusHooksReady('codex-cli');
    expect(remoteResumeCommand(conversation())).not.toContain('--settings');
    expect(remoteResumeCommand(conversation({ provider: 'codex' }))).not.toContain('--settings');
  });

  it('names the conversation the way a resumed tab is recognised', () => {
    expect(resumedConversationId(remoteResumeCommand(conversation()) ?? undefined)).toBe(
      'abc-12345',
    );
    const codex = remoteResumeCommand(conversation({ provider: 'codex', id: '0199aabb-cc' }));
    expect(resumedConversationId(codex ?? undefined)).toBe('0199aabb-cc');
  });

  it('resumes every provider with its own CLI command', () => {
    // Regression test: adding a history provider must add its resume command too.
    const cases: { provider: AgentHistorySession['provider']; contains: string }[] = [
      { provider: 'claude-code', contains: 'claude' },
      { provider: 'openclaude', contains: 'openclaude' },
      { provider: 'codex', contains: 'codex resume' },
      { provider: 'gemini-cli', contains: 'gemini' },
      { provider: 'qwen-cli', contains: 'qwen' },
      { provider: 'cursor-cli', contains: 'cursor-agent' },
      { provider: 'continue-cli', contains: 'cn' },
      { provider: 'grok-cli', contains: 'grok' },
      { provider: 'cline-cli', contains: 'cline' },
      { provider: 'opencode', contains: 'opencode --session' },
      { provider: 'freebuff-cli', contains: 'freebuff --continue' },
    ];
    for (const { provider, contains } of cases) {
      const command = remoteResumeCommand(conversation({ provider, id: 'sess-0102' }));
      expect(command, provider).toContain(contains);
      expect(command, provider).toContain('sess-0102');
      expect(resumedConversationId(command ?? undefined), provider).toBe('sess-0102');
    }
  });

  it('maps every history provider to a known CLI', async () => {
    const { AGENT_HISTORY_PROVIDERS } = await import('@runova/core');
    const { HISTORY_CLI_ID } = await import('./launch');
    const { CLI_REGISTRY } = await import('@runova/core');
    const ids = new Set(CLI_REGISTRY.map((cli) => cli.id));
    for (const provider of AGENT_HISTORY_PROVIDERS) {
      const cliId = HISTORY_CLI_ID[provider];
      expect(cliId, provider).toBeTruthy();
      expect(ids.has(cliId), provider).toBe(true);
    }
  });
});

describe('openRemoteResume', () => {
  it('opens an SSH tab on the server that types the resume command', () => {
    useCliStore.setState({ cliLaunchDefaults: { 'claude-code': { model: 'opus' } } });

    const id = openRemoteResume(server, conversation());

    expect(id).not.toBeNull();
    expect(terminal().sessions).toEqual([
      expect.objectContaining({
        id,
        title: 'build box · Fix the flaky tests',
        kind: 'ssh',
        sshServerId: 'srv-1',
        initialInput: 'cd -- /srv/app && claude --model opus --resume abc-12345\r',
        conversationId: 'abc-12345',
      }),
    ]);
    expect(terminal().activeSessionId).toBe(id);
    expect(terminal().isOpen).toBe(true);
  });

  it('prefers the title and shortens a long one', () => {
    openRemoteResume(server, conversation({ title: 'A'.repeat(60) }));
    const title = terminal().sessions[0].title;
    expect(title.startsWith('build box · AAAA')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual('build box · '.length + 40);
  });

  it('goes back to the tab already resuming that conversation', () => {
    const first = openRemoteResume(server, conversation());
    terminal().openDefaultSession();
    terminal().closeDrawer();

    const again = openRemoteResume(server, conversation());

    expect(again).toBe(first);
    expect(terminal().sessions).toHaveLength(2);
    expect(terminal().activeSessionId).toBe(first);
    expect(terminal().isOpen).toBe(true);
  });

  it('opens a separate tab for the same conversation on another server', () => {
    const first = openRemoteResume(server, conversation());
    const other = openRemoteResume({ ...server, id: 'srv-2' }, conversation());
    expect(other).not.toBe(first);
    expect(terminal().sessions).toHaveLength(2);
  });
});
