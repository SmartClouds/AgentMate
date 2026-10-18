import { posix } from 'node:path';
import type { SshConversationsResult } from '../../shared/apiTypes';
import type { SshConnection } from '../ssh/connection';
import { getSshPool } from '../ssh/sharedPool';
import { limiter } from '../util/limiter';
import { collectHistory, type HistoryFs } from './sessionHistory';

// Conversations from every supported CLI stored on a saved server. One command finds the
// home folder, where the CLIs keep their history and which CLIs are installed; the
// transcripts are then read over SFTP by the same collectHistory that lists this machine's
// history.

/** What the probe found. Null or false wherever it could not tell. */
export interface RemoteProbe {
  home: string | null;
  claudeConfigDir: string | null;
  codexHome: string | null;
  clis: {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    cursor: boolean;
    continue: boolean;
    grok: boolean;
    cline: boolean;
    opencode: boolean;
    qwen: boolean;
    freebuff: boolean;
  };
}

/** The part of an SSH connection the history reader uses. */
export type HistoryConnection = Pick<
  SshConnection,
  'exec' | 'sftpList' | 'sftpReadRange' | 'sftpRealpath'
>;

/** Hands out a connection to a saved server and takes it back. `SshConnectionPool` is one. */
export interface HistoryPool {
  acquire(serverId: string): Promise<{ connection: HistoryConnection; release: () => void }>;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** SFTP requests in flight at once. More only queue up inside the one SFTP channel. */
const MAX_SFTP_IN_FLIGHT = 8;
const LIST_LIMIT = 200;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;

/**
 * Where the CLIs are often installed without being on the PATH a login `sh` sees: the npm,
 * bun and volta global folders, nvm's per-version folders, Claude's own installer, Homebrew.
 * Their setup usually lands in ~/.bashrc, which an interactive terminal reads and `sh -l` does
 * not, so looking here keeps "not installed" from showing for a CLI the terminal would find.
 */
const CLI_FOLDERS = [
  '"$HOME/.local/bin"',
  '"$HOME/.claude/local"',
  '"$HOME/.npm-global/bin"',
  '"$HOME/.bun/bin"',
  '"$HOME/.volta/bin"',
  '"$HOME/bin"',
  '"$HOME"/.nvm/versions/node/*/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/home/linuxbrew/.linuxbrew/bin',
].join(' ');

/**
 * Prints each answer on a marked line, so whatever the login scripts print around it cannot be
 * mistaken for one. `sh -l` reads /etc/profile and ~/.profile, which is where most servers set
 * PATH and variables like CLAUDE_CONFIG_DIR. An interactive shell (`bash -i`) would read
 * ~/.bashrc as well, but it can prompt, start tmux or wait for a terminal, so the known install
 * folders are checked by hand instead. The script is one line with no single quotes and no `!`,
 * because the user's own login shell (bash, zsh, fish, even csh) passes it to sh first.
 */
export const PROBE_COMMAND = `sh -lc '${[
  'printf "__AM_HOME=%s\\n" "$HOME"',
  'printf "__AM_CLAUDE_CONFIG_DIR=%s\\n" "${CLAUDE_CONFIG_DIR:-}"',
  'printf "__AM_CODEX_HOME=%s\\n" "${CODEX_HOME:-}"',
  `am_has() { command -v "$1" >/dev/null 2>&1 && return 0; for d in ${CLI_FOLDERS}; do [ -x "$d/$1" ] && return 0; done; return 1; }`,
  'am_has claude && echo __AM_CLAUDE=1',
  'am_has codex && echo __AM_CODEX=1',
  'am_has gemini && echo __AM_GEMINI=1',
  'am_has cursor-agent && echo __AM_CURSOR=1',
  'am_has cn && echo __AM_CONTINUE=1',
  'am_has grok && echo __AM_GROK=1',
  'am_has cline && echo __AM_CLINE=1',
  'am_has opencode && echo __AM_OPENCODE=1',
  'am_has qwen && echo __AM_QWEN=1',
  'am_has openclaude && echo __AM_OPENCLAUDE=1',
  'am_has freebuff && echo __AM_FREEBUFF=1',
  'echo __AM_END',
].join('; ')}'`;

const MARKER = /__AM_([A-Z_]+)(?:=(.*))?$/;

/** Reads the probe's marked lines out of everything the command printed. */
export function parseRemoteProbe(stdout: string): RemoteProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const start = line.indexOf('__AM_');
    if (start < 0) continue;
    const match = line.slice(start).replace(/\r$/, '').match(MARKER);
    if (match && !values.has(match[1])) values.set(match[1], match[2] ?? '');
  }
  const value = (key: string): string | null => values.get(key) || null;
  return {
    home: value('HOME'),
    claudeConfigDir: value('CLAUDE_CONFIG_DIR'),
    codexHome: value('CODEX_HOME'),
    clis: {
      claude: values.get('CLAUDE') === '1',
      codex: values.get('CODEX') === '1',
      gemini: values.get('GEMINI') === '1',
      cursor: values.get('CURSOR') === '1',
      continue: values.get('CONTINUE') === '1',
      grok: values.get('GROK') === '1',
      cline: values.get('CLINE') === '1',
      opencode: values.get('OPENCODE') === '1',
      qwen: values.get('QWEN') === '1',
      freebuff: values.get('FREEBUFF') === '1',
    },
  };
}

const NOTHING_FOUND: RemoteProbe = {
  home: null,
  claudeConfigDir: null,
  codexHome: null,
  clis: {
    claude: false,
    codex: false,
    gemini: false,
    cursor: false,
    continue: false,
    grok: false,
    cline: false,
    opencode: false,
    qwen: false,
    freebuff: false,
  },
};

/**
 * Runs the probe. A server that refuses commands (an SFTP-only account) or a login script that
 * hangs leaves everything unknown; the history can still be read over SFTP from the home folder.
 */
export async function probeRemote(connection: HistoryConnection): Promise<RemoteProbe> {
  try {
    const result = await connection.exec(PROBE_COMMAND, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    });
    return parseRemoteProbe(result.stdout);
  } catch {
    return NOTHING_FOUND;
  }
}

/** The history reader's view of a saved server, over SFTP as the login user. */
export function sftpHistoryFs(
  connection: HistoryConnection,
  serverId: string,
  probe: RemoteProbe,
  options: { maxInFlight?: number } = {},
): HistoryFs {
  const queue = limiter(options.maxInFlight ?? MAX_SFTP_IN_FLIGHT);
  let home: Promise<string> | null = null;
  const env: Record<string, string | null> = {
    CLAUDE_CONFIG_DIR: probe.claudeConfigDir,
    CODEX_HOME: probe.codexHome,
  };
  return {
    scope: `ssh:${serverId}`,
    caseInsensitive: false,
    join: (...parts) => posix.join(...parts),
    // SFTP starts in the login user's home folder, so "." is it when the probe could not say.
    home: () => {
      home ??= probe.home ? Promise.resolve(probe.home) : queue(() => connection.sftpRealpath('.'));
      return home;
    },
    env: async (name) => env[name] ?? undefined,
    list: (dir) => queue(() => connection.sftpList(dir)),
    readRange: async (path, start, length) =>
      (await queue(() => connection.sftpReadRange(path, start, length))).toString('utf-8'),
  };
}

/**
 * Every supported CLI conversation on a saved server, newest first, with the server's
 * home folder and which CLIs it has. Connection failures come through as they are, so a changed
 * host key or a locked vault keeps the code the renderer looks for.
 */
export async function listRemoteAgentHistory(
  serverId: string,
  deps: { pool: HistoryPool } = { pool: getSshPool() },
): Promise<SshConversationsResult> {
  const lease = await deps.pool.acquire(serverId);
  try {
    const probe = await probeRemote(lease.connection);
    const fs = sftpHistoryFs(lease.connection, serverId, probe);
    const sessions = await collectHistory(fs, {
      limit: LIST_LIMIT,
      headBytes: HEAD_BYTES,
      tailBytes: TAIL_BYTES,
    });
    return { sessions, home: await fs.home(), clis: probe.clis };
  } finally {
    lease.release();
  }
}
