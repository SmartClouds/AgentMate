// @vitest-environment node
import type { Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Handing text to an agent CLI in the workspace: which tab gets it, how it gets there when the
 * CLI isn't ready, and what happens when nothing is running. The terminal runtime, the launcher
 * and the workspace store are stubbed.
 */

const insertText = vi.fn((_id: string, _text: string) => true);
const deliverPrompt = vi.fn((_id: string, _text: string) => Promise.resolve(true));
const focus = vi.fn();
const activateTab = vi.fn();
const launchPromptTab = vi.fn((..._args: unknown[]): string | null => 'new-tab');
const findAgentTerminal = vi.fn();
const warning = vi.fn();
const error = vi.fn();
const writeText = vi.fn((_text: string) => Promise.resolve());
let tabs: Record<string, unknown> = {};
let ended: Record<string, boolean> = {};
let defaultCli: string | null = 'claude-code';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error, warning } }));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: {
    insertText: (id: string, text: string) => insertText(id, text),
    deliverPrompt: (id: string, text: string) => deliverPrompt(id, text),
    focus: (id: string) => focus(id),
  },
  useTerminalSessionStore: { getState: () => ({ ended }) },
}));
vi.mock('@/lib/workspace/agentTarget', () => ({
  findAgentTerminal: () => findAgentTerminal(),
}));
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
  projectCliId: () => defaultCli,
}));
vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ activateTab, workspaces: { p1: { tabs } } }),
  },
}));

const { deliverToAgent } = await import('./agentSend');

const project = { id: 'p1', folderPath: '/repo', cliId: null } as unknown as Project;
const running = { kind: 'terminal', id: 't1', cliId: 'claude-code' };

beforeEach(() => {
  vi.clearAllMocks();
  insertText.mockReturnValue(true);
  deliverPrompt.mockResolvedValue(true);
  launchPromptTab.mockReturnValue('new-tab');
  defaultCli = 'claude-code';
  tabs = { t1: running, t2: { kind: 'terminal', id: 't2', cliId: 'codex-cli' } };
  ended = {};
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText } },
    configurable: true,
  });
});

const build = (cliId: string) => `for ${cliId}`;

describe('deliverToAgent', () => {
  it('pastes into the agent it finds, built for that CLI, and brings it forward', async () => {
    findAgentTerminal.mockReturnValue(running);
    const result = await deliverToAgent(project, { build, what: 'Your comments' });
    expect(insertText).toHaveBeenCalledWith('t1', 'for claude-code');
    expect(activateTab).toHaveBeenCalledWith('p1', 't1');
    expect(focus).toHaveBeenCalledWith('t1');
    expect(result).toEqual({ outcome: 'pasted', tabId: 't1', cliId: 'claude-code' });
  });

  it('pastes into the agent tab it was pointed at', async () => {
    findAgentTerminal.mockReturnValue(running);
    const result = await deliverToAgent(project, { build, what: 'x', target: { tabId: 't2' } });
    expect(insertText).toHaveBeenCalledWith('t2', 'for codex-cli');
    expect(result?.tabId).toBe('t2');
  });

  it('falls back to the usual agent when the one it was pointed at has ended', async () => {
    findAgentTerminal.mockReturnValue(running);
    ended = { t2: true };
    await deliverToAgent(project, { build, what: 'x', target: { tabId: 't2' } });
    expect(insertText).toHaveBeenCalledWith('t1', 'for claude-code');
  });

  it('waits for a CLI that is not ready for a paste yet', async () => {
    findAgentTerminal.mockReturnValue(running);
    insertText.mockReturnValue(false);
    const result = await deliverToAgent(project, { build, what: 'x' });
    expect(deliverPrompt).toHaveBeenCalledWith('t1', 'for claude-code');
    expect(result?.outcome).toBe('pasted');
  });

  it('puts the text on the clipboard when the CLI never takes it', async () => {
    findAgentTerminal.mockReturnValue(running);
    insertText.mockReturnValue(false);
    deliverPrompt.mockResolvedValue(false);
    const result = await deliverToAgent(project, { build, what: 'Your comments' });
    expect(writeText).toHaveBeenCalledWith('for claude-code');
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: 'Your comments are on your clipboard, ready to paste.',
      }),
    );
    expect(result?.outcome).toBe('clipboard');
  });

  it('starts the default CLI when no agent is running', async () => {
    findAgentTerminal.mockReturnValue(null);
    const result = await deliverToAgent(project, { build, what: 'x' });
    expect(launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'claude-code',
      prompt: 'for claude-code',
    });
    expect(focus).toHaveBeenCalledWith('new-tab');
    expect(result).toEqual({ outcome: 'launched', tabId: 'new-tab', cliId: 'claude-code' });
  });

  it('starts a new tab of the CLI it was asked for', async () => {
    findAgentTerminal.mockReturnValue(running);
    await deliverToAgent(project, { build, what: 'x', target: { newCliId: 'codex-cli' } });
    expect(launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'codex-cli',
      prompt: 'for codex-cli',
    });
    expect(insertText).not.toHaveBeenCalled();
  });

  it('says so and gives nothing back without any CLI to use', async () => {
    findAgentTerminal.mockReturnValue(null);
    defaultCli = null;
    expect(await deliverToAgent(project, { build, what: 'x' })).toBeNull();
    expect(error).toHaveBeenCalledWith('No agent CLI to ask', expect.anything());
  });

  it('gives nothing back when the new tab could not start', async () => {
    findAgentTerminal.mockReturnValue(null);
    launchPromptTab.mockReturnValue(null);
    expect(await deliverToAgent(project, { build, what: 'x' })).toBeNull();
  });
});
