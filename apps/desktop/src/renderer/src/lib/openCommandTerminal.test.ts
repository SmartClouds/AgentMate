import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { openCommandTerminal } from './openCommandTerminal';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const NODE = { name: 'Node.js', url: 'https://nodejs.org/en/download' };

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge({ 'cli.checkCommandPrerequisite': async () => null });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
});

describe('openCommandTerminal', () => {
  it('types the command into a new terminal and tells the user to press Enter', async () => {
    const opened = await openCommandTerminal({
      command: 'npm install -g @google/gemini-cli',
      name: 'Gemini CLI',
      verb: 'install',
    });

    expect(opened).toBe(true);
    expect(bridge.$fn('cli.checkCommandPrerequisite')).toHaveBeenCalledWith(
      'npm install -g @google/gemini-cli',
    );
    const { sessions } = useTerminalStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      title: 'Install Gemini CLI',
      initialInput: 'npm install -g @google/gemini-cli',
    });
    expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to install Gemini CLI.');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('names the session after the verb', async () => {
    await openCommandTerminal({
      command: 'claude update',
      name: 'Claude Code CLI',
      verb: 'update',
    });
    await openCommandTerminal({
      command: 'pipx uninstall semgrep',
      name: 'Semgrep',
      verb: 'uninstall',
    });

    expect(useTerminalStore.getState().sessions.map((one) => one.title)).toEqual([
      'Update Claude Code CLI',
      'Uninstall Semgrep',
    ]);
  });

  it('points at the missing tool instead of opening a terminal that would fail', async () => {
    bridge.$set('cli.checkCommandPrerequisite', NODE);

    const opened = await openCommandTerminal({
      command: 'npm install -g @google/gemini-cli',
      name: 'Gemini CLI',
      verb: 'install',
    });

    expect(opened).toBe(false);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Gemini CLI needs Node.js, which isn't installed.",
      expect.objectContaining({ description: 'Install Node.js, then try again.' }),
    );

    // The toast's button takes the user to the download page.
    const { action } = toast.error.mock.calls[0][1] as {
      action: { label: string; onClick: () => void };
    };
    expect(action.label).toBe('Get Node.js');
    action.onClick();
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(NODE.url);
  });

  it('still opens the terminal when the check itself fails', async () => {
    bridge.$set('cli.checkCommandPrerequisite', async () => {
      throw new Error('ipc gone');
    });

    const opened = await openCommandTerminal({
      command: 'npm install -g @google/gemini-cli',
      name: 'Gemini CLI',
      verb: 'install',
    });

    expect(opened).toBe(true);
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
