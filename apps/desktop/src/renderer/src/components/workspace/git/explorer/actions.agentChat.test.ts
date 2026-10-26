// @vitest-environment node
import type { Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Add to agent chat" from the explorer: which terminal the file references go to and how they
 * get there. The terminal runtime, the launcher and the workspace store are stubbed.
 */

const insertText = vi.fn((_id: string, _text: string) => true);
const deliverPrompt = vi.fn((_id: string, _text: string) => Promise.resolve(true));
const focus = vi.fn();
const activateTab = vi.fn();
const launchPromptTab = vi.fn((..._args: unknown[]) => 'new-tab');
const findAgentTerminal = vi.fn();
let defaultCli: string | null = 'claude-code';
const listings: Record<string, { name: string; path: string; isDirectory: boolean }[]> = {};

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: {
    insertText: (id: string, text: string) => insertText(id, text),
    deliverPrompt: (id: string, text: string) => deliverPrompt(id, text),
    focus: (id: string) => focus(id),
  },
}));
vi.mock('@/lib/workspace/agentTarget', () => ({
  findAgentTerminal: () => findAgentTerminal(),
}));
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: (...args: unknown[]) => launchPromptTab(...args),
  launchShellTab: vi.fn(),
  projectCliId: () => defaultCli,
}));
vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ activateTab }) },
}));
vi.mock('@/queryClient', () => ({
  queryClient: {
    getQueryData: (key: unknown[]) => listings[String(key.at(-1))],
    invalidateQueries: vi.fn(),
  },
}));
vi.mock('@/lib/queryKeys', () => ({
  queryKeys: {
    workspaceExplorer: (projectId: string) => ['explorer', projectId],
    workspaceExplorerDir: (projectId: string, dir: string) => ['explorer', projectId, dir],
  },
}));

const { sendPathsToAgent } = await import('./actions');

const project = { id: 'p1', folderPath: '/repo', cliId: null } as unknown as Project;

beforeEach(() => {
  vi.clearAllMocks();
  insertText.mockReturnValue(true);
  defaultCli = 'claude-code';
  listings['/repo/src'] = [
    { name: 'app.ts', path: '/repo/src/app.ts', isDirectory: false },
    { name: 'lib', path: '/repo/src/lib', isDirectory: true },
  ];
});

describe('sendPathsToAgent', () => {
  it('pastes references into the running agent and brings it forward', () => {
    findAgentTerminal.mockReturnValue({ kind: 'terminal', id: 't1', cliId: 'claude-code' });
    sendPathsToAgent(project, ['/repo/src/app.ts', '/repo/src/lib']);
    expect(insertText).toHaveBeenCalledWith('t1', '@src/app.ts @src/lib/ ');
    expect(activateTab).toHaveBeenCalledWith('p1', 't1');
    expect(focus).toHaveBeenCalledWith('t1');
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(launchPromptTab).not.toHaveBeenCalled();
  });

  it('drops paths inside a folder that is also selected', () => {
    findAgentTerminal.mockReturnValue({ kind: 'terminal', id: 't1', cliId: 'claude-code' });
    sendPathsToAgent(project, ['/repo/src/lib', '/repo/src/lib/a.ts']);
    expect(insertText).toHaveBeenCalledWith('t1', '@src/lib/ ');
  });

  it('waits for a CLI that is not ready for a paste yet', () => {
    findAgentTerminal.mockReturnValue({ kind: 'terminal', id: 't1', cliId: 'codex-cli' });
    insertText.mockReturnValue(false);
    sendPathsToAgent(project, ['/repo/src/app.ts']);
    expect(deliverPrompt).toHaveBeenCalledWith('t1', '@src/app.ts ');
  });

  it('starts the default CLI when no agent is running', () => {
    findAgentTerminal.mockReturnValue(null);
    sendPathsToAgent(project, ['/repo/src/app.ts']);
    expect(launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'claude-code',
      prompt: '@src/app.ts ',
    });
    expect(focus).toHaveBeenCalledWith('new-tab');
  });

  it('does nothing for the project root', () => {
    findAgentTerminal.mockReturnValue({ kind: 'terminal', id: 't1', cliId: 'claude-code' });
    sendPathsToAgent(project, ['/repo']);
    expect(insertText).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it('launches nothing without a default CLI', () => {
    findAgentTerminal.mockReturnValue(null);
    defaultCli = null;
    sendPathsToAgent(project, ['/repo/src/app.ts']);
    expect(launchPromptTab).not.toHaveBeenCalled();
  });
});
