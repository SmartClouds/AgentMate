import { describe, expect, it, vi } from 'vitest';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { COMMAND_NOT_RERUN, ConsoleFeed } from './dockerFeeds';

/**
 * A console's feed on its own: a shell may open again on a new connection, a chosen command may
 * not, unless the core turned it away (too many streams open) before it ever started.
 */

function hub() {
  const containerConsole = vi.fn(() => ({ subscribe: vi.fn() }));
  return { hub: { containerConsole } as unknown as ICoreHub, containerConsole };
}

function feed(command?: string[]) {
  const ended = vi.fn();
  const terminal = new ConsoleFeed(
    { containerId: 'shop-api-1', columns: 80, rows: 24, ...(command ? { command } : {}) },
    { output: vi.fn(), ended },
  );
  return { terminal, ended };
}

const BUSY = new Error('HubException: Too many console streams open on this connection.');

describe('ConsoleFeed', () => {
  it('opens a shell again on every new connection', () => {
    const { hub: core, containerConsole } = hub();
    const { terminal } = feed();
    terminal.open(core);
    terminal.open(core);
    expect(containerConsole).toHaveBeenCalledTimes(2);
  });

  it('never starts a chosen command a second time', () => {
    const { hub: core, containerConsole } = hub();
    const { terminal, ended } = feed(['/bin/sh', '-c', 'php artisan migrate']);
    terminal.open(core);
    expect(() => terminal.open(core)).toThrow(COMMAND_NOT_RERUN);
    expect(containerConsole).toHaveBeenCalledTimes(1);
    expect(terminal.failed(new Error(COMMAND_NOT_RERUN))).toBeNull();
    expect(ended).toHaveBeenCalledWith({ error: COMMAND_NOT_RERUN });
  });

  it('tries a command again when the core refused it for being busy', () => {
    const { hub: core, containerConsole } = hub();
    const { terminal, ended } = feed(['/bin/sh', '-c', 'php artisan migrate']);
    terminal.open(core);
    expect(terminal.failed(BUSY)).toBeGreaterThan(0);
    terminal.open(core);
    expect(containerConsole).toHaveBeenCalledTimes(2);
    expect(ended).not.toHaveBeenCalled();
  });
});
