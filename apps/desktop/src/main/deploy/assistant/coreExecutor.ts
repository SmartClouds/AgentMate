import type { ISubscription } from '@microsoft/signalr';
import type {
  ExecApproval,
  ExecLine,
  ExecOutput,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import {
  ApprovalRequiredError,
  type CommandExecutor,
  type CommandResult,
} from '../../agents/sshTaskRunner';
import { hubMessage } from '../connection/hubErrors';
import type { CoreLinks } from '../live/coreLinks';

/**
 * The Deploy AI's command executor (E09 T5): each command goes to the core's StreamExec on the
 * server's lasting connection. A command the user approved carries an approval signed by this
 * computer's device key; one that runs unattended carries none, and the core decides on its own
 * whether it may (the read-only allowlist, in a session that turned auto-run on). When it says
 * no, the loop asks the user and calls again with their approval.
 */

/** The core's words for a command it will only run with an approval (CoreHub.ExecNeedsApproval). */
export const NEEDS_APPROVAL = 'This command needs your approval before it runs.';
/** And for an approval it did not accept (CoreHub.ExecApprovalInvalid). */
export const APPROVAL_INVALID = 'The approval for this command is not valid.';
/** What the loop's approval bar says when the core asked for one. */
export const CORE_ASKS =
  'The server core runs only read-only checks without asking. Approve this one to run it.';
const TIMEOUT_SECONDS = 300;

export interface CoreExecutorDeps {
  links: Pick<CoreLinks, 'call'>;
  /** A fresh nonce from the core, signed with the device key over exactly this command. */
  approve: (serverId: string, hub: ICoreHub, command: string) => Promise<ExecApproval>;
  /** Output as it arrives, for the drawer. */
  onLines?: (command: string, lines: ExecLine[]) => void;
}

interface Collected {
  lines: string[];
  end: ExecOutput | null;
}

function stream(
  hub: ICoreHub,
  command: string,
  approval: ExecApproval | undefined,
  signal: AbortSignal,
  onLines: CoreExecutorDeps['onLines'],
): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const collected: Collected = { lines: [], end: null };
    if (signal.aborted) {
      resolve(collected);
      return;
    }
    let subscription: ISubscription<ExecOutput> | null = null;
    // Ending the stream is what stops the command on the server, with everything it started.
    const stop = () => {
      subscription?.dispose();
      resolve(collected);
    };
    signal.addEventListener('abort', stop, { once: true });
    subscription = hub
      .streamExec({
        command,
        fromAssistant: true,
        timeoutSeconds: TIMEOUT_SECONDS,
        ...(approval ? { approval } : {}),
      })
      .subscribe({
        next: (item) => {
          if (item.lines.length > 0) {
            collected.lines.push(...item.lines.map((line) => line.text));
            onLines?.(command, item.lines);
          }
          if (item.ended) collected.end = item;
        },
        complete: () => {
          signal.removeEventListener('abort', stop);
          resolve(collected);
        },
        error: (error) => {
          signal.removeEventListener('abort', stop);
          reject(error);
        },
      });
  });
}

function result(collected: Collected): CommandResult {
  const end = collected.end;
  const notes: string[] = [];
  if (end?.truncated) notes.push('[Output cut short: the core keeps at most 5000 lines]');
  return {
    output: [...collected.lines, ...notes].join('\n'),
    exitCode: end && !end.timedOut ? (end.exitCode ?? null) : null,
    timedOut: end?.timedOut ?? false,
  };
}

export function coreExecutor(deps: CoreExecutorDeps, serverId: string): CommandExecutor {
  return async ({ signal }, command, approved) => {
    try {
      const collected = await deps.links.call(serverId, async (hub) => {
        const approval = approved ? await deps.approve(serverId, hub, command) : undefined;
        return stream(hub, command, approval, signal, deps.onLines);
      });
      return result(collected);
    } catch (error) {
      const message = hubMessage(error);
      if (!approved && message.includes(NEEDS_APPROVAL)) throw new ApprovalRequiredError(CORE_ASKS);
      // Nothing ran: the AI reads why, as it would read a failed command.
      return { output: `[Not run: ${message}]`, exitCode: null, timedOut: false };
    }
  };
}
