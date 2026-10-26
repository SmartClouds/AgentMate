import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { openCliInTerminal } from './openCli';

/**
 * `cliLaunchCommand` itself is covered next to the workspace launch helpers; what matters here
 * is the drawer session that gets opened with it.
 */
const errors = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('sonner', () => ({
  toast: { error: vi.fn((message: unknown) => errors.messages.push(message)) },
}));

beforeEach(() => {
  errors.messages = [];
  installRunovaBridge({ platform: 'win32' });
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {} });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

describe('openCliInTerminal', () => {
  it('opens a drawer tab that types the CLI is command and presses Enter', () => {
    expect(openCliInTerminal({ cliId: 'claude-code' })).toBe(true);
    const { sessions, isOpen, activeSessionId } = useTerminalStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ title: 'Claude Code CLI', initialInput: 'claude\r' });
    expect(activeSessionId).toBe(sessions[0].id);
    // Opening a CLI is also the user asking to see the drawer.
    expect(isOpen).toBe(true);
  });

  it('carries the launch defaults into the command, never the background task arguments', () => {
    useCliStore.setState({
      cliArgs: { 'claude-code': '--model haiku --verbose' },
      cliLaunchDefaults: { 'claude-code': { model: 'sonnet' } },
    });
    openCliInTerminal({ cliId: 'claude-code' });
    expect(useTerminalStore.getState().sessions[0].initialInput).toBe('claude --model sonnet\r');
  });

  it('starts the CLI in the folder and project it was asked for', () => {
    openCliInTerminal({ cliId: 'claude-code', cwd: 'E:\\proj', projectId: 'p1' });
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      cwd: 'E:\\proj',
      projectId: 'p1',
    });
  });

  it('opens nothing and says so for a CLI it does not know', () => {
    expect(openCliInTerminal({ cliId: 'not-a-cli' })).toBe(false);
    expect(useTerminalStore.getState().sessions).toEqual([]);
    expect(errors.messages).toEqual(['Unknown CLI.']);
  });
});
