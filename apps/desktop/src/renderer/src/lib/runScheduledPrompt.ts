import {
  cliIdForTargetAI,
  type EffortLevel,
  getCliDefinition,
  launchDefaultArgs,
} from '@runova/core';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { cliLaunchCommand } from './openCli';

export interface PromptRun {
  projectId: string;
  /** Project folder the CLI starts in. */
  cwd?: string;
  content: string;
  /** Names the scratch file the prompt is written to, so reruns overwrite the same one. */
  fileKey: string;
  targetAI: string;
  cliId?: string;
  model?: string;
  effort?: EffortLevel;
}

/** The task's own CLI, then the app default, then whichever CLI its target AI belongs to. */
export function resolveRunCliId(cliId: string | undefined, targetAI: string): string | null {
  const candidates = [cliId, useCliStore.getState().defaultCliId, cliIdForTargetAI(targetAI)];
  return candidates.find((id): id is string => Boolean(id && getCliDefinition(id))) ?? null;
}

/**
 * Opens a terminal tab in the project folder that starts the CLI with this prompt and presses
 * Enter. The prompt goes through a scratch file because it's usually too long and too full of
 * quotes to pass on the command line directly. Returns the CLI name, or null when there's no
 * CLI to run it in.
 */
export async function runPromptInTerminal(run: PromptRun): Promise<string | null> {
  const cliId = resolveRunCliId(run.cliId, run.targetAI);
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  if (!cliId || !cli) return null;

  const filePath = await window.runova.fs.writeScratchFile(`${run.fileKey}.md`, run.content);
  // Model and effort only make sense for the CLI they were picked for.
  const runArgs =
    run.cliId === cliId ? launchDefaultArgs(cliId, { model: run.model, effort: run.effort }) : [];
  const launch = cliLaunchCommand(cliId, runArgs) ?? cli.executableNames[0];
  const command =
    window.runova.platform === 'win32'
      ? `& ${launch} (Get-Content -Raw -LiteralPath "${filePath}")`
      : `${launch} "$(cat '${filePath}')"`;
  useTerminalStore.getState().openSession({
    title: cli.name,
    cwd: run.cwd,
    projectId: run.projectId,
    initialInput: `${command}\r`,
  });
  return cli.name;
}
