import { quoteForShell } from '@agentmat/core';
import { encodeSshError } from '../../shared/sshErrors';
import { type ExecOptions, type ExecResult, requireAnswer, type SshConnection } from './connection';

/**
 * Running commands as root over a login that may or may not be root.
 *
 * - `sudo -k -n true` tells passwordless sudo apart from sudo that wants a password. `-k` makes it
 *   ignore cached credentials, which would otherwise make a password-protected account look
 *   passwordless for a few minutes after any other sudo.
 * - The password only ever travels on stdin (`sudo -S`), never in a command line, where it would
 *   show up in `ps` and shell history on the server.
 * - The password is checked with a command that carries nothing else. With `-S`, a wrong password
 *   makes sudo read the next stdin lines as retries, so a payload sent alongside it (the owner's
 *   new password, for instance) would be eaten.
 */

export type SudoMode = 'root' | 'passwordless' | 'password';

/** What running commands as root needs from a connection. */
export type CommandRunner = Pick<SshConnection, 'exec' | 'endpoint'>;

export interface RootShell {
  mode: SudoMode;
  /** Runs `command` as root. `options.stdin` reaches the command itself, untouched. */
  run: (command: string, options?: ExecOptions) => Promise<ExecResult>;
}

const PROBE_TIMEOUT_MS = 30_000;
const PASSWORD_ONLY = "sudo -S -k -p '' true";

/**
 * A server that stops answering is not one that wants a password, so a probe that times out
 * rejects with a `CommandTimeoutError` instead of falling through to 'password'.
 */
export async function detectSudoMode(
  connection: CommandRunner,
  options: { timeoutMs?: number } = {},
): Promise<SudoMode> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { host } = connection.endpoint;
  const who = requireAnswer(await connection.exec('id -u', { timeoutMs }), host, timeoutMs);
  if (who.exitCode === 0 && who.stdout.trim() === '0') return 'root';

  const probe = requireAnswer(
    await connection.exec('sudo -k -n true', { timeoutMs }),
    host,
    timeoutMs,
  );
  if (probe.exitCode === 0) return 'passwordless';
  if (probe.exitCode === 127 || /command not found/i.test(probe.stderr)) {
    throw new Error(
      `sudo is not installed on ${connection.endpoint.host}. Connect as root, or install sudo ` +
        `for ${connection.endpoint.username} first.`,
    );
  }
  return 'password';
}

function toBuffer(stdin: ExecOptions['stdin']): Buffer {
  if (stdin === undefined) return Buffer.alloc(0);
  return typeof stdin === 'string' ? Buffer.from(stdin, 'utf8') : stdin;
}

export async function openRootShell(
  connection: CommandRunner,
  password: string | null,
): Promise<RootShell> {
  const mode = await detectSudoMode(connection);

  if (mode === 'root') {
    return { mode, run: (command, options) => connection.exec(command, options) };
  }

  if (mode === 'passwordless') {
    return {
      mode,
      run: (command, options) =>
        connection.exec(`sudo -n -- sh -c ${quoteForShell(command, 'posix')}`, options),
    };
  }

  const user = connection.endpoint.username;
  if (!password) {
    throw new Error(
      encodeSshError(
        'sudo-password-required',
        `Running this as root on ${connection.endpoint.host} needs the sudo password for ${user}.`,
      ),
    );
  }
  if (/[\r\n]/.test(password)) {
    throw new Error('A sudo password cannot contain a line break.');
  }

  const passwordLine = Buffer.from(`${password}\n`, 'utf8');
  const check = requireAnswer(
    await connection.exec(PASSWORD_ONLY, { stdin: passwordLine, timeoutMs: PROBE_TIMEOUT_MS }),
    connection.endpoint.host,
    PROBE_TIMEOUT_MS,
  );
  if (check.exitCode !== 0) {
    throw new Error(
      encodeSshError(
        'sudo-password-rejected',
        `${connection.endpoint.host} did not accept the sudo password for ${user}.`,
      ),
    );
  }

  return {
    mode,
    run: (command, options = {}) =>
      connection.exec(`sudo -S -k -p '' -- sh -c ${quoteForShell(command, 'posix')}`, {
        ...options,
        stdin: Buffer.concat([passwordLine, toBuffer(options.stdin)]),
      }),
  };
}
