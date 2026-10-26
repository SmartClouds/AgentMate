import { buildAgentLaunchCommand, getCliDefinition, shellKindFor } from '@runova/core';
import { toast } from 'sonner';
import { useCliStore } from '@/stores/cliStore';
import { defaultNewSession, useTerminalStore } from '@/stores/terminalStore';

/**
 * The command that starts this CLI, with its launch defaults already attached
 * ("claude --permission-mode auto --model sonnet"). Callers that pass a prompt of their own
 * append it after this, so the flags stay ahead of the prompt. `runArgs` (a suggested model and
 * effort) replace the launch defaults they overlap, so no flag is ever sent twice. The Arguments
 * box from AI CLI Manager is not used here, it only applies to background tasks.
 */
export function cliLaunchCommand(cliId: string, runArgs: readonly string[] = []): string | null {
  const { cliLaunchDefaults } = useCliStore.getState();
  return buildAgentLaunchCommand({
    cliId,
    shellKind: shellKindFor(defaultNewSession().shell, window.runova.platform),
    launchDefaults: cliLaunchDefaults[cliId],
    runArgs,
  });
}

/** Opens a terminal session that starts this CLI so the user can work in it. */
export function openCliInTerminal(options: {
  cliId: string;
  cwd?: string;
  projectId?: string;
}): boolean {
  const cli = getCliDefinition(options.cliId);
  const command = cliLaunchCommand(options.cliId);
  if (!cli || !command) {
    toast.error('Unknown CLI.');
    return false;
  }
  useTerminalStore.getState().openSession({
    title: cli.name,
    cwd: options.cwd,
    projectId: options.projectId,
    initialInput: `${command}\r`,
  });
  return true;
}
