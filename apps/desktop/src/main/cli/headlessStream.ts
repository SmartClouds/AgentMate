import { spawn } from 'node:child_process';
import { stripAnsi } from '../process/spawnStreaming';
import {
  type HeadlessOutcome,
  type HeadlessPromptOptions,
  type HeadlessPromptResult,
  headlessResult,
  killProcessTree,
  prepareHeadlessRun,
  stripEnvExpansions,
  truncateForCommandLine,
} from './headlessPrompt';

/**
 * A headless CLI run the user watches: its output arrives line by line while it works, and it can
 * be stopped through an AbortSignal. It starts the CLI exactly as runHeadlessCliPrompt does (same
 * CLI resolution, same arguments) but keeps the answer (stdout) apart from the progress, which is
 * what Studio needs to read the JSON it asked for.
 */

/** An answer is a document, never a dump; anything past this is cut off. */
const MAX_ANSWER_CHARS = 10 * 1024 * 1024;

export interface StreamPromptOptions
  extends Omit<HeadlessPromptOptions, 'requestId' | 'timeoutMs' | 'images'> {
  signal: AbortSignal;
  /** Each line the CLI prints, on either stream, with color codes removed. */
  onLine: (line: string) => void;
  timeoutMs: number;
  /**
   * Sent instead of the prompt to a CLI that takes it as an argument, pointing it at a file in
   * `cwd` that holds the whole prompt. Without it the prompt is cut to fit the Windows command line.
   */
  pointerPrompt?: string;
}

export async function streamHeadlessCliPrompt(
  prompt: string,
  cwd: string,
  options: StreamPromptOptions,
): Promise<HeadlessPromptResult> {
  const cancelled = (cliName: string | null): HeadlessPromptResult => ({
    ok: false,
    text: '',
    cliName,
    cancelled: true,
    error: 'Request cancelled.',
  });
  if (options.signal.aborted) return cancelled(null);
  const prepared = await prepareHeadlessRun(prompt, options);
  if (!prepared.ok) return prepared.result;
  const { cli, command, args, prompt: fullPrompt, env } = prepared.run;
  if (options.signal.aborted) return cancelled(cli.name);

  const viaStdin = cli.promptInputMode === 'stdin';
  const argv = viaStdin
    ? args
    : [
        ...args,
        options.pointerPrompt ??
          truncateForCommandLine(stripEnvExpansions(fullPrompt), command, args),
      ];
  const outcome = await spawnPrompt(command, argv, cwd, env, viaStdin ? fullPrompt : null, options);
  return headlessResult(cli.name, outcome, options.timeoutMs);
}

function spawnPrompt(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinPayload: string | null,
  options: StreamPromptOptions,
): Promise<HeadlessOutcome> {
  return new Promise((resolve) => {
    // The same argv form execFile gets in runHeadlessCliPrompt: npm-installed CLIs are .cmd shims
    // on Windows, which only cmd.exe can start.
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], { cwd, env, windowsHide: true })
        : spawn(command, args, { cwd, env });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    /** Each stream keeps its own half-read line, so the two never glue together. */
    const lineReader = () => {
      let pending = '';
      return {
        push(text: string) {
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) emit(line);
        },
        end() {
          if (pending) emit(pending);
          pending = '';
        },
      };
    };
    const emit = (line: string) => {
      const clean = stripAnsi(line).trimEnd();
      if (clean) options.onLine(clean);
    };
    const out = lineReader();
    const err = lineReader();

    // A multi-byte character split across two chunks would otherwise decode as garbage.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      if (stdout.length < MAX_ANSWER_CHARS) stdout += text;
      out.push(text);
    });
    child.stderr?.on('data', (text: string) => {
      stderr = (stderr + text).slice(-MAX_ANSWER_CHARS);
      err.push(text);
    });

    const stop = () => {
      cancelled = true;
      killProcessTree(child);
    };
    options.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    const finish = (failed: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
      out.end();
      err.end();
      resolve({ stdout, stderr: stderr + extra, failed, cancelled, timedOut });
    };
    child.on('error', (error) => finish(true, `\nError: ${error.message}`));
    child.on('close', (code) => finish(code !== 0));

    // A CLI that exits before reading its prompt closes the pipe; that is its exit to report, not ours.
    child.stdin?.on('error', () => undefined);
    if (stdinPayload !== null) child.stdin?.end(stdinPayload, 'utf8');
    else child.stdin?.end();
  });
}
