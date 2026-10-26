import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../../ssh/connection';
import { CORE_GROUP, coreGroupAccess, coreGroupProblem } from './coreGroup';

/**
 * Whether an SSH login can reach the core's socket, which only root and the runova group may
 * open. Group membership counts from the next login on, so a login that started before someone
 * added the user needs a fresh one rather than a refusal.
 */

function connection(session: string, configured: string, username = 'sam') {
  const commands: string[] = [];
  return {
    commands,
    endpoint: { username },
    exec: async (command: string): Promise<ExecResult> => {
      commands.push(command);
      const stdout = command === 'id -nG' ? session : configured;
      return { stdout: `${stdout}\n`, stderr: '', exitCode: 0, signal: null, timedOut: false };
    },
  };
}

describe('coreGroupAccess', () => {
  it('is fine when this login is in the group', async () => {
    const ssh = connection('sam docker runova', 'sam docker runova');

    expect(await coreGroupAccess(ssh)).toBe('ok');
    expect(ssh.commands).toEqual(['id -nG']);
  });

  it('asks for a new login when the user joined the group after this one started', async () => {
    const ssh = connection('sam docker', 'sam docker runova');

    expect(await coreGroupAccess(ssh)).toBe('new-login');
    expect(ssh.commands).toEqual(['id -nG', 'id -nG -- sam']);
  });

  it('says when the user is not in the group at all', async () => {
    expect(await coreGroupAccess(connection('sam', 'sam'))).toBe('missing');
  });

  it('does not take a group whose name only starts the same for the one it needs', async () => {
    expect(await coreGroupAccess(connection('runova-old', 'runova-old'))).toBe('missing');
  });
});

describe('coreGroupProblem', () => {
  it('names the group, the login and the command that fixes it', () => {
    const message = coreGroupProblem('sam');

    expect(message).toContain(`not in the ${CORE_GROUP} group`);
    expect(message).toContain('sudo usermod -aG runova sam');
  });
});
