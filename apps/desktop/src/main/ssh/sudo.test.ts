import { afterEach, describe, expect, it } from 'vitest';
import { sshErrorCode } from '../../shared/sshErrors';
import { CommandTimeoutError, SshConnection } from './connection';
import { detectSudoMode, openRootShell } from './sudo';
import { type ExecRequest, type FakeSshServer, startFakeSshServer } from './testing/fakeSshServer';

/**
 * Installing the core needs root. The login may be root, may have passwordless sudo, or may need
 * the sudo password. The password only ever travels on stdin, and it is checked on its own before
 * any command that carries a payload, so a wrong password can never swallow the payload as
 * retries.
 */

const LOGIN_PASSWORD = 'login-password';
const SUDO_PASSWORD = 's3cret sudo pw';

type Account = { uid: number; sudo: 'passwordless' | 'password' | 'missing' };

/** Answers the commands the helper sends the way a real server with that account would. */
function fakeServerFor(account: Account) {
  const ran: ExecRequest[] = [];
  const handler = (request: ExecRequest) => {
    const { command, stdin } = request;
    if (command === 'id -u') return { stdout: `${account.uid}\n` };
    if (account.sudo === 'missing' && command.startsWith('sudo')) {
      return { stderr: 'bash: sudo: command not found\n', exitCode: 127 };
    }
    if (command === 'sudo -k -n true') {
      return account.sudo === 'passwordless'
        ? { exitCode: 0 }
        : { stderr: 'sudo: a password is required\n', exitCode: 1 };
    }
    if (command.startsWith("sudo -S -k -p ''")) {
      const text = stdin.toString('utf8');
      const newline = text.indexOf('\n');
      const given = newline < 0 ? text : text.slice(0, newline);
      if (given !== SUDO_PASSWORD) return { stderr: 'Sorry, try again.\n', exitCode: 1 };
      if (command !== "sudo -S -k -p '' true")
        ran.push({ command, stdin: stdin.subarray(newline + 1) });
      return { exitCode: 0 };
    }
    if (command.startsWith('sudo -n --')) {
      ran.push(request);
      return { exitCode: 0 };
    }
    ran.push(request);
    return { exitCode: 0 };
  };
  return { ran, handler };
}

let server: FakeSshServer | null = null;
let connection: SshConnection | null = null;

afterEach(async () => {
  connection?.close();
  connection = null;
  await server?.close();
  server = null;
});

async function connectAs(account: Account) {
  const fake = fakeServerFor(account);
  server = await startFakeSshServer({ password: LOGIN_PASSWORD, exec: fake.handler });
  connection = await SshConnection.open({
    host: server.host,
    port: server.port,
    username: 'deploy',
    authMethod: 'password',
    password: LOGIN_PASSWORD,
  });
  return { ...fake, server, connection };
}

describe('detectSudoMode', () => {
  it('recognizes a root login', async () => {
    const { connection } = await connectAs({ uid: 0, sudo: 'password' });

    expect(await detectSudoMode(connection)).toBe('root');
  });

  it('recognizes passwordless sudo without trusting cached credentials', async () => {
    const { connection, server } = await connectAs({ uid: 1000, sudo: 'passwordless' });

    expect(await detectSudoMode(connection)).toBe('passwordless');
    expect(server.execRequests.map((request) => request.command)).toContain('sudo -k -n true');
  });

  it('recognizes sudo that needs a password', async () => {
    const { connection } = await connectAs({ uid: 1000, sudo: 'password' });

    expect(await detectSudoMode(connection)).toBe('password');
  });

  it('explains a server without sudo', async () => {
    const { connection } = await connectAs({ uid: 1000, sudo: 'missing' });

    await expect(detectSudoMode(connection)).rejects.toThrow(/sudo is not installed/);
  });

  async function connectTo(options: Parameters<typeof startFakeSshServer>[0]) {
    server = await startFakeSshServer(options);
    connection = await SshConnection.open({
      host: server.host,
      port: server.port,
      username: 'deploy',
      authMethod: 'password',
      password: LOGIN_PASSWORD,
    });
    return connection;
  }

  it('says so when the server logs in but never runs a command', async () => {
    const quiet = await connectTo({ password: LOGIN_PASSWORD, neverAnswer: 'commands' });

    const failure = detectSudoMode(quiet, { timeoutMs: 150 });

    await expect(failure).rejects.toBeInstanceOf(CommandTimeoutError);
    await expect(failure).rejects.toThrow(/did not answer within 150 ms/);
  });

  it('does not take a silent sudo for one that wants a password', async () => {
    const stalled = await connectTo({
      password: LOGIN_PASSWORD,
      // `id -u` answers, then the server goes quiet on the sudo probe.
      exec: ({ command }) =>
        command === 'id -u' ? { stdout: '1000\n' } : new Promise<never>(() => undefined),
    });

    await expect(detectSudoMode(stalled, { timeoutMs: 150 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
  });
});

describe('openRootShell', () => {
  it('runs commands directly for a root login', async () => {
    const { connection, ran } = await connectAs({ uid: 0, sudo: 'password' });
    const shell = await openRootShell(connection, null);

    await shell.run('systemctl daemon-reload', { stdin: 'payload' });

    expect(ran.at(-1)).toEqual({
      command: 'systemctl daemon-reload',
      stdin: Buffer.from('payload'),
    });
  });

  it('uses sudo -n with nothing extra on stdin when no password is needed', async () => {
    const { connection, ran } = await connectAs({ uid: 1000, sudo: 'passwordless' });
    const shell = await openRootShell(connection, null);

    await shell.run("install -m 0755 /tmp/x '/opt/runova core'", { stdin: 'payload' });

    expect(ran.at(-1)?.command).toBe(
      `sudo -n -- sh -c 'install -m 0755 /tmp/x '\\''/opt/runova core'\\'''`,
    );
    expect(ran.at(-1)?.stdin.toString()).toBe('payload');
  });

  it('sends the password on stdin only, ahead of the payload, after checking it', async () => {
    const { connection, ran, server } = await connectAs({ uid: 1000, sudo: 'password' });
    const shell = await openRootShell(connection, SUDO_PASSWORD);
    const payload = Buffer.from([0x00, 0xff, 0x0a, 0x41]);

    await shell.run('runova-core admin create-owner --password-stdin', { stdin: payload });

    expect(ran.at(-1)?.stdin.equals(payload)).toBe(true);
    for (const request of server.execRequests) {
      expect(request.command).not.toContain(SUDO_PASSWORD);
    }
    expect(server.execRequests.map((request) => request.command)).toContain(
      "sudo -S -k -p '' true",
    );
  });

  it('refuses a wrong password before any payload is sent', async () => {
    const { connection, ran } = await connectAs({ uid: 1000, sudo: 'password' });

    const failure = openRootShell(connection, 'not the password');

    await expect(failure).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'sudo-password-rejected',
    );
    expect(ran).toEqual([]);
  });

  it('asks for the sudo password when none is known', async () => {
    const { connection } = await connectAs({ uid: 1000, sudo: 'password' });

    const failure = openRootShell(connection, null);

    await expect(failure).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'sudo-password-required',
    );
    await expect(openRootShell(connection, null)).rejects.toThrow(/deploy/);
  });

  it('rejects a password with a line break, which sudo -S could never read', async () => {
    const { connection, server } = await connectAs({ uid: 1000, sudo: 'password' });
    const before = server.execRequests.length;

    await expect(openRootShell(connection, 'one\ntwo')).rejects.toThrow(/line break/);
    expect(server.execRequests.slice(before).map((request) => request.command)).not.toContain(
      "sudo -S -k -p '' true",
    );
  });
});
