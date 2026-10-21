import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandTimeoutError,
  type ExecResult,
  SshConnection,
  TunnelRefusedError,
} from '../../ssh/connection';
import {
  type ExecReply,
  type ExecRequest,
  type FakeSshServer,
  startFakeSshServer,
} from '../../ssh/testing/fakeSshServer';
import { type PreflightConnection, type PreflightOptions, runPreflight } from './preflight';

/**
 * Before anything runs as root, the installer looks at the server as the login user and says in
 * plain words what stands in the way: an unsupported system, no systemd, too little disk. A
 * server whose sshd forbids stream-local forwarding is fine; the core's bridge covers it.
 */

const UBUNTU = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

interface Machine {
  osRelease: string;
  machine: string;
  systemd: boolean;
  freeKb: number[];
  uid: number;
  sudo: 'passwordless' | 'password' | 'missing';
  installed: { release: string; version: string } | null;
  selinux: string | null;
  streamLocal: boolean;
  /** What the probe of the release address prints: the tool that got an answer, or nothing. */
  releaseProbe: 'curl' | 'wget' | 'none';
}

const typical: Machine = {
  osRelease: UBUNTU,
  machine: 'x86_64',
  systemd: true,
  freeKb: [20_000_000, 18_000_000],
  uid: 1000,
  sudo: 'password',
  installed: null,
  selinux: null,
  streamLocal: true,
  releaseProbe: 'curl',
};

const RELEASE_URL =
  'https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-linux-x64.tar.gz';

function answer(machine: Machine, { command }: ExecRequest): ExecReply {
  if (command === 'cat /etc/os-release') return { stdout: machine.osRelease };
  if (command === 'uname -m') return { stdout: `${machine.machine}\n` };
  if (command.startsWith('test -d /run/systemd/system'))
    return { stdout: machine.systemd ? 'yes\n' : 'no\n' };
  if (command.startsWith('df -Pk'))
    return { stdout: machine.freeKb.map((kb) => `${kb}\n`).join('') };
  if (command === 'id -u') return { stdout: `${machine.uid}\n` };
  if (command === 'sudo -k -n true') {
    if (machine.sudo === 'missing') return { exitCode: 127, stderr: 'sudo: command not found\n' };
    return { exitCode: machine.sudo === 'passwordless' ? 0 : 1 };
  }
  if (command.startsWith('readlink -f /opt/agentmate-core/current')) {
    return machine.installed ? { stdout: `${machine.installed.release}\n` } : { exitCode: 1 };
  }
  if (command.includes('admin version')) {
    return machine.installed
      ? { stdout: `${JSON.stringify({ version: machine.installed.version, apiVersion: 1 })}\n` }
      : { exitCode: 127 };
  }
  if (command.includes('getenforce')) return { stdout: `${machine.selinux ?? 'absent'}\n` };
  if (command.includes('/releases/download/')) {
    return { stdout: machine.releaseProbe === 'none' ? '' : `${machine.releaseProbe}\n` };
  }
  return { exitCode: 127, stderr: `unexpected: ${command}` };
}

let server: FakeSshServer | null = null;
let connection: SshConnection | null = null;

afterEach(async () => {
  connection?.close();
  connection = null;
  await server?.close();
  server = null;
});

const asked: string[] = [];

async function preflight(overrides: Partial<Machine> = {}, options: PreflightOptions = {}) {
  const machine = { ...typical, ...overrides };
  asked.length = 0;
  server = await startFakeSshServer({
    username: 'deployer',
    password: 'pw',
    exec: (request) => {
      asked.push(request.command);
      return answer(machine, request);
    },
    forwarding: machine.streamLocal ? 'allowed' : 'prohibited',
    // The probe targets a socket nobody listens on, so an allowed tunnel still fails to connect.
    forward: () => null,
  });
  connection = await SshConnection.open({
    host: server.host,
    port: server.port,
    username: 'deployer',
    authMethod: 'password',
    password: 'pw',
  });
  return runPreflight(connection, options);
}

describe('runPreflight', () => {
  it('reports a ready Ubuntu server with nothing in the way', async () => {
    const report = await preflight();

    expect(report).toMatchObject({
      os: { supported: true, family: 'debian', name: 'Ubuntu 24.04.1 LTS' },
      architecture: { machine: 'x86_64', rid: 'linux-x64' },
      systemd: true,
      freeDiskMb: Math.floor(18_000_000 / 1024),
      sudo: 'password',
      loginUser: 'deployer',
      streamLocal: 'allowed',
      installed: null,
      selinux: 'absent',
      problems: [],
    });
  });

  it('notices an existing install and its version', async () => {
    const report = await preflight({
      installed: { release: '/opt/agentmate-core/releases/1.52.0-abcdef012345', version: '1.52.0' },
    });

    expect(report.installed).toEqual({
      version: '1.52.0',
      release: '/opt/agentmate-core/releases/1.52.0-abcdef012345',
    });
  });

  it('is fine with sshd forbidding stream-local forwarding', async () => {
    const report = await preflight({ streamLocal: false });

    expect(report.streamLocal).toBe('prohibited');
    expect(report.problems).toEqual([]);
  });

  it('reads SELinux and a root login', async () => {
    const report = await preflight({ selinux: 'Enforcing', uid: 0 });

    expect(report.selinux).toBe('enforcing');
    expect(report.sudo).toBe('root');
  });

  describe('whether the server can fetch the core itself', () => {
    const remote: PreflightOptions['remote'] = (rid) => ({
      url: RELEASE_URL.replace('linux-x64', rid),
    });
    const probed = () => asked.filter((command) => command.includes('/releases/download/'));

    it('asks about the release for the server processor, and learns the tool that works', async () => {
      const report = await preflight({ releaseProbe: 'curl' }, { remote });

      expect(report.serverDownload).toBe('curl');
      expect(probed()).toHaveLength(1);
      expect(probed()[0]).toContain(RELEASE_URL);
    });

    it('learns wget when that is the one that works', async () => {
      expect((await preflight({ releaseProbe: 'wget' }, { remote })).serverDownload).toBe('wget');
    });

    it('is fine with a server that cannot fetch it, and says so', async () => {
      const report = await preflight({ releaseProbe: 'none' }, { remote });

      expect(report.serverDownload).toBeNull();
      expect(report.problems).toEqual([]);
    });

    it('asks nothing of GitHub unless the caller has a release address', async () => {
      const report = await preflight({ releaseProbe: 'curl' });

      expect(report.serverDownload).toBeNull();
      expect(probed()).toEqual([]);
    });

    it('asks nothing of GitHub when the source has no build for this processor', async () => {
      const report = await preflight({ releaseProbe: 'curl' }, { remote: () => null });

      expect(report.serverDownload).toBeNull();
      expect(probed()).toEqual([]);
    });

    it('does not wait on GitHub for a server that cannot take the core anyway', async () => {
      const report = await preflight({ releaseProbe: 'curl', systemd: false }, { remote });

      expect(report.problems.join('\n')).toMatch(/systemd/);
      expect(report.serverDownload).toBeNull();
      expect(probed()).toEqual([]);
    });
  });

  it.each([
    [
      'an unsupported system',
      { osRelease: 'ID=alpine\nVERSION_ID=3.20\nPRETTY_NAME="Alpine Linux v3.20"\n' },
      /not supported/,
    ],
    ['a processor without a build', { machine: 'armv7l' }, /armv7l/],
    ['no systemd', { systemd: false }, /systemd/],
    ['too little disk', { freeKb: [100 * 1024, 900 * 1024] }, /300 MB/],
    ['no sudo for a non-root login', { sudo: 'missing' as const }, /sudo is not installed/],
  ])('explains %s', async (_case, overrides, message) => {
    const report = await preflight(overrides);

    expect(report.problems.join('\n')).toMatch(message);
  });
});

/**
 * A server can accept the login and then never run a command. `exec` gives up on it with
 * `timedOut` and empty output, which the check must not read as an answer: it would wait out
 * every remaining probe, then call a healthy server's system unknown.
 */
describe('runPreflight against a server that stops answering', () => {
  const SILENT: ExecResult = {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    timedOut: true,
  };

  function connectionWhere(isSilent: (command: string) => boolean, machine: Machine = typical) {
    const asked: string[] = [];
    const connection: PreflightConnection = {
      endpoint: { host: 'quiet.example', port: 22, username: 'deployer', authMethod: 'password' },
      exec: async (command) => {
        asked.push(command);
        if (isSilent(command)) return SILENT;
        const reply = answer(machine, { command, stdin: Buffer.alloc(0) });
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          ...reply,
        } as ExecResult;
      },
      openStream: async () => {
        throw new TunnelRefusedError('nothing there', 2);
      },
    };
    return { connection, asked };
  }

  it('fails at the first silent probe and says the server did not answer', async () => {
    const { connection, asked } = connectionWhere(() => true);

    const failure = runPreflight(connection);

    await expect(failure).rejects.toBeInstanceOf(CommandTimeoutError);
    await expect(failure).rejects.toThrow(
      'quiet.example accepted the login but did not answer within 30 seconds',
    );
    expect(asked).toEqual(['cat /etc/os-release']);
  });

  it('does not take a silent sudo probe for a server that wants a password', async () => {
    const { connection } = connectionWhere((command) => command === 'sudo -k -n true');

    await expect(runPreflight(connection)).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it('takes a silent probe of the release as a server that cannot fetch it', async () => {
    // GitHub being slow or filtered is the app's cue to send the core itself, not a failed check.
    const { connection } = connectionWhere((command) => command.includes('/releases/download/'));

    const report = await runPreflight(connection, { remote: () => ({ url: RELEASE_URL }) });

    expect(report.serverDownload).toBeNull();
    expect(report.problems).toEqual([]);
  });

  it('still treats a core that hangs on its version as a broken install', async () => {
    // The release link exists, so the version probe runs, and goes quiet.
    const { connection } = connectionWhere((command) => command.includes('admin version'), {
      ...typical,
      installed: { release: '/opt/agentmate-core/releases/1.52.0-abcdef012345', version: '1.52.0' },
    });

    const report = await runPreflight(connection);

    expect(report.installed).toBeNull();
    expect(report.problems).toEqual([]);
  });
});
