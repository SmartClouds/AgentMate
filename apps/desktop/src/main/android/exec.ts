import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isLicensePrompt, parseSdkManagerProgress, type SdkManagerProgress } from '@runova/core';
import { type AndroidTool, AndroidToolMissingError, type ResolvedAndroidSdk } from './sdk';
import { toolSpawn } from './spawnTool';

/**
 * Running the SDK tools.
 *
 * Every call goes through `execFile` with the tool's absolute path and an argv array. No shell,
 * which matters more here than anywhere else in the app: an SDK under "C:\\Program Files" and an
 * AVD or device serial typed by the user would otherwise both need quoting, and `spawnStreaming`'s
 * Windows path routes through cmd.exe and refuses an argument containing a double quote.
 */

const execFileAsync = promisify(execFile);

export { AndroidToolMissingError };

/** A tool ran and failed. Carries what the tool actually said, which is the useful part. */
export class AndroidCommandError extends Error {
  constructor(
    readonly tool: AndroidTool,
    message: string,
  ) {
    super(message);
    this.name = 'AndroidCommandError';
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** Written to the child's stdin and then closed. `avdmanager create` blocks without it. */
  input?: string;
  /** Raise for a command whose output is large, such as `sdkmanager --list`. */
  maxBuffer?: number;
}

/** adb answers in milliseconds when it is healthy; anything slower is a device that went away. */
const ADB_TIMEOUT_MS = 15_000;
/** avdmanager and sdkmanager are Java wrappers, so they pay JVM startup on every call. */
const JAVA_TOOL_TIMEOUT_MS = 60_000;
const EMULATOR_TIMEOUT_MS = 30_000;

function stderrOf(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  return '';
}

/**
 * avdmanager and sdkmanager are shell wrappers around a JAR, so on a machine with no usable Java
 * they fail with a JAVA_HOME message that tells an Android user nothing. Android Studio ships a
 * runtime next to the SDK, which is the fix in almost every case.
 */
function explain(tool: AndroidTool, raw: string): string {
  if (/JAVA_HOME|no 'java' command|Unable to locate a Java Runtime/i.test(raw)) {
    return `${tool} needs a Java runtime and could not find one. Android Studio ships one at <sdk>/../jbr, or set JAVA_HOME to a JDK 17 or newer.`;
  }
  return raw;
}

function toolEnv(sdk: ResolvedAndroidSdk): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sdk.root) {
    // The tools read these themselves: avdmanager to find system images, the emulator to find
    // the AVD folder. Passing them explicitly means Runova does not depend on the user's
    // shell being set up the way the SDK expects.
    env.ANDROID_SDK_ROOT = sdk.root;
    env.ANDROID_HOME = sdk.root;
  }
  return env;
}

async function run(
  sdk: ResolvedAndroidSdk,
  tool: AndroidTool,
  args: string[],
  defaultTimeoutMs: number,
  options: RunOptions = {},
): Promise<string> {
  const binary = sdk.paths[tool];
  // Checked before spawning so a missing package reads as "install this", not as ENOENT.
  if (!binary) throw new AndroidToolMissingError(tool, tool === 'adb' ? 'platform-tools' : tool);

  const { file, argv, verbatim } = toolSpawn(binary, args);

  try {
    const child = execFileAsync(file, argv, {
      timeout: options.timeoutMs ?? defaultTimeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      env: toolEnv(sdk),
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    });
    if (options.input !== undefined) {
      child.child.stdin?.end(options.input);
    }
    const { stdout } = await child;
    return stdout;
  } catch (error) {
    const raw = stderrOf(error) || (error instanceof Error ? error.message : String(error));
    throw new AndroidCommandError(tool, explain(tool, raw));
  }
}

export function runAdb(
  sdk: ResolvedAndroidSdk,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  return run(sdk, 'adb', args, ADB_TIMEOUT_MS, options);
}

/**
 * adb with raw bytes on stdout, for `exec-out screencap -p`. Separate from `runAdb` because a
 * PNG read as a utf-8 string comes back corrupted, and the corruption is silent.
 */
export async function runAdbBinary(
  sdk: ResolvedAndroidSdk,
  args: string[],
  options: RunOptions = {},
): Promise<Buffer> {
  const binary = sdk.paths.adb;
  if (!binary) throw new AndroidToolMissingError('adb', 'platform-tools');
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
      env: toolEnv(sdk),
      encoding: 'buffer',
      // A screenshot of a tablet at full resolution is comfortably over the 1 MB default.
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new AndroidCommandError('adb', stderrOf(error) || 'The screenshot failed.');
  }
}

export function runEmulator(
  sdk: ResolvedAndroidSdk,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  return run(sdk, 'emulator', args, EMULATOR_TIMEOUT_MS, options);
}

export function runAvdManager(
  sdk: ResolvedAndroidSdk,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  return run(sdk, 'avdmanager', args, JAVA_TOOL_TIMEOUT_MS, options);
}

export function runSdkManager(
  sdk: ResolvedAndroidSdk,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  return run(sdk, 'sdkmanager', args, JAVA_TOOL_TIMEOUT_MS, options);
}

export interface SdkManagerStreamHandlers {
  /** The running process, for a caller that needs to stop it part way through. */
  onSpawn?(child: ChildProcess): void;
  onLine?(line: string): void;
  onProgress?(progress: SdkManagerProgress): void;
  /** Answer for a licence question, written to stdin. Returning nothing leaves it unanswered. */
  onPrompt?(line: string): string | undefined;
}

/**
 * sdkmanager for a job that takes minutes and talks back while it runs.
 *
 * `execFile` is no good here: the output only arrives at the end, and a licence question would
 * sit on stdin until the timeout killed it. This reads as it goes and can answer.
 *
 * sdkmanager repaints its progress bar with a carriage return rather than a newline, so the
 * stream is split on both or nothing would surface until the download finished.
 */
export function runSdkManagerStreaming(
  sdk: ResolvedAndroidSdk,
  args: string[],
  handlers: SdkManagerStreamHandlers,
): Promise<void> {
  const binary = sdk.paths.sdkmanager;
  if (!binary) throw new AndroidToolMissingError('sdkmanager', 'cmdline-tools;latest');
  const { file, argv, verbatim } = toolSpawn(binary, args);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, argv, {
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      env: toolEnv(sdk),
    });
    handlers.onSpawn?.(child);

    let buffer = '';
    const consume = (chunk: Buffer): void => {
      buffer += chunk.toString('utf-8');
      const parts = buffer.split(/\r\n|\r|\n/);
      // Whatever follows the last break is a partial line, unless it is a prompt: sdkmanager
      // leaves the cursor on "Accept? (y/N): " with no break at all.
      buffer = parts.pop() ?? '';
      for (const line of parts) handle(line);
      if (buffer && isLicensePrompt(buffer)) {
        handle(buffer);
        buffer = '';
      }
    };

    const handle = (line: string): void => {
      handlers.onLine?.(line);
      const progress = parseSdkManagerProgress(line);
      if (progress) handlers.onProgress?.(progress);
      if (isLicensePrompt(line)) {
        const answer = handlers.onPrompt?.(line);
        if (answer) child.stdin?.write(answer);
      }
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', (error) => reject(new AndroidCommandError('sdkmanager', error.message)));
    child.on('close', (code) => {
      if (buffer.trim()) handle(buffer);
      if (code === 0) resolve();
      else reject(new AndroidCommandError('sdkmanager', `sdkmanager exited with ${code}.`));
    });
  });
}
