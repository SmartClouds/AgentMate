import { Duplex } from 'node:stream';
import type { SshEndpoint } from '../../../ssh/connectConfig';
import type { ExecOptions, ExecResult, UploadOptions } from '../../../ssh/connection';
import { TunnelRefusedError } from '../../../ssh/connection';

/**
 * A server as a script: it answers the preflight's probes and the installer's root commands the
 * way a real Ubuntu or Rocky machine would, and records everything, so installer tests read like
 * a transcript. Root commands can be made to fail to test checksum and start failures.
 */

export interface ScriptedMachine {
  osRelease: string;
  machine: string;
  uid: number;
  sudo: 'passwordless' | 'password';
  sudoPassword: string;
  streamLocal: boolean;
  installed: { release: string; version: string } | null;
  selinux: 'Enforcing' | null;
  /** Root commands (matched by substring) that should fail, with what they print. */
  failures: Array<{ match: string; stderr: string; exitCode?: number }>;
  /** The users `agentmate-core admin status` reports. */
  coreUsers: Array<{ userName: string; roles: string[] }>;
  /** When set, `admin create-owner` refuses the password with this reason. */
  ownerPasswordRefusal: string | null;
  /** The login's groups, as `id -nG` prints them for this session. */
  groups: string[];
  /** The user's groups on the server now (`id -nG <user>`); null when the same as `groups`. */
  configuredGroups: string[] | null;
  /** What `admin restore-stage` prints about the backup it checked (E15). */
  stagedBackup: string;
  /** The tool the release probe finds; null when the server has neither or cannot reach GitHub. */
  serverDownload: 'curl' | 'wget' | null;
  /** When set, the server's own download fails with this, as curl or wget would print it. */
  downloadFailure: { stderr: string; exitCode?: number } | null;
}

export const UBUNTU_24 =
  'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

export function scriptedMachine(overrides: Partial<ScriptedMachine> = {}): ScriptedMachine {
  return {
    osRelease: UBUNTU_24,
    machine: 'x86_64',
    uid: 1000,
    sudo: 'password',
    sudoPassword: 'deployer-pw',
    streamLocal: true,
    installed: null,
    selinux: null,
    failures: [],
    coreUsers: [],
    ownerPasswordRefusal: null,
    groups: ['deployer', 'agentmate'],
    configuredGroups: null,
    stagedBackup: JSON.stringify({
      coreVersion: '1.52.0',
      createdAtUnixMs: 1_790_000_000_000,
      hostName: 'old-web',
      contents: { users: 2 },
      owners: ['maria'],
    }),
    serverDownload: null,
    downloadFailure: null,
    ...overrides,
  };
}

function done(stdout = '', exitCode = 0, stderr = ''): ExecResult {
  return { stdout, stderr, exitCode, signal: null, timedOut: false };
}

/** Undoes the `sh -c '<command>'` quoting the root shell adds. */
function unquote(quoted: string): string {
  if (!quoted.startsWith("'")) return quoted;
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

export class ScriptedConnection {
  readonly endpoint: SshEndpoint;
  readonly commands: string[] = [];
  readonly rootCommands: string[] = [];
  readonly uploads: Array<{ path: string; bytes: number; mode?: number }> = [];
  /** The login user's downloads of the release, as the commands reached the server. */
  readonly downloads: string[] = [];
  /** The login user's probes of the release address. */
  readonly probes: string[] = [];
  readonly tunnels: string[] = [];
  readonly execStreams: string[] = [];
  /** Every exec as it reached the server: the command line and everything written to stdin. */
  readonly execs: Array<{ command: string; stdin: string }> = [];
  /** What each root command itself read on stdin, after sudo took its password line. */
  readonly rootStdin: Array<{ command: string; stdin: string }> = [];
  readonly enrolledKeys: string[] = [];

  constructor(readonly machine: ScriptedMachine) {
    this.endpoint = {
      host: 'prod.example',
      port: 22,
      username: machine.uid === 0 ? 'root' : 'deployer',
      authMethod: 'password',
      password: machine.sudoPassword,
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.commands.push(command);
    const stdin = options.stdin === undefined ? '' : String(options.stdin);
    this.execs.push({ command, stdin });
    const m = this.machine;

    if (command === 'cat /etc/os-release') return done(m.osRelease);
    if (command === 'uname -m') return done(`${m.machine}\n`);
    if (command.startsWith('test -d /run/systemd/system')) return done('yes\n');
    if (command.startsWith('df -Pk')) return done('20000000\n20000000\n');
    if (command === 'id -u') return done(`${m.uid}\n`);
    if (command === 'id -nG') return done(`${m.groups.join(' ')}\n`);
    if (command.startsWith('id -nG -- ')) {
      return done(`${(m.configuredGroups ?? m.groups).join(' ')}\n`);
    }
    if (command === 'sudo -k -n true') return done('', m.sudo === 'passwordless' ? 0 : 1);
    if (command.startsWith('readlink -f /opt/agentmate-core/current')) {
      return m.installed ? done(`${m.installed.release}\n`) : done('', 1);
    }
    if (command.includes('admin version')) {
      return m.installed ? done(JSON.stringify({ version: m.installed.version })) : done('', 127);
    }
    if (command.includes('getenforce')) return done(`${m.selinux ?? 'absent'}\n`);
    if (command.startsWith('mktemp -d')) return done('/tmp/agentmate.Test123456\n');
    if (command.startsWith('rm -rf /tmp/agentmate.')) return done();

    // The login user's own commands against the release: never root's, even on a root login.
    if (command.startsWith('sh -c ') && command.includes('/releases/download/')) {
      if (command.includes('command -v curl')) {
        this.probes.push(command);
        return done(m.serverDownload ? `${m.serverDownload}\n` : '');
      }
      this.downloads.push(command);
      const failure = m.downloadFailure;
      return failure ? done('', failure.exitCode ?? 22, failure.stderr) : done();
    }

    if (command === "sudo -S -k -p '' true") {
      return stdin.split('\n')[0] === m.sudoPassword ? done() : done('', 1, 'Sorry, try again.\n');
    }
    let unwrapped: string | null = null;
    const sudoWrapped = /^sudo (?:-S -k -p '' |-n )-- sh -c (.+)$/s.exec(command);
    if (sudoWrapped) {
      if (command.startsWith('sudo -S') && stdin.split('\n')[0] !== m.sudoPassword) {
        return done('', 1, 'Sorry, try again.\n');
      }
      unwrapped = unquote(sudoWrapped[1]);
    } else if (m.uid === 0) {
      unwrapped = command;
    }
    if (unwrapped === null) return done('', 127, `unexpected command: ${command}`);
    const root = unwrapped;

    this.rootCommands.push(root);
    // sudo -S reads the first line itself; the command gets the rest.
    const payload =
      sudoWrapped && command.startsWith('sudo -S') ? stdin.slice(stdin.indexOf('\n') + 1) : stdin;
    this.rootStdin.push({ command: root, stdin: payload });
    const failure = m.failures.find((candidate) => root.includes(candidate.match));
    if (failure) return done('', failure.exitCode ?? 1, failure.stderr);
    if (root.startsWith('journalctl')) return done('agentmate-core: Unhandled exception. Boom.\n');
    if (root.endsWith(' admin status')) {
      const initialized = m.coreUsers.some((user) => user.roles.includes('owner'));
      const users = m.coreUsers.map((user) => ({ ...user, devices: 0 }));
      return done(`${JSON.stringify({ initialized, users })}\n`);
    }
    const owner = /admin create-owner --username (\S+) --password-stdin$/.exec(root);
    if (owner) {
      if (m.ownerPasswordRefusal) return done('', 1, `${m.ownerPasswordRefusal}\n`);
      m.coreUsers.push({ userName: unquote(owner[1]), roles: ['owner'] });
      return done('{"userId":"11111111-2222-4333-8444-555555555555"}\n');
    }
    if (/ admin restore-stage /.test(root)) return done(`${m.stagedBackup}\n`);
    if (/ admin enroll-device --user /.test(root)) {
      this.enrolledKeys.push(payload.trim());
      return done(`{"deviceId":"device-${this.enrolledKeys.length}"}\n`);
    }
    return done();
  }

  async upload(content: Buffer, remotePath: string, options: UploadOptions = {}): Promise<void> {
    this.uploads.push({ path: remotePath, bytes: content.length, mode: options.mode });
    options.onProgress?.(content.length, content.length);
  }

  async createStagingDirectory(): Promise<string> {
    return '/tmp/agentmate.Test123456';
  }

  async openStream(
    target: { socketPath: string } | { host: string; port: number },
  ): Promise<Duplex> {
    const path = 'socketPath' in target ? target.socketPath : `${target.host}:${target.port}`;
    this.tunnels.push(path);
    if (!this.machine.streamLocal) throw new TunnelRefusedError(`refused ${path}`, 1);
    throw new TunnelRefusedError(`nothing at ${path}`, 2);
  }

  async openExecStream(command: string): Promise<Duplex> {
    this.execStreams.push(command);
    return new Duplex({
      read: () => undefined,
      write: (_chunk, _encoding, callback) => callback(),
    });
  }
}
