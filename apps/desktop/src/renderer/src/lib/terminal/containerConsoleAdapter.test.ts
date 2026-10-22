import { describe, expect, it, vi } from 'vitest';
import { installAgentmatBridge } from '../../../../test/renderer/agentmatBridge';
import { containerConsoleAdapter, NEW_SHELL_NOTICE } from './containerConsoleAdapter';

/**
 * The console adapter lets TerminalPane drive a container's shell: output reaches the pane under
 * the pane's own id (including what came before the open call answered), keystrokes and sizes
 * go to the console, a new shell after a reconnect is announced, and the end is reported.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(openConsole: (...args: unknown[]) => unknown = async () => 'console-1') {
  const bridge = installAgentmatBridge({ 'deployDocker.openConsole': openConsole });
  const adapter = containerConsoleAdapter('srv-1', 'toolbox');
  const data: Array<{ sessionId: string; data: string }> = [];
  const exits: Array<{ sessionId: string; exitCode: number }> = [];
  adapter.onData((payload) => data.push(payload));
  adapter.onExit((payload) => exits.push(payload));
  const emit = (event: Record<string, unknown>) =>
    bridge.$emit('deployDocker.onConsole', {
      subscriptionId: 'console-1',
      serverId: 'srv-1',
      ...event,
    });
  return { bridge, adapter, data, exits, emit };
}

describe('containerConsoleAdapter', () => {
  it('opens at the pane’s size, and hands over what came before the answer', async () => {
    let answer: (id: string) => void = () => undefined;
    const { bridge, adapter, data, emit } = setup(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const created = adapter.create({ sessionId: 'pane-1', cols: 100, rows: 30 });
    emit({ data: 'root@toolbox:/# ' });
    bridge.$emit('deployDocker.onConsole', {
      subscriptionId: 'other',
      serverId: 'srv-1',
      data: 'not ours',
    });
    answer('console-1');
    expect(await created).toEqual({ sessionId: 'pane-1', isNew: true, snapshot: null });
    await flush();
    expect(bridge.$fn('deployDocker.openConsole')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      containerId: 'toolbox',
      columns: 100,
      rows: 30,
    });
    expect(data).toEqual([{ sessionId: 'pane-1', data: 'root@toolbox:/# ' }]);
  });

  it('sends keystrokes and sizes, announces a new shell, and reports the exit', async () => {
    const { bridge, adapter, data, exits, emit } = setup();
    await adapter.create({ sessionId: 'pane-1' });
    expect(bridge.$fn('deployDocker.openConsole')).toHaveBeenCalledWith(
      expect.objectContaining({ columns: 80, rows: 24 }),
    );
    await adapter.write('pane-1', 'ls\r');
    await adapter.resize('pane-1', 120, 40);
    expect(bridge.$fn('deployDocker.consoleInput')).toHaveBeenCalledWith('console-1', 'ls\r');
    expect(bridge.$fn('deployDocker.consoleResize')).toHaveBeenCalledWith('console-1', 120, 40);

    emit({ data: '# ', restarted: true });
    emit({ ended: { exitCode: 3 } });
    expect(data.map((one) => one.data)).toEqual([NEW_SHELL_NOTICE, '# ']);
    expect(exits).toEqual([{ sessionId: 'pane-1', exitCode: 3 }]);
    // Nothing after the end reaches the pane.
    emit({ data: 'late' });
    expect(data).toHaveLength(2);
    await adapter.kill('pane-1');
    expect(bridge.$fn('deployDocker.closeConsole')).toHaveBeenCalledWith('console-1');
  });

  it('runs a chosen command as a chosen user', async () => {
    const bridge = installAgentmatBridge({ 'deployDocker.openConsole': async () => 'console-1' });
    const adapter = containerConsoleAdapter('srv-1', 'toolbox', {
      command: ['/bin/sh', '-c', 'php artisan migrate'],
      user: 'root',
    });
    await adapter.create({ sessionId: 'pane-1' });
    expect(bridge.$fn('deployDocker.openConsole')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      containerId: 'toolbox',
      columns: 80,
      rows: 24,
      command: ['/bin/sh', '-c', 'php artisan migrate'],
      user: 'root',
    });
  });

  it('prints the core’s refusal in red and ends with a failure', async () => {
    const { adapter, data, exits, emit } = setup();
    await adapter.create({ sessionId: 'pane-1' });
    emit({ ended: { error: 'Container toolbox is not running.' } });
    expect(data[0].data).toContain('Container toolbox is not running.');
    expect(exits).toEqual([{ sessionId: 'pane-1', exitCode: 1 }]);
  });

  it('turns a failed open into a plain message, and does nothing without a console', async () => {
    const { adapter, bridge } = setup(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'deployDocker:openConsole': Error: [core:forbidden] Your role cannot do that.",
        ),
      ),
    );
    await expect(adapter.create()).rejects.toThrow(/^Your role cannot do that\.$/);
    await adapter.write('x', 'ls');
    await adapter.resize('x', 1, 1);
    await adapter.kill('x');
    expect(bridge.$fn('deployDocker.openConsole')).toHaveBeenCalled();
    expect(() => bridge.$fn('deployDocker.consoleInput')).toThrow();
  });

  it('stops listening when a pane lets go', () => {
    const { adapter } = setup();
    const offData = adapter.onData(vi.fn());
    const offExit = adapter.onExit(vi.fn());
    offData();
    offExit();
  });
});
