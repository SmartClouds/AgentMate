import { configuredArgsWithout } from '../promptBuilder/runRecommendation.js';
import { parseCliArgs } from './args.js';
import type { CliDefinition } from './registry.js';

export interface HeadlessCliArgsInput {
  cli: CliDefinition;
  /** The CLI's Arguments box as saved in AI CLI Manager, e.g. "--model sonnet". */
  savedArgs?: string;
  /**
   * Model and effort flags picked for this one run, e.g. `['--model', 'opus']`. They replace the
   * same flags in the saved arguments rather than sitting next to them.
   */
  runArgs?: readonly string[];
  /** Adds the CLI's write flags, for runs the user asked to change files. */
  allowWrites?: boolean;
  /** The run's folder is one the app made for it, so the CLI is told to trust it. */
  trustCwd?: boolean;
}

/**
 * The arguments a background AI task (commit message, tag suggestion, version bump, run sizing,
 * skill review, SSH task) starts a CLI with, everything but the prompt text itself.
 *
 * The saved Arguments box always goes in. Launch defaults from Settings do not: they describe how
 * a terminal session starts, and the two are kept apart so neither one changes the other. Whether
 * a run may write is decided per task through `allowWrites`.
 *
 * Stdin-mode CLIs take the user's flags last, after any subcommand (`codex exec --model x`).
 * Arg-mode CLIs take them first, since the prompt is the value of the final flag (`-p PROMPT`)
 * and anything after that flag would be read as the prompt.
 */
export function buildHeadlessCliArgs(input: HeadlessCliArgsInput): string[] {
  const { cli } = input;
  if (!cli.promptCommand) return [];
  const runArgs = [...(input.runArgs ?? [])];
  const writeArgs = [
    ...(input.allowWrites ? (cli.promptWriteArgs ?? []) : []),
    ...(input.trustCwd ? (cli.promptTrustArgs ?? []) : []),
  ];
  const configured = parseCliArgs(configuredArgsWithout((input.savedArgs ?? '').trim(), runArgs));
  const userArgs = [...configured, ...runArgs];
  return cli.promptInputMode === 'stdin'
    ? [...cli.promptCommand.args, ...writeArgs, ...userArgs]
    : [...userArgs, ...writeArgs, ...cli.promptCommand.args];
}
