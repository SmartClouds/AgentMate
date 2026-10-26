import type { CreateTerminalOptions, TerminalAttachResult } from '@shared/apiTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployConsoleEvent } from '@shared/deployDockerTypes';

interface TerminalDataPayload {
  sessionId: string;
  data: string;
}
interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

/** Said in the terminal when the connection to the core changed and a new shell took over. */
export const NEW_SHELL_NOTICE =
  '\r\n\x1b[2m(The connection to the server changed, so this is a new shell.)\x1b[0m\r\n';

const DEFAULT_SIZE = { cols: 80, rows: 24 };

/**
 * A console in a container (E06 T6), behind the same shape as `window.runova.terminal` so
 * `TerminalPane` can render it like any other session. The pane knows the session by its own id
 * while the main process names the console by a subscription id that comes back from the open
 * call, so this keeps the mapping, and holds on to output that arrives before that answer.
 * Without a command it opens the container's shell; `user` runs it as someone else.
 */
export function containerConsoleAdapter(
  serverId: string,
  containerId: string,
  run: { command?: string[]; user?: string } = {},
) {
  const deploy = window.runova.deployDocker;
  let paneId: string | null = null;
  let consoleId: string | null = null;
  const early: DeployConsoleEvent[] = [];
  const dataListeners = new Set<(payload: TerminalDataPayload) => void>();
  const exitListeners = new Set<(payload: TerminalExitPayload) => void>();
  let off: (() => void) | null = null;

  const print = (data: string) => {
    if (!paneId) return;
    for (const listener of [...dataListeners]) listener({ sessionId: paneId, data });
  };

  const route = (event: DeployConsoleEvent) => {
    if (event.restarted) print(NEW_SHELL_NOTICE);
    if (event.data) print(event.data);
    if (!event.ended || !paneId) return;
    if (event.ended.error) print(`\r\n\x1b[31m${event.ended.error}\x1b[0m\r\n`);
    const exitCode = event.ended.exitCode ?? (event.ended.error ? 1 : 0);
    for (const listener of [...exitListeners]) listener({ sessionId: paneId, exitCode });
    off?.();
    off = null;
  };

  const listen = () => {
    off ??= deploy.onConsole((event) => {
      if (consoleId === null) early.push(event);
      else if (event.subscriptionId === consoleId) route(event);
    });
  };

  return {
    create: async (options: CreateTerminalOptions = {}): Promise<TerminalAttachResult | null> => {
      paneId = options.sessionId ?? `console-${containerId}`;
      listen();
      try {
        consoleId = await deploy.openConsole({
          serverId,
          containerId,
          columns: options.cols ?? DEFAULT_SIZE.cols,
          rows: options.rows ?? DEFAULT_SIZE.rows,
          ...(run.command ? { command: run.command } : {}),
          ...(run.user ? { user: run.user } : {}),
        });
      } catch (error) {
        off?.();
        off = null;
        throw new Error(coreErrorMessage(error));
      }
      // Output that came before the id is released once the pane has its session id; a turn
      // later, so the pane has taken the answer first.
      queueMicrotask(() => {
        for (const event of early.splice(0)) {
          if (event.subscriptionId === consoleId) route(event);
        }
      });
      return { sessionId: paneId, isNew: true, snapshot: null };
    },
    write: async (_sessionId: string, data: string): Promise<void> => {
      if (consoleId) await deploy.consoleInput(consoleId, data);
    },
    resize: async (_sessionId: string, cols: number, rows: number): Promise<void> => {
      if (consoleId) await deploy.consoleResize(consoleId, cols, rows);
    },
    kill: async (_sessionId: string): Promise<void> => {
      off?.();
      off = null;
      if (consoleId) await deploy.closeConsole(consoleId);
    },
    onData: (callback: (payload: TerminalDataPayload) => void): (() => void) => {
      dataListeners.add(callback);
      return () => {
        dataListeners.delete(callback);
      };
    },
    onExit: (callback: (payload: TerminalExitPayload) => void): (() => void) => {
      exitListeners.add(callback);
      return () => {
        exitListeners.delete(callback);
      };
    },
  };
}
