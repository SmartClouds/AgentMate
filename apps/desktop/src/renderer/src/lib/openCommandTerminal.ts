import type { CommandPrerequisite } from '@shared/apiTypes';
import { toast } from 'sonner';
import { useTerminalStore } from '@/stores/terminalStore';

export type CommandVerb = 'install' | 'update' | 'uninstall';

/**
 * Types an install, update or uninstall command into a new terminal session for the user to
 * confirm with Enter. The session is titled "Install Gemini CLI" (the verb, then the name).
 *
 * Some commands lean on a tool that may not be on this machine (npm, pipx, Homebrew, WinGet).
 * Main checks for it first, and when it is missing the user gets a toast with a link to get it
 * instead of a terminal that would only print "command not found". A check that fails on its own
 * never blocks the user, the terminal opens as it would have without it.
 *
 * Returns whether a terminal was opened.
 */
export async function openCommandTerminal(options: {
  command: string;
  /** The CLI or tool the command is for, as the user sees it. */
  name: string;
  verb: CommandVerb;
}): Promise<boolean> {
  const { command, name, verb } = options;

  let prerequisite: CommandPrerequisite | null = null;
  try {
    prerequisite = await window.runova.cli.checkCommandPrerequisite(command);
  } catch {
    // Not knowing is not a reason to stop. The terminal shows the real error if there is one.
  }

  if (prerequisite) {
    const { name: needed, url } = prerequisite;
    toast.error(`${name} needs ${needed}, which isn't installed.`, {
      description: `Install ${needed}, then try again.`,
      action: {
        label: `Get ${needed}`,
        onClick: () => void window.runova.shell.openExternal(url),
      },
    });
    return false;
  }

  const title = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${name}`;
  useTerminalStore.getState().openSession({ title, initialInput: command });
  toast.info(`Press Enter in the terminal to ${verb} ${name}.`);
  return true;
}
