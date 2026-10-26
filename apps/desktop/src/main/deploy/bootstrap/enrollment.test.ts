import { describe, expect, it } from 'vitest';
import { openRootShell } from '../../ssh/sudo';
import { CORE_PROGRAM } from '../coreProgram';
import { enrollOverSsh } from './enrollment';
import type { InstallProgress } from './installer';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './testing/scriptedServer';

/**
 * Enrolling this computer on a core over SSH: the owner account is created on a new core, and a
 * fresh device key's public half is registered. The owner's password and the key only ever travel
 * on stdin, never on a command line, where `ps` and shell history would show them (AC4).
 */

const PASSWORD = 'correct horse battery staple';

async function setup(machine: Partial<ScriptedMachine> = {}) {
  const server = new ScriptedConnection(scriptedMachine(machine));
  const shell = await openRootShell(server, 'deployer-pw');
  const progress: InstallProgress[] = [];
  return {
    server,
    progress,
    enroll: (userName = 'maria', password = PASSWORD) =>
      enrollOverSsh(shell, { userName, password, deviceName: "Maria's laptop" }, (event) =>
        progress.push(event),
      ),
  };
}

describe('enrollOverSsh', () => {
  it('creates the owner on a new core and enrolls this computer', async () => {
    const { server, enroll } = await setup();

    const enrolled = await enroll();

    expect(enrolled).toMatchObject({ deviceId: 'device-1', userName: 'maria', createdOwner: true });
    expect(
      server.rootCommands.some((command) =>
        command.includes('admin create-owner --username maria --password-stdin'),
      ),
    ).toBe(true);
    expect(
      server.rootCommands.some((command) =>
        command.includes("admin enroll-device --user maria --name 'Maria'\\''s laptop'"),
      ),
    ).toBe(true);
    expect(enrolled.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('never puts the password or the key on a command line', async () => {
    const { server, enroll } = await setup();

    const enrolled = await enroll();

    const publicKey = server.enrolledKeys[0];
    for (const { command } of server.execs) {
      expect(command).not.toContain(PASSWORD);
      expect(command).not.toContain(publicKey);
    }
    const passwordReaders = server.rootStdin.filter(({ stdin }) => stdin.includes(PASSWORD));
    expect(passwordReaders.map(({ command }) => command)).toEqual([
      `${CORE_PROGRAM} admin create-owner --username maria --password-stdin`,
    ]);
    const keyReaders = server.rootStdin.filter(({ stdin }) => stdin.includes(publicKey));
    expect(keyReaders).toHaveLength(1);
    expect(keyReaders[0].command).toContain('admin enroll-device');
    // The private half never leaves this computer, in any form.
    const body = enrolled.privateKeyPem.split('\n')[1];
    expect(
      server.execs.some(({ command, stdin }) => command.includes(body) || stdin.includes(body)),
    ).toBe(false);
  });

  it('enrolls for an existing user on a core that has its owner already', async () => {
    const { server, enroll } = await setup({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });

    const enrolled = await enroll();

    expect(enrolled.createdOwner).toBe(false);
    expect(server.rootCommands.some((command) => command.includes('create-owner'))).toBe(false);
    expect(server.enrolledKeys).toHaveLength(1);
  });

  it('refuses a user the core does not have, before enrolling anything', async () => {
    const { server, enroll } = await setup({ coreUsers: [{ userName: 'sam', roles: ['owner'] }] });

    await expect(enroll()).rejects.toThrow(/no user called maria/);
    expect(server.enrolledKeys).toHaveLength(0);
  });

  it('passes on why the core refused the owner password', async () => {
    const { server, progress, enroll } = await setup({
      ownerPasswordRefusal: 'That password is too common; it appears in lists attackers try first.',
    });

    await expect(enroll()).rejects.toThrow(/too common/);
    expect(server.enrolledKeys).toHaveLength(0);
    expect(progress.at(-1)).toMatchObject({ phase: 'owner', status: 'failed' });
  });

  it('checks the password before anything reaches the server', async () => {
    const { server, enroll } = await setup();

    await expect(enroll('maria', 'too short')).rejects.toThrow(/at least 12/);
    await expect(enroll('maria', `${PASSWORD}\nsecond line`)).rejects.toThrow(/line break/);
    await expect(enroll('maria; rm -rf /', PASSWORD)).rejects.toThrow(/user name/);
    expect(server.rootCommands).toHaveLength(0);
  });

  it('reports each step', async () => {
    const { progress, enroll } = await setup();

    await enroll();

    expect(progress.filter((event) => event.status === 'done').map((event) => event.phase)).toEqual(
      ['owner', 'enroll'],
    );
  });
});
