import {
  CommandTimeoutError,
  requireAnswer,
  type SshConnection,
  TunnelRefusedError,
} from '../../ssh/connection';
import { detectSudoMode, type SudoMode } from '../../ssh/sudo';
import { CORE_BINARY_PATH } from '../connection/transport';
import {
  type OsSupport,
  osSupport,
  parseOsRelease,
  type ReleaseRid,
  releaseRidFor,
} from './osSupport';
import type { RemoteRelease } from './releaseSource';
import {
  type DownloadTool,
  parseProbe,
  probeCommand,
  RELEASE_PROBE_TIMEOUT_MS,
} from './serverDownload';

/**
 * A read-only look at a server before installing the core: everything here runs as the login
 * user, and the report says in plain words what would stop an install.
 */

export interface PreflightReport {
  os: OsSupport;
  architecture: { machine: string; rid: ReleaseRid | null };
  systemd: boolean;
  /** The smaller of the free space under /opt and /var, in MB; null when df could not say. */
  freeDiskMb: number | null;
  /** Null when sudo is missing on a non-root login (listed in `problems`). */
  sudo: SudoMode | null;
  loginUser: string;
  /**
   * 'prohibited' when sshd refused the probe tunnel by policy. OpenSSH refuses a forbidden
   * stream-local tunnel with the same answer as one to a missing socket, so 'allowed' only means
   * nothing said no; the installer settles it by trying the real socket.
   */
  streamLocal: 'allowed' | 'prohibited';
  installed: { version: string; release: string } | null;
  selinux: 'enforcing' | 'permissive' | 'disabled' | 'absent';
  /**
   * The tool the server can download the core with, when it reached the release itself. Null when
   * it has neither curl nor wget, cannot reach GitHub, or no release address was asked about; the
   * app then sends the core over SSH.
   */
  serverDownload: DownloadTool | null;
  /** What stands in the way of an install; empty when it can go ahead. */
  problems: string[];
}

export interface PreflightOptions {
  probeTimeoutMs?: number;
  /**
   * Where the server could download the release for its processor. Given, the check also tries
   * that address from the server; left out, it does not, which keeps the check quick for callers
   * that never install.
   */
  remote?: (rid: ReleaseRid) => Pick<RemoteRelease, 'url'> | null;
}

const MIN_FREE_MB = 300;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * sshd answers a tunnel it will not open in one round trip, so a longer silence is not coming.
 * Unlike the command probes, silence here does not fail the check: it reads as "allowed", and
 * the installer settles it by trying the real socket.
 */
const TUNNEL_PROBE_TIMEOUT_MS = 10_000;
/** A path no core listens on: the answer only tells whether sshd allows the tunnel at all. */
const STREAM_LOCAL_PROBE = '/run/agentmate-core/.preflight-probe';

/** What the preflight needs from a connection. */
export type PreflightConnection = Pick<SshConnection, 'exec' | 'endpoint' | 'openStream'>;

/**
 * A server that logs in but then does not answer a probe fails the whole check with a
 * `CommandTimeoutError`, at the first probe that goes quiet. Reading its empty output as the
 * answer would run through every remaining probe's timeout and then report an unknown system.
 */
export async function runPreflight(
  connection: PreflightConnection,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const { host } = connection.endpoint;
  const run = async (command: string) =>
    requireAnswer(await connection.exec(command, { timeoutMs }), host, timeoutMs);
  const problems: string[] = [];

  const os = osSupport(parseOsRelease((await run('cat /etc/os-release')).stdout));
  if (!os.supported && os.reason) problems.push(os.reason);

  const machine = (await run('uname -m')).stdout.trim();
  const rid = releaseRidFor(machine);
  if (!rid) {
    problems.push(
      `This server's processor (${machine || 'unknown'}) has no server core build; it needs x64 or arm64.`,
    );
  }

  const systemd =
    (await run('test -d /run/systemd/system && echo yes || echo no')).stdout.trim() === 'yes';
  if (!systemd)
    problems.push(
      'The server core runs as a systemd service, and this server does not run systemd.',
    );

  const free = (await run("df -Pk /opt /var 2>/dev/null | awk 'NR>1 {print $4}'")).stdout
    .split(/\s+/)
    .map(Number)
    .filter((kb) => Number.isFinite(kb) && kb > 0);
  const freeDiskMb = free.length > 0 ? Math.floor(Math.min(...free) / 1024) : null;
  if (freeDiskMb !== null && freeDiskMb < MIN_FREE_MB) {
    problems.push(
      `The server needs at least ${MIN_FREE_MB} MB free under /opt and /var; it has ${freeDiskMb} MB.`,
    );
  }

  let sudo: SudoMode | null = null;
  try {
    sudo = await detectSudoMode(connection, { timeoutMs });
  } catch (error) {
    if (error instanceof CommandTimeoutError) throw error;
    problems.push((error as Error).message);
  }

  let installed: PreflightReport['installed'] = null;
  const current = await run('readlink -f /opt/agentmate-core/current 2>/dev/null');
  if (current.exitCode === 0 && current.stdout.trim()) {
    // Not `run`: a core that hangs here is as broken as one that prints nothing, and the install
    // is what replaces it, so this probe may not fail the check.
    const version = await connection.exec(`${CORE_BINARY_PATH} admin version 2>/dev/null`, {
      timeoutMs,
    });
    try {
      const parsed = JSON.parse(version.stdout) as { version?: unknown };
      if (typeof parsed.version === 'string') {
        installed = { version: parsed.version, release: current.stdout.trim() };
      }
    } catch {
      // A broken install: treat it as not installed, and let the install replace it.
    }
  }

  const enforce = (
    await run('command -v getenforce >/dev/null 2>&1 && getenforce || echo absent')
  ).stdout
    .trim()
    .toLowerCase();
  const selinux: PreflightReport['selinux'] =
    enforce === 'enforcing' || enforce === 'permissive' || enforce === 'disabled'
      ? enforce
      : 'absent';

  let streamLocal: PreflightReport['streamLocal'] = 'allowed';
  try {
    const probe = await connection.openStream(
      { socketPath: STREAM_LOCAL_PROBE },
      { timeoutMs: TUNNEL_PROBE_TIMEOUT_MS },
    );
    probe.destroy();
  } catch (error) {
    // Any other refusal may be nothing listening there, or (from OpenSSH) a policy refusal.
    if (error instanceof TunnelRefusedError && error.prohibited) streamLocal = 'prohibited';
  }

  // Last, and only for a server that could take the core at all: a server that cannot reach
  // GitHub answers this probe slowly, and an unsupported one has no use for the answer.
  let serverDownload: DownloadTool | null = null;
  const remote = rid && problems.length === 0 ? options.remote?.(rid) : null;
  if (remote) {
    // Not `run`: no answer, or an unreachable release, only means the app sends the core itself.
    const probe = await connection.exec(probeCommand(remote.url), {
      timeoutMs: options.probeTimeoutMs ?? RELEASE_PROBE_TIMEOUT_MS,
      maxOutputBytes: 1_024,
    });
    if (!probe.timedOut) serverDownload = parseProbe(probe.stdout);
  }

  return {
    os,
    architecture: { machine, rid },
    systemd,
    freeDiskMb,
    sudo,
    loginUser: connection.endpoint.username,
    streamLocal,
    installed,
    selinux,
    serverDownload,
    problems,
  };
}
