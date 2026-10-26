import {
  cleanInstallerLine,
  type DevInstallPhase,
  type DevRecipe,
  explainWingetExit,
  type InstallIntent,
  parseInstallerProgress,
  phaseFromInstallerLine,
  recipeArgv,
} from '@runova/core';
import type {
  CancelToken,
  SpawnStreamingOptions,
  SpawnStreamingResult,
} from '../../process/spawnStreaming';

/**
 * Runs one package-manager command (winget, Homebrew, npm, dotnet) for the Dev Setup installer
 * and turns what happens into progress updates and a sentence a person can read. The process
 * itself is injected, so the command, the patience and the reading of the output are all testable.
 */

export interface ProgressUpdate {
  phase?: DevInstallPhase;
  fraction?: number | null;
  detail?: string | null;
}

export interface RunHooks {
  token: CancelToken;
  /**
   * For a run that is not just a process (a download, say): hands over how to stop it. Called if
   * the install is cancelled. A process is stopped through the token and needs no help.
   */
  onCancel?: (abort: () => void) => void;
  onProgress: (update: ProgressUpdate) => void;
  /** A line worth putting in the log, already cleaned of spinners and progress bars. */
  onLine: (line: string) => void;
}

export interface RunResult {
  /** The command finished in a way that does not rule out the tool being there. */
  ok: boolean;
  code: number | null;
  cancelled: boolean;
  /** Why it did not work, or a note on how it went. */
  message?: string;
  restartAdvised?: boolean;
}

export type SpawnFn = (options: SpawnStreamingOptions) => Promise<SpawnStreamingResult>;

/** How long each tool may go without printing before it is treated as stuck. */
const IDLE_TIMEOUT_MS: Record<string, number> = {
  winget: 15 * 60_000,
  brew: 10 * 60_000,
  npm: 5 * 60_000,
  dotnet: 5 * 60_000,
};

function describeEnd(command: string, end: SpawnStreamingResult): Omit<RunResult, 'cancelled'> {
  const { code } = end;
  if (end.cancelled) return { ok: false, code };
  if (end.timedOut) {
    return { ok: false, code, message: 'The install stopped responding, so it was stopped.' };
  }
  if (end.notFound) {
    return { ok: false, code, message: `${command} was not found on this computer.` };
  }
  if (code === 0) return { ok: true, code };

  if (command === 'winget') {
    const exit = explainWingetExit(code);
    if (exit?.kind === 'already') return { ok: true, code, message: exit.message };
    if (exit?.kind === 'restart') {
      return { ok: true, code, message: exit.message, restartAdvised: true };
    }
    if (exit) return { ok: false, code, message: exit.message };
  }
  if (code === null) return { ok: false, code, message: 'The install could not start.' };
  return {
    ok: false,
    code,
    message: `${command} stopped with code ${code}. Open the log for details.`,
  };
}

export function createPackageManagerRunner(deps: {
  spawn: SpawnFn;
  cwd: string;
  /** The environment to run in. Left out, the process's own is used. */
  env?: NodeJS.ProcessEnv;
}): {
  run: (recipe: DevRecipe, intent: InstallIntent, hooks: RunHooks) => Promise<RunResult>;
} {
  return {
    async run(recipe, intent, hooks) {
      const argv = recipeArgv(recipe, intent);
      const command = argv?.[0];
      if (!argv || !command) {
        return {
          ok: false,
          code: null,
          cancelled: false,
          message: 'This step is not a package manager command.',
        };
      }

      let lastPhase: DevInstallPhase | null = null;
      const onLine = (line: string): void => {
        // The progress bar line is dropped from the log but is exactly what the percentage is read
        // from, so progress is taken from the raw line and the log from the cleaned one.
        const phase = phaseFromInstallerLine(line.trim());
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          hooks.onProgress({ phase, fraction: null });
        }
        const progress = parseInstallerProgress(line);
        if (progress) hooks.onProgress(progress);
        const cleaned = cleanInstallerLine(line);
        if (cleaned) hooks.onLine(cleaned);
      };

      try {
        const end = await deps.spawn({
          command,
          args: argv.slice(1),
          cwd: deps.cwd,
          env: deps.env,
          timeoutMs: IDLE_TIMEOUT_MS[command] ?? 5 * 60_000,
          idle: true,
          token: hooks.token,
          onLine,
        });
        return { ...describeEnd(command, end), cancelled: end.cancelled };
      } catch (error) {
        return {
          ok: false,
          code: null,
          cancelled: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
