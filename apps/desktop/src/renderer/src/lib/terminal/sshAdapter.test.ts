import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { sshTerminalAdapter } from './sshAdapter';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge({
    'ssh.create': async () => ({ sessionId: 'ssh-1' }),
  });
});

describe('sshTerminalAdapter', () => {
  it('connects to the saved server and reports a fresh session', () => {
    const adapter = sshTerminalAdapter('server-1');
    return adapter.create({ sessionId: 's1', cols: 80, rows: 24 }).then((result) => {
      expect(bridge.$fn('ssh.create')).toHaveBeenCalledWith({
        sessionId: 's1',
        savedServerId: 'server-1',
        cols: 80,
        rows: 24,
      });
      // SSH sessions never reattach in v1, so there is never a snapshot to paint.
      expect(result).toEqual({ sessionId: 'ssh-1', isNew: true, snapshot: null });
    });
  });

  it('connects with no options at all', async () => {
    await sshTerminalAdapter('server-1').create();
    expect(bridge.$fn('ssh.create')).toHaveBeenCalledWith({
      sessionId: undefined,
      savedServerId: 'server-1',
      cols: undefined,
      rows: undefined,
    });
  });

  it('passes the input to type once the shell opens', async () => {
    // A resumed conversation types its resume command into the fresh shell.
    await sshTerminalAdapter('server-1').create({
      sessionId: 's1',
      initialInput: 'claude --resume abc-12345\r',
    });
    expect(bridge.$fn('ssh.create')).toHaveBeenCalledWith(
      expect.objectContaining({ initialInput: 'claude --resume abc-12345\r' }),
    );
  });

  it('strips Electron is IPC boilerplate off a connect failure', async () => {
    // What is left is the line shown in the terminal pane, so it has to be the real reason.
    bridge = installRunovaBridge({
      'ssh.create': async () => {
        throw new Error(
          "Error invoking remote method 'ssh:create': Error: All configured authentication methods failed",
        );
      },
    });
    await expect(sshTerminalAdapter('server-1').create()).rejects.toThrow(
      'All configured authentication methods failed',
    );
  });

  it('keeps a message that has no boilerplate around it', async () => {
    bridge = installRunovaBridge({
      'ssh.create': async () => {
        throw new Error('Host unreachable');
      },
    });
    await expect(sshTerminalAdapter('server-1').create()).rejects.toThrow('Host unreachable');
  });

  it('turns something thrown that is not an Error into one', async () => {
    bridge = installRunovaBridge({
      'ssh.create': async () => {
        throw 'timed out';
      },
    });
    await expect(sshTerminalAdapter('server-1').create()).rejects.toThrow('timed out');
  });

  it('keeps the original message when stripping would leave nothing', async () => {
    bridge = installRunovaBridge({
      'ssh.create': async () => {
        throw new Error("Error invoking remote method 'ssh:create': Error:");
      },
    });
    await expect(sshTerminalAdapter('server-1').create()).rejects.toThrow(
      "Error invoking remote method 'ssh:create': Error:",
    );
  });

  it('passes writes, resizes and kills straight through', async () => {
    const adapter = sshTerminalAdapter('server-1');
    await adapter.write('s1', 'ls\r');
    await adapter.resize('s1', 100, 40);
    await adapter.kill('s1');
    expect(bridge.$fn('ssh.write')).toHaveBeenCalledWith('s1', 'ls\r');
    expect(bridge.$fn('ssh.resize')).toHaveBeenCalledWith('s1', 100, 40);
    expect(bridge.$fn('ssh.kill')).toHaveBeenCalledWith('s1');
  });

  it('forwards output as the terminal client shape', () => {
    const adapter = sshTerminalAdapter('server-1');
    const seen: { sessionId: string; data: string }[] = [];
    const off = adapter.onData((payload) => seen.push(payload));
    bridge.$emit('ssh.onData', { sessionId: 's1', data: 'hello' });
    expect(seen).toEqual([{ sessionId: 's1', data: 'hello' }]);
    off();
    expect(bridge.$listenerCount('ssh.onData')).toBe(0);
  });

  it('turns an exit carrying an error into a non-zero exit code', () => {
    // The terminal client only understands exit codes; an SSH error has to become one.
    const adapter = sshTerminalAdapter('server-1');
    const seen: { sessionId: string; exitCode: number }[] = [];
    adapter.onExit((payload) => seen.push(payload));
    bridge.$emit('ssh.onExit', { sessionId: 's1', error: 'connection reset' });
    bridge.$emit('ssh.onExit', { sessionId: 's2' });
    expect(seen).toEqual([
      { sessionId: 's1', exitCode: 1 },
      { sessionId: 's2', exitCode: 0 },
    ]);
  });

  it('stops forwarding exits once unsubscribed', () => {
    const adapter = sshTerminalAdapter('server-1');
    const listener = vi.fn();
    adapter.onExit(listener)();
    bridge.$emit('ssh.onExit', { sessionId: 's1' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('sshTerminalAdapter and a changed host key', () => {
  const status = {
    serverId: 'server-1',
    nickname: 'prod',
    host: 'prod.example',
    port: 22,
    stored: 'ab'.repeat(32),
    presented: 'cd'.repeat(32),
  };
  const changed = () =>
    new Error(
      "Error invoking remote method 'ssh:create': Error: [ssh:host-key-changed] The host key for prod.example:22 has changed since you last connected.",
    );

  it('asks about the new key and connects once it is trusted', async () => {
    const { answerHostKeyPrompt, useHostKeyPromptStore } = await import(
      '../../stores/hostKeyPromptStore'
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(changed())
      .mockResolvedValueOnce({ sessionId: 'ssh-2' });
    const trust = vi.fn(async () => undefined);
    installRunovaBridge({
      'ssh.create': create,
      'ssh.hostKeyStatus': status,
      'ssh.trustHostKey': trust,
    });

    const pending = sshTerminalAdapter('server-1').create();
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(true);

    await expect(pending).resolves.toEqual({ sessionId: 'ssh-2', isNew: true, snapshot: null });
    expect(trust).toHaveBeenCalledWith('server-1', status.presented);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('shows a plain reason, without the error code, when the key is not trusted', async () => {
    const { answerHostKeyPrompt, useHostKeyPromptStore } = await import(
      '../../stores/hostKeyPromptStore'
    );
    installRunovaBridge({
      'ssh.create': vi.fn().mockRejectedValue(changed()),
      'ssh.hostKeyStatus': status,
    });

    const pending = sshTerminalAdapter('server-1').create();
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    answerHostKeyPrompt(false);

    await expect(pending).rejects.toThrow(
      'Not connected to prod: its new host key was not trusted.',
    );
  });

  it('never shows the error code tag in the terminal', async () => {
    installRunovaBridge({
      'ssh.create': async () => {
        throw new Error(
          "Error invoking remote method 'ssh:create': Error: [ssh:sudo-password-required] Needs the sudo password.",
        );
      },
    });

    await expect(sshTerminalAdapter('server-1').create()).rejects.toThrow(
      /^Needs the sudo password\.$/,
    );
  });
});
