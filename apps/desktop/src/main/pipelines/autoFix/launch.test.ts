import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An auto-fix tab runs with nobody in front of it, so the CLI has to start in a mode that edits
 * and runs checks without asking (or it sits on its first question), and the prompt has to be
 * submitted as well as pasted.
 */

const io = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  createResult: { ok: true } as unknown,
  pinned: [] as Record<string, unknown>[],
  unpinned: [] as string[],
  delivered: [] as string[],
  deliverResult: true,
  notifications: [] as Record<string, unknown>[],
  clipboard: [] as string[],
}));

vi.mock('../../ipc/terminal', () => ({
  defaultTerminalShell: () => 'powershell.exe',
  createTerminalSession: async (options: Record<string, unknown>) => {
    io.created.push(options);
    return io.createResult;
  },
  subscribeTerminalOutput: () => () => undefined,
  writeToShell: () => undefined,
}));
vi.mock('../../agents/statusTracker', () => ({
  agentStatus: {
    pin: (entry: Record<string, unknown>) => io.pinned.push(entry),
    unpin: (id: string) => io.unpinned.push(id),
  },
}));
vi.mock('../../agents/claudeHooks', () => ({
  claudeHookSettingsPath: async () => 'C:/hooks/claude-settings.json',
  supportsStatusHooks: (cliId: string) => cliId === 'claude-code',
}));
vi.mock('../../relay/delivery', () => ({
  deliverWhenReady: async (text: string) => {
    io.delivered.push(text);
    return io.deliverResult;
  },
}));
vi.mock('../../store', () => ({
  store: { getSettings: async () => ({ cliLaunchDefaults: { 'codex-cli': { model: 'gpt-6' } } }) },
}));
vi.mock('../../notifications/osNotification', () => ({
  showOsNotification: (input: Record<string, unknown>) => io.notifications.push(input),
}));
vi.mock('electron', () => ({
  clipboard: { writeText: (text: string) => io.clipboard.push(text) },
}));

const { autoFixModeArgs, buildAutoFixCommand, launchAutoFixAgent } = await import('./launch');

beforeEach(() => {
  io.created = [];
  io.createResult = { ok: true };
  io.pinned = [];
  io.unpinned = [];
  io.delivered = [];
  io.deliverResult = true;
  io.notifications = [];
  io.clipboard = [];
});

describe('autoFixModeArgs', () => {
  it('starts each CLI in the mode that works without asking, short of skipping every check', () => {
    expect(autoFixModeArgs('claude-code')).toEqual(['--permission-mode', 'auto']);
    expect(autoFixModeArgs('codex-cli')).toEqual(['--approve-for-me']);
    expect(autoFixModeArgs('gemini-cli')).toEqual(['--approval-mode', 'auto_edit']);
    expect(autoFixModeArgs('copilot-cli')).toEqual(['--mode', 'autopilot']);
  });

  it('adds nothing for a CLI without such a mode, leaving its saved one', () => {
    expect(autoFixModeArgs('aider')).toEqual([]);
    expect(autoFixModeArgs('nope')).toEqual([]);
  });
});

describe('buildAutoFixCommand', () => {
  it('puts the status hooks, the mode and the model on Claude Code', () => {
    expect(
      buildAutoFixCommand({
        cliId: 'claude-code',
        shellKind: 'powershell',
        hookSettingsPath: 'C:/hooks/claude-settings.json',
        runArgs: ['--model', 'opus'],
      }),
    ).toBe('claude --settings C:/hooks/claude-settings.json --permission-mode auto --model opus');
  });

  it('keeps a saved model but not a saved mode, which could be plan', () => {
    const command = buildAutoFixCommand({
      cliId: 'claude-code',
      shellKind: 'powershell',
      hookSettingsPath: null,
      runArgs: [],
      launchDefaults: { mode: 'plan', model: 'haiku' },
    });
    expect(command).toContain('--model haiku');
    expect(command).not.toContain('plan');
  });

  it('is null for a CLI Runova does not know', () => {
    expect(
      buildAutoFixCommand({
        cliId: 'nope',
        shellKind: 'posix',
        hookSettingsPath: null,
        runArgs: [],
      }),
    ).toBeNull();
  });
});

describe('launchAutoFixAgent', () => {
  const request = {
    sessionId: 'fix-1',
    projectId: 'proj-1',
    cwd: '/work/shop',
    cliId: 'claude-code',
    runArgs: [],
    runLabel: 'Opus 5.5',
    runNumber: 7,
    attempt: 2,
    prompt: 'Fix the run.\nline two',
  };

  it('starts a workspace session, pins it, and pastes the whole prompt', async () => {
    const launched = await launchAutoFixAgent(request);
    expect(launched.hooks).toBe(true);
    expect(io.created[0]).toMatchObject({
      sessionId: launched.tabId,
      cwd: '/work/shop',
      projectId: 'proj-1',
      cliId: 'claude-code',
      surface: 'workspace',
      initialInput: 'claude --settings C:/hooks/claude-settings.json --permission-mode auto\r',
    });
    expect(io.pinned[0]).toMatchObject({ sessionId: launched.tabId, projectId: 'proj-1' });
    await vi.waitFor(() => expect(io.delivered).toEqual(['Fix the run.\nline two']));
    expect(launched.tab).toEqual({
      projectId: 'proj-1',
      tabId: launched.tabId,
      sessionId: 'fix-1',
      cliId: 'claude-code',
      title: 'Auto-fix #7 · Claude Code CLI',
      runLabel: 'Attempt 2 · Opus 5.5',
      cwd: '/work/shop',
    });
  });

  it('reports a CLI without hooks, so its silence is judged with care', async () => {
    const launched = await launchAutoFixAgent({ ...request, cliId: 'codex-cli', runLabel: null });
    expect(launched.hooks).toBe(false);
    expect(String(io.created[0].initialInput)).toContain('gpt-6');
    expect(launched.tab.runLabel).toBe('Attempt 2');
  });

  it('hands the prompt to the user when the CLI never comes up', async () => {
    io.deliverResult = false;
    const launched = await launchAutoFixAgent(request);
    await vi.waitFor(() => expect(io.clipboard).toEqual(['Fix the run.\nline two']));
    expect(io.notifications[0]).toMatchObject({
      route: `/workspace/proj-1?session=${launched.tabId}`,
    });
  });

  it('unpins and throws when the terminal does not start', async () => {
    io.createResult = null;
    await expect(launchAutoFixAgent(request)).rejects.toThrow('The terminal could not start.');
    expect(io.unpinned).toHaveLength(1);
  });

  it('throws for an unknown CLI before starting anything', async () => {
    await expect(launchAutoFixAgent({ ...request, cliId: 'nope' })).rejects.toThrow(/nope/);
    expect(io.created).toEqual([]);
  });
});
