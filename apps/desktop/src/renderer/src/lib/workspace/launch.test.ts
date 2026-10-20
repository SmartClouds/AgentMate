// @vitest-environment node
import type { Project } from '@agentmat/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The launch helpers against the real CLI store, with only the terminal side stubbed out. What
 * they hand the workspace as `launchInput` is exactly what the new tab types into its shell.
 */

const addTerminal = vi.fn(
  (_projectId: string, _tab: { launchInput?: string; runLabel?: string }) => 'tab-1',
);

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { deliverPrompt: vi.fn(() => Promise.resolve(true)) },
}));
vi.mock('@/stores/terminalStore', () => ({
  defaultNewSession: () => ({ title: 'Terminal', shell: 'powershell.exe' }),
  useTerminalStore: { getState: () => ({ openSession: vi.fn() }) },
}));
vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ openProject: vi.fn(), addTerminal }) },
}));

const settingsUpdate = vi.fn((_patch: unknown) => Promise.resolve({}));

function stubAgentmate(hookPath: string | null = null): void {
  vi.stubGlobal('window', {
    agentmat: {
      platform: 'win32',
      settings: { update: settingsUpdate },
      agents: { statusHookSettings: vi.fn(() => Promise.resolve(hookPath)) },
    },
  });
}

const project = { id: 'p1', folderPath: 'E:\\proj', cliId: null } as unknown as Project;

async function load() {
  const { useCliStore } = await import('@/stores/cliStore');
  const launch = await import('./launch');
  const openCli = await import('@/lib/openCli');
  return { useCliStore, ...launch, ...openCli };
}

function typed(): string | undefined {
  return addTerminal.mock.calls.at(-1)?.[1].launchInput;
}

// The first import transforms the whole store graph, which takes several seconds on a busy
// machine and used to land inside the first test's 15 second limit. The transform is cached, so
// the imports after `vi.resetModules()` are quick.
beforeAll(async () => {
  stubAgentmate();
  await load();
  vi.unstubAllGlobals();
}, 60_000);

beforeEach(() => {
  vi.resetModules();
  addTerminal.mockClear();
  settingsUpdate.mockClear();
  stubAgentmate();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('launchAgentTab', () => {
  it('starts Claude Code with no flags when nothing is saved', async () => {
    const { launchAgentTab } = await load();
    expect(launchAgentTab(project, 'claude-code')).toBe('tab-1');
    expect(typed()).toBe('claude\r');
  });

  it('ignores what the CLI was last run on', async () => {
    // Release builds before the fix turned this into `--model haiku` on every new tab.
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({
      lastRunInfoByCli: { 'claude-code': { model: 'claude-haiku-4-5', effort: 'low' } },
    });
    launchAgentTab(project, 'claude-code');
    expect(typed()).toBe('claude\r');
    expect(typed()).not.toContain('--model');
  });

  it('sends the launch defaults from Settings', async () => {
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({ cliLaunchDefaults: { 'claude-code': { mode: 'auto' } } });
    launchAgentTab(project, 'claude-code');
    expect(typed()).toBe('claude --permission-mode auto\r');
  });

  it('never sends the background task arguments from AI CLI Manager', async () => {
    // A `--model haiku` saved there for commit messages used to start every new tab on Haiku.
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({
      cliArgs: { 'claude-code': '--model haiku --verbose' },
      cliLaunchDefaults: { 'claude-code': { mode: 'auto' } },
    });
    launchAgentTab(project, 'claude-code');
    expect(typed()).toBe('claude --permission-mode auto\r');
  });

  it('starts bare when asked to skip launch defaults', async () => {
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({
      cliLaunchDefaults: { 'claude-code': { model: 'opus', mode: 'plan' } },
    });
    launchAgentTab(project, 'claude-code', undefined, { skipLaunchDefaults: true });
    expect(typed()).toBe('claude\r');
  });

  it('starts on the model and effort picked for this launch', async () => {
    const { launchAgentTab } = await load();
    launchAgentTab(project, 'claude-code', undefined, {
      runArgs: ['--model', 'opus', '--effort', 'high'],
      runLabel: 'Opus 5.5 · High',
    });
    expect(typed()).toBe('claude --model opus --effort high\r');
    expect(addTerminal.mock.calls.at(-1)?.[1].runLabel).toBe('Opus 5.5 · High');
  });

  it('lets a pick win over the saved model and keep the rest of the launch defaults', async () => {
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({
      cliLaunchDefaults: { 'claude-code': { model: 'haiku', effort: 'low', mode: 'plan' } },
    });
    launchAgentTab(project, 'claude-code', undefined, { runArgs: ['--model', 'opus'] });
    expect(typed()).toBe('claude --effort low --permission-mode plan --model opus\r');
  });

  it('keeps a pick when asked to skip launch defaults', async () => {
    const { useCliStore, launchAgentTab } = await load();
    useCliStore.setState({
      cliLaunchDefaults: { 'claude-code': { effort: 'low', mode: 'plan' } },
    });
    launchAgentTab(project, 'claude-code', undefined, {
      skipLaunchDefaults: true,
      runArgs: ['--model', 'opus'],
    });
    expect(typed()).toBe('claude --model opus\r');
    expect(addTerminal.mock.calls.at(-1)?.[1].runLabel).toBe('Without launch defaults');
  });

  it('adds status hooks once they have been prepared', async () => {
    stubAgentmate('C:\\Users\\A B\\hooks.json');
    const { prepareStatusHooks, launchAgentTab } = await load();
    prepareStatusHooks(['claude-code']);
    await vi.waitFor(() => {
      launchAgentTab(project, 'claude-code');
      expect(typed()).toBe("claude --settings 'C:\\Users\\A B\\hooks.json'\r");
    });
  });

  it('opens nothing for an unknown CLI', async () => {
    const { launchAgentTab } = await load();
    expect(launchAgentTab(project, 'nope')).toBeNull();
    expect(addTerminal).not.toHaveBeenCalled();
  });
});

describe('launchPromptTab', () => {
  it('lets the model picked for the run beat the launch default', async () => {
    const { useCliStore, launchPromptTab } = await load();
    useCliStore.setState({
      cliArgs: { 'claude-code': '--model haiku --verbose' },
      cliLaunchDefaults: { 'claude-code': { model: 'sonnet', mode: 'auto' } },
    });
    launchPromptTab(project, {
      cliId: 'claude-code',
      prompt: 'hello',
      runArgs: ['--model', 'opus', '--effort', 'high'],
    });
    expect(typed()).toBe('claude --permission-mode auto --model opus --effort high\r');
  });
});

describe('launchResumeTab', () => {
  it('resumes Claude Code without adding a model', async () => {
    const { launchResumeTab } = await load();
    launchResumeTab(project, { provider: 'claude-code', id: 'abc', title: 'x', firstPrompt: '' });
    expect(typed()).toBe('claude --resume abc\r');
  });

  it('puts the resume words right after codex', async () => {
    const { launchResumeTab } = await load();
    launchResumeTab(project, { provider: 'codex', id: 'abc', title: 'x', firstPrompt: '' });
    expect(typed()).toBe('codex resume abc\r');
  });
});

describe('resumeInputFor', () => {
  const tab = {
    kind: 'terminal' as const,
    id: 't1',
    title: 'Claude Code',
    cwd: 'E:\\proj',
    createdAt: 0,
    shell: 'powershell.exe',
  };

  it('resumes the conversation the agent reported', async () => {
    const { resumeInputFor } = await load();
    expect(resumeInputFor({ ...tab, cliId: 'claude-code', conversationId: 'abc-123' })).toBe(
      'claude --resume abc-123\r',
    );
  });

  it('falls back to the conversation a resumed tab was opened on', async () => {
    const { resumeInputFor } = await load();
    expect(
      resumeInputFor({ ...tab, cliId: 'codex-cli', launchInput: 'codex resume 0199aabbcc\r' }),
    ).toBe('codex resume 0199aabbcc\r');
  });

  it('waits for the status hooks so the resumed agent reports its status', async () => {
    stubAgentmate('C:\\hooks.json');
    const { prepareStatusHooks, statusHooksReady, resumeInputFor } = await load();
    prepareStatusHooks(['claude-code']);
    await statusHooksReady('claude-code');
    expect(resumeInputFor({ ...tab, cliId: 'claude-code', conversationId: 'abc-123' })).toBe(
      'claude --settings C:\\hooks.json --resume abc-123\r',
    );
  });

  it('has nothing to resume without a conversation, or for a plain shell', async () => {
    const { resumeInputFor } = await load();
    expect(resumeInputFor({ ...tab, cliId: 'claude-code', launchInput: 'claude\r' })).toBeNull();
    expect(resumeInputFor({ ...tab, conversationId: 'abc-123' })).toBeNull();
  });
});

describe('cliLaunchCommand', () => {
  it('matches what a workspace tab types, without hooks', async () => {
    const { useCliStore, cliLaunchCommand } = await load();
    expect(cliLaunchCommand('claude-code')).toBe('claude');
    useCliStore.setState({
      cliArgs: { 'claude-code': '--verbose' },
      cliLaunchDefaults: { 'claude-code': { model: 'sonnet' } },
    });
    expect(cliLaunchCommand('claude-code')).toBe('claude --model sonnet');
  });
});

describe('background task arguments never reach a terminal', () => {
  // Regression guard: the AI CLI Manager Arguments box is for background tasks only. A
  // `--model haiku` saved there once started every new workspace tab on Haiku. Every CLI and
  // every way of opening a terminal is swept, so a new launch path that reads them shows up here.
  const BACKGROUND_ONLY = '--agentmate-background-only --model background-only-model';

  async function loadWithBackgroundArgs() {
    const loaded = await load();
    const { CLI_REGISTRY } = await import('@agentmat/core');
    loaded.useCliStore.setState({
      cliArgs: Object.fromEntries(CLI_REGISTRY.map((cli) => [cli.id, BACKGROUND_ONLY])),
      cliLaunchDefaults: {},
    });
    return { ...loaded, CLI_REGISTRY };
  }

  function expectClean(command: string | null | undefined, where: string): void {
    expect(command, where).toBeTruthy();
    expect(command, where).not.toContain('agentmate-background-only');
    expect(command, where).not.toContain('background-only-model');
  }

  it('leaves them out of every launch for every CLI', async () => {
    const { CLI_REGISTRY, launchAgentTab, launchPromptTab, cliLaunchCommand } =
      await loadWithBackgroundArgs();
    for (const cli of CLI_REGISTRY) {
      expectClean(cliLaunchCommand(cli.id), `${cli.id}: cliLaunchCommand`);
      expectClean(
        cliLaunchCommand(cli.id, ['--effort', 'high']),
        `${cli.id}: cliLaunchCommand with run args`,
      );

      launchAgentTab(project, cli.id);
      expectClean(typed(), `${cli.id}: launchAgentTab`);
      launchAgentTab(project, cli.id, undefined, { skipLaunchDefaults: true });
      expectClean(typed(), `${cli.id}: launchAgentTab without launch defaults`);

      launchAgentTab(project, cli.id, undefined, { runArgs: ['--effort', 'high'], runLabel: 'x' });
      expectClean(typed(), `${cli.id}: launchAgentTab with a pick`);

      launchPromptTab(project, { cliId: cli.id, prompt: 'hello', runArgs: ['--effort', 'high'] });
      expectClean(typed(), `${cli.id}: launchPromptTab`);
    }
  });

  it('leaves them out of resumed conversations', async () => {
    const { launchResumeTab, resumeInputFor } = await loadWithBackgroundArgs();
    for (const provider of ['claude-code', 'codex'] as const) {
      launchResumeTab(project, { provider, id: 'abc', title: 'x', firstPrompt: '' });
      expectClean(typed(), `${provider}: launchResumeTab`);
    }
    const tab = {
      kind: 'terminal' as const,
      id: 't1',
      title: 'Agent',
      cwd: 'E:\proj',
      createdAt: 0,
      shell: 'powershell.exe',
      conversationId: 'abc-123',
    };
    expectClean(resumeInputFor({ ...tab, cliId: 'claude-code' }), 'claude-code: resumeInputFor');
    expectClean(resumeInputFor({ ...tab, cliId: 'codex-cli' }), 'codex-cli: resumeInputFor');
  });

  it('still sends the launch defaults next to them', async () => {
    const { useCliStore, launchAgentTab } = await loadWithBackgroundArgs();
    useCliStore.setState({ cliLaunchDefaults: { 'claude-code': { model: 'opus' } } });
    launchAgentTab(project, 'claude-code');
    expect(typed()).toBe('claude --model opus\r');
  });
});

describe('launchSetupTab', () => {
  it('runs the setup command in a tab of its own that closes once it succeeds', async () => {
    const { launchSetupTab } = await load();
    expect(launchSetupTab(project, 'pnpm install')).toBe('tab-1');
    expect(addTerminal).toHaveBeenLastCalledWith(
      'p1',
      {
        title: 'Setup',
        shell: 'powershell.exe',
        cwd: 'E:\\proj',
        launchInput: 'pnpm install; if ($?) { exit }\r',
      },
      undefined,
    );
  });

  it('uses the exit that the shell understands', async () => {
    const { setupInput } = await load();
    expect(setupInput('npm ci', 'cmd.exe', 'win32')).toBe('npm ci && exit\r');
    expect(setupInput('npm ci', 'bash', 'linux')).toBe('npm ci && exit\r');
    expect(setupInput('npm ci', 'fish', 'darwin')).toBe('npm ci; and exit\r');
  });
});
