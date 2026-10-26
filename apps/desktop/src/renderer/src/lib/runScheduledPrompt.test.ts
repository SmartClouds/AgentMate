import { beforeEach, describe, expect, it } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { resolveRunCliId, runPromptInTerminal } from './runScheduledPrompt';

/**
 * A scheduled prompt has to start in the project folder, in the CLI it was scheduled for, with
 * its model and effort, and actually be submitted. Before this helper the Run button opened the
 * terminal in the home folder and left the command sitting unsent.
 */

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge({
    platform: 'win32',
    'fs.writeScratchFile': async () => 'C:\\tmp\\scheduled-task-t1.md',
  });
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {}, defaultCliId: null });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

function run(overrides: Partial<Parameters<typeof runPromptInTerminal>[0]> = {}) {
  return runPromptInTerminal({
    projectId: 'p1',
    cwd: 'C:\\code\\apollo',
    content: 'fix the login bug',
    fileKey: 'scheduled-task-t1',
    targetAI: 'Claude Code',
    ...overrides,
  });
}

describe('resolveRunCliId', () => {
  it('prefers the task CLI, then the app default, then the target AI', () => {
    expect(resolveRunCliId('codex-cli', 'Claude Code')).toBe('codex-cli');
    useCliStore.setState({ defaultCliId: 'codex-cli' });
    expect(resolveRunCliId(undefined, 'Claude Code')).toBe('codex-cli');
    useCliStore.setState({ defaultCliId: null });
    expect(resolveRunCliId(undefined, 'Claude Code')).toBe('claude-code');
  });

  it('skips a CLI id that no longer exists', () => {
    expect(resolveRunCliId('gone-cli', 'Claude Code')).toBe('claude-code');
  });
});

describe('runPromptInTerminal', () => {
  it('opens the CLI in the project folder with its model and effort, and submits it', async () => {
    const name = await run({ cliId: 'claude-code', model: 'opus', effort: 'high' });

    expect(name).toBe('Claude Code CLI');
    expect(bridge.$fn('fs.writeScratchFile')).toHaveBeenCalledWith(
      'scheduled-task-t1.md',
      'fix the login bug',
    );
    const [session] = useTerminalStore.getState().sessions;
    expect(session).toMatchObject({ cwd: 'C:\\code\\apollo', projectId: 'p1' });
    expect(session.initialInput).toContain('--model opus');
    expect(session.initialInput).toContain('--effort high');
    expect(session.initialInput).toContain(
      'Get-Content -Raw -LiteralPath "C:\\tmp\\scheduled-task-t1.md"',
    );
    expect(session.initialInput?.endsWith('\r')).toBe(true);
  });

  it('drops model and effort when it falls back to a different CLI', async () => {
    useCliStore.setState({ defaultCliId: 'codex-cli' });

    await run({ model: 'opus', effort: 'high' });

    const [session] = useTerminalStore.getState().sessions;
    expect(session.initialInput).not.toContain('opus');
  });

  it('uses a POSIX shell line off Windows', async () => {
    bridge.$set('platform', 'darwin');
    bridge.$set('fs.writeScratchFile', async () => '/tmp/scheduled-task-t1.md');

    await run({ cliId: 'claude-code' });

    const [session] = useTerminalStore.getState().sessions;
    expect(session.initialInput).toContain(`"$(cat '/tmp/scheduled-task-t1.md')"`);
  });
});
