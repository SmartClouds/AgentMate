import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import type { AppSettings, CliDefinition, SupportedOS } from '@agentmat/core';
import {
  buildHeadlessCliArgs,
  buildHeadlessImageInput,
  CLI_REGISTRY,
  getCliArgsFor,
  getCliDefinition,
  supportsPromptImages,
} from '@agentmat/core';
import { resolveExecutable } from '../installMethod';
import { runCli } from '../packageManagers/execUtils';
import { refreshShellPath } from '../shellPath';
import { store } from '../store';
import { withToolPath } from '../toolPaths';

/** Agent CLIs answer through a model round-trip, so they need far longer than a git call. */
const HEADLESS_TIMEOUT_MS = 180000;

export interface HeadlessPromptResult {
  ok: boolean;
  text: string;
  /**
   * The CLI's progress log (stderr). OpenCode and friends print their banner and every
   * tool call there and keep stdout for the answer, so this is the only readable account
   * of a run that ends without a final message.
   */
  log?: string;
  /** Display name of the CLI that answered (or that we tried to use). */
  cliName: string | null;
  error?: string;
  /** True when cancelHeadlessPrompt() stopped this run. */
  cancelled?: boolean;
  /** True when the run was killed for exceeding its time budget. */
  timedOut?: boolean;
}

interface RunningPrompt {
  child: ChildProcess;
  cancelled: boolean;
}

/** Runs that were started with a requestId, so the renderer can stop them. */
const runningPrompts = new Map<string, RunningPrompt>();

/**
 * Ids cancelled before their process existed. Resolving which CLI to use probes each
 * candidate with `--version`, which takes seconds, long enough for the user to hit
 * cancel first, and without this the run would start anyway and answer into a UI that
 * has already moved on.
 */
const cancelledBeforeStart = new Set<string>();

/**
 * Windows spawns the CLI under cmd.exe, so killing the direct child would orphan the
 * agent itself; taskkill /T takes the whole tree down. Elsewhere the CLI is the direct
 * child and a signal is enough.
 */
export function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      // Best effort: the process may already have exited on its own.
    });
    return;
  }
  child.kill('SIGTERM');
}

/** Stops an in-flight headless run, or pre-empts one that hasn't spawned yet. */
export function cancelHeadlessPrompt(requestId: string): boolean {
  const entry = runningPrompts.get(requestId);
  if (entry) {
    entry.cancelled = true;
    killProcessTree(entry.child);
    return true;
  }
  cancelledBeforeStart.add(requestId);
  return true;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  failed: boolean;
  errorMessage: string;
  /** Set when the run ended because cancelHeadlessPrompt() killed it. */
  cancelled: boolean;
  /** Set when the run ended because it outlived its time budget. */
  timedOut: boolean;
}

/**
 * execFile, but the child handle is kept so the run can be killed mid-flight, which
 * promisify() hides. Non-zero exits resolve rather than reject; the caller decides.
 * `stdinPayload` is null for CLIs that take the prompt as an argument (stdin is closed
 * immediately so a CLI that happens to check for EOF never blocks); when set, it's
 * written to the child's stdin instead of being appended to argv.
 */
function execPrompt(
  command: string,
  args: string[],
  cwd: string,
  requestId: string | undefined,
  stdinPayload: string | null,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const options = {
      cwd,
      // No `timeout` here on purpose: execFile's own timer signals the direct child, which
      // on Windows is cmd.exe, leaving the agent behind to keep editing files after we
      // have already reported back. The timer below takes the whole tree down instead.
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env,
    };
    // npm-installed CLIs are .cmd shims on Windows, which Node refuses to spawn directly;
    // cmd.exe gets an argv array (not `shell: true`), so args never get re-parsed as a
    // single shell line. cmd.exe's own /c buffer still caps out at ~8191 characters
    // though, so a caller with a long prompt must send it via stdin instead of argv.
    const child =
      process.platform === 'win32'
        ? execFile('cmd.exe', ['/d', '/s', '/c', command, ...args], options, done)
        : execFile(command, args, options, done);

    if (requestId) runningPrompts.set(requestId, { child, cancelled: false });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    if (stdinPayload !== null) child.stdin?.end(stdinPayload);
    else child.stdin?.end();

    function done(error: Error | null, stdout: string, stderr: string): void {
      clearTimeout(timer);
      // Read the cancelled flag before dropping the entry: the kill lands here as a plain
      // non-zero exit, indistinguishable from a crash without it.
      const cancelled = requestId ? (runningPrompts.get(requestId)?.cancelled ?? false) : false;
      if (requestId) runningPrompts.delete(requestId);
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        failed: !!error,
        errorMessage: error?.message ?? '',
        cancelled,
        timedOut,
      });
    }
  });
}

function supportsHeadlessPrompt(cli: CliDefinition): boolean {
  return !!cli.promptCommand && cli.supportedOS.includes(process.platform as SupportedOS);
}

/**
 * Picks the CLI to answer a one-shot prompt, in order of preference: the project's
 * own CLI, then the app-wide default from Settings, then any registry CLI with a
 * headless mode that is on PATH. Returns null when nothing usable is installed.
 */
async function resolveHeadlessCli(
  settings: AppSettings,
  preferredCliId?: string | null,
  strict?: boolean,
): Promise<CliDefinition | null> {
  if (strict) {
    const cli = preferredCliId ? getCliDefinition(preferredCliId) : undefined;
    return cli && supportsHeadlessPrompt(cli) && (await isOnPath(cli)) ? cli : null;
  }
  const candidateIds = [preferredCliId, settings.defaultCliId].filter((id): id is string => !!id);

  const tried = new Set<string>();
  for (const id of candidateIds) {
    if (tried.has(id)) continue;
    tried.add(id);
    const cli = getCliDefinition(id);
    if (cli && supportsHeadlessPrompt(cli) && (await isOnPath(cli))) return cli;
  }

  for (const cli of CLI_REGISTRY) {
    if (tried.has(cli.id) || !supportsHeadlessPrompt(cli)) continue;
    if (await isOnPath(cli)) return cli;
  }
  return null;
}

async function isOnPath(cli: CliDefinition): Promise<boolean> {
  // A native installer's folder (~/.local/bin and friends) is often on no PATH the app can see,
  // but the run itself gets those folders through withToolPath, so finding the file is enough.
  if (await resolveExecutable([cli.versionCommand.command, ...cli.executableNames])) return true;
  if (await probeVersion(cli)) return true;
  // The app keeps the PATH it started with, so a CLI installed (or moved to a new folder by an
  // update) since then isn't found even though every new terminal finds it, and a Mac app opened
  // from Finder never had the shell's PATH at all. Read PATH back (the registry on Windows, the
  // login shell elsewhere) once and look again before calling it missing.
  await refreshShellPath();
  return probeVersion(cli);
}

async function probeVersion(cli: CliDefinition): Promise<boolean> {
  try {
    await runCli(cli.versionCommand.command, cli.versionCommand.args, process.cwd(), 8000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows routes the prompt through `cmd.exe /c`, which expands `%VAR%` even inside
 * a quoted argument. Dropping the delimiters keeps the text readable while making sure
 * repo content (a commit subject, say) can never paste an environment value (an API
 * key, for instance) into a prompt that goes off to a model.
 */
export function stripEnvExpansions(prompt: string): string {
  return process.platform === 'win32' ? prompt.replace(/%([A-Za-z0-9_]+)%/g, '$1') : prompt;
}

/**
 * cmd.exe caps the /c command line it builds at 8191 characters; go over that and it
 * fails with "The command line is too long." before the CLI ever runs. A diff-heavy
 * prompt (git changes, release notes) can easily exceed that on its own, so trim it down
 * with room for the CLI's own command and args. Only cmd.exe enforces this, so other
 * platforms pass the prompt through untouched.
 */
const WINDOWS_PROMPT_BUDGET_CHARS = 5000;

export function truncateForCommandLine(prompt: string, command: string, args: string[]): string {
  if (process.platform !== 'win32') return prompt;
  const overhead = command.length + args.join(' ').length + 20;
  const budget = Math.max(WINDOWS_PROMPT_BUDGET_CHARS - overhead, 500);
  if (prompt.length <= budget) return prompt;
  return `${prompt.slice(0, budget)}\n… (truncated: too long for the command line)`;
}

export interface HeadlessPromptOptions {
  /** Lets cancelHeadlessPrompt(requestId) stop this run. */
  requestId?: string;
  /** CLI the project asked for; falls back to the app default when unset or unusable. */
  preferredCliId?: string | null;
  /**
   * Adds the CLI's write flags so the agent can apply edits without a TTY to approve
   * them. Only set for prompts the user explicitly asked to run against their files.
   */
  allowWrites?: boolean;
  /**
   * Time budget for the run. Defaults to HEADLESS_TIMEOUT_MS, which suits a question the
   * CLI can answer in one round-trip; a prompt that sends the agent sweeping the repo
   * (searching for manifests, editing several of them) needs considerably more.
   */
  timeoutMs?: number;
  /**
   * Use `preferredCliId` or nothing. For runs where the user picked the CLI (and a model for
   * it), answering with a different CLI would be a surprise, and the model flags wouldn't fit.
   */
  strictCli?: boolean;
  /**
   * Model and effort flags picked for this one run, e.g. `['--model', 'opus']`. They replace
   * the same flags in the user's saved CLI arguments rather than being added next to them.
   */
  runArgs?: string[];
  /**
   * Screenshots for the CLI to look at, as paths relative to `cwd`. Only CLIs whose registry
   * entry says how to attach an image can take them; any other CLI is not started at all.
   */
  images?: string[];
  /**
   * `cwd` is a folder the app made for this run (a Studio work folder), so the CLI is told to
   * trust it instead of stopping to ask. Never set for a folder the user works in.
   */
  trustCwd?: boolean;
}

/** Names the CLIs that can look at a screenshot, for an error that tells the user what to pick. */
function imageCliNames(): string {
  const labels = CLI_REGISTRY.filter(supportsPromptImages).map((cli) => cli.label);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/**
 * Runs `prompt` through an installed agent CLI in non-interactive mode and returns
 * its stdout. The prompt is passed as a single argv entry (never string-concatenated
 * into a shell line), so its content can't spill into the command itself.
 */
export async function runHeadlessCliPrompt(
  prompt: string,
  cwd: string,
  options: HeadlessPromptOptions = {},
): Promise<HeadlessPromptResult> {
  const cancelledResult: HeadlessPromptResult = {
    ok: false,
    text: '',
    cliName: null,
    cancelled: true,
    error: 'Request cancelled.',
  };
  if (options.requestId && cancelledBeforeStart.delete(options.requestId)) return cancelledResult;

  const prepared = await prepareHeadlessRun(prompt, options);
  if (!prepared.ok) return prepared.result;
  const { cli, command, args, prompt: fullPrompt, env } = prepared.run;
  // Resolving the CLI can take seconds, and working out the tool folders can mean starting
  // Python; the user may have cancelled in the meantime.
  if (options.requestId && cancelledBeforeStart.delete(options.requestId)) {
    return { ...cancelledResult, cliName: cli.name };
  }

  const timeoutMs = options.timeoutMs ?? HEADLESS_TIMEOUT_MS;
  const outcome =
    cli.promptInputMode === 'stdin'
      ? await execPrompt(command, args, cwd, options.requestId, fullPrompt, timeoutMs, env)
      : await execPrompt(
          command,
          [...args, truncateForCommandLine(stripEnvExpansions(fullPrompt), command, args)],
          cwd,
          options.requestId,
          null,
          timeoutMs,
          env,
        );

  // A cancel that lost the race with completion would otherwise sit in the set forever.
  const cancelledLate = options.requestId ? cancelledBeforeStart.delete(options.requestId) : false;
  return headlessResult(
    cli.name,
    { ...outcome, cancelled: outcome.cancelled || cancelledLate },
    timeoutMs,
  );
}

export interface PreparedHeadlessRun {
  cli: CliDefinition;
  command: string;
  /** The CLI's arguments, without the prompt. */
  args: string[];
  /** The prompt, with whatever an attached image needs in front of it. */
  prompt: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Everything before a headless run starts: which CLI answers, its arguments from the user's
 * settings and the run's own picks, and the environment. Shared by the buffered run above and the
 * streaming one in headlessStream.ts, so both start a CLI exactly the same way.
 */
export async function prepareHeadlessRun(
  prompt: string,
  options: Omit<HeadlessPromptOptions, 'requestId' | 'timeoutMs'>,
): Promise<{ ok: true; run: PreparedHeadlessRun } | { ok: false; result: HeadlessPromptResult }> {
  const fail = (result: Omit<HeadlessPromptResult, 'ok' | 'text'>) =>
    ({ ok: false, result: { ok: false, text: '', ...result } }) as const;
  const settings = await store.getSettings();
  const cli = await resolveHeadlessCli(settings, options.preferredCliId, options.strictCli);

  if (!cli?.promptCommand && options.strictCli) {
    const name = options.preferredCliId ? getCliDefinition(options.preferredCliId)?.name : null;
    return fail({
      cliName: name ?? null,
      error:
        `${name ?? 'The chosen CLI'} wasn't found. Check that it runs in a new terminal, then ` +
        'refresh CLI Manager, or pick another AI for this task.',
    });
  }

  if (!cli?.promptCommand) {
    return fail({
      cliName: null,
      error:
        'No installed CLI supports non-interactive prompts. Install one (Claude Code, Codex, Gemini, …) ' +
        'from CLI Manager and pick it as your default CLI in Settings.',
    });
  }

  const images = options.images ?? [];
  if (images.length > 0 && !supportsPromptImages(cli)) {
    return fail({
      cliName: cli.name,
      error: `${cli.name} can't look at screenshots. Pick ${imageCliNames()}.`,
    });
  }

  // Stdin bypasses cmd.exe's command line entirely, so a CLI confirmed to read the
  // prompt that way needs neither the %VAR% stripping nor the length truncation below,
  // both of which only exist because cmd.exe reparses whatever lands in argv.
  // The Arguments box from AI CLI Manager goes into every background run, placed where each CLI
  // expects it; see buildHeadlessCliArgs(). Launch defaults stay out: those are for terminals.
  // Run args only make sense for the CLI they were built for.
  const baseArgs = buildHeadlessCliArgs({
    cli,
    savedArgs: getCliArgsFor(settings.cliArgs, cli.id),
    runArgs: cli.id === options.preferredCliId ? (options.runArgs ?? []) : [],
    allowWrites: options.allowWrites,
    trustCwd: options.trustCwd,
  });
  const imageInput = buildHeadlessImageInput(cli, images);
  // Cline's CLI self-updates on every invocation by spawning a detached background installer;
  // on Windows that can flash open a visible console mid-run. This is a no-op env var for every
  // other CLI we shell out to. The extra tool folders let a CLI that a native installer put in
  // ~/.local/bin (or pip in a Scripts folder) run even though the app's own PATH lacks them.
  const env = await withToolPath({
    ...process.env,
    CLINE_NO_AUTO_UPDATE: '1',
    ...imageInput.env,
    ...(options.trustCwd ? cli.promptTrustEnv : {}),
  });
  return {
    ok: true,
    run: {
      cli,
      command: cli.promptCommand.command,
      // An image run and a trusted folder can both ask for the same flag; a CLI may refuse it twice.
      args: [...baseArgs, ...imageInput.args.filter((arg) => !baseArgs.includes(arg))],
      prompt: imageInput.promptPrefix + prompt,
      env,
    },
  };
}

/** How a headless run ended, whichever way it was started. */
export interface HeadlessOutcome {
  stdout: string;
  stderr: string;
  failed: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

/** Turns a finished run into the result callers get: the answer, or the reason there is none. */
export function headlessResult(
  cliName: string,
  outcome: HeadlessOutcome,
  timeoutMs: number,
): HeadlessPromptResult {
  if (outcome.cancelled) {
    return { ok: false, text: '', cliName, cancelled: true, error: 'Request cancelled.' };
  }

  const text = stripAnsi(outcome.stdout).trim();
  const log = trimLog(stripAnsi(outcome.stderr).trim());
  if (text && !outcome.timedOut) return { ok: true, text, log, cliName };

  if (outcome.timedOut) {
    return {
      ok: false,
      text,
      log,
      cliName,
      timedOut: true,
      error: `${cliName} was still working after ${Math.round(timeoutMs / 60000)} minutes and was stopped.`,
    };
  }

  // stderr carries the progress log as well as any real failure, so neither showing all
  // of it nor dropping it works: the whole stream reads as noise, and none of it leaves
  // the user with nothing to act on. Pull out the lines that say what went wrong.
  const detail = extractCliError(log);
  return {
    ok: false,
    text: '',
    log,
    cliName,
    error: outcome.failed
      ? detail
        ? `${cliName} failed: ${detail}`
        : `${cliName} exited without answering.`
      : `${cliName} returned an empty answer.`,
  };
}

/**
 * Matches how these CLIs announce a failure: a line that leads with an error word or a
 * failure glyph. Progress lines ("• Find all version manifests") never look like this.
 */
const CLI_ERROR_LINE = /^(?:[✗×✘]\s*)?(?:error|fatal|panic|exception|failed)\b/i;

function extractCliError(log: string): string {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => CLI_ERROR_LINE.test(line))
    // The CLI's own "Error:" label would only repeat the sentence this goes into.
    .map((line) => line.replace(/^(?:[✗×✘]\s*)?error:?\s*/i, ''))
    .filter(Boolean);
  // The last one is the failure that ended the run; earlier ones are often retried.
  return lines.slice(-2).join(' ');
}

/**
 * Progress logs include the diff of every edit, which across a large repo runs to
 * megabytes; that all has to cross IPC and land in a dialog. Keep the tail, since what
 * the run did last is what explains how it ended.
 */
const MAX_LOG_CHARS = 20000;

function trimLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `… (earlier output trimmed)\n${log.slice(-MAX_LOG_CHARS)}`;
}

/** Color and cursor codes are noise once the answer is shown in a dialog. */
function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is what an ANSI escape sequence starts with, matching it is the point
      .replace(/\u001B\[[?]?\d*(?:;\d+)*[a-zA-Z]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences are delimited by BEL/ESC
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
      .replace(/\[(?:\d{1,3};)*\d{1,3}m/g, '')
      .replace(/\r/g, '')
  );
}
