import { quoteForShell } from '@runova/core';
import type { SshConnection } from '../../ssh/connection';
import { LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';

/**
 * Who can open the core's socket: root, and the members of its group (the installer adds the
 * login that installed it). Someone else's login, on a core another computer installed, needs an
 * admin of the server to add it first. Group membership only counts from the next login on.
 */

export const CORE_GROUP = RUNOVA_CORE.group;

/** Either name counts: a server set up before the rename has the old group until it migrates. */
const CORE_GROUPS = [RUNOVA_CORE.group, LEGACY_CORE.group];

const inCoreGroup = (names: string[]) => names.some((name) => CORE_GROUPS.includes(name));

const CHECK_TIMEOUT_MS = 30_000;

export type CoreGroupAccess = 'ok' | 'new-login' | 'missing';

type GroupConnection = Pick<SshConnection, 'exec'> & { endpoint: { username: string } };

async function groups(connection: GroupConnection, command: string): Promise<string[]> {
  const result = await connection.exec(command, { timeoutMs: CHECK_TIMEOUT_MS });
  return result.stdout.trim().split(/\s+/);
}

/**
 * 'ok' when this login is in the group; 'new-login' when the user is in it but this login started
 * before they were added; 'missing' when they are not in it.
 */
export async function coreGroupAccess(connection: GroupConnection): Promise<CoreGroupAccess> {
  if (inCoreGroup(await groups(connection, 'id -nG'))) return 'ok';
  const user = quoteForShell(connection.endpoint.username, 'posix');
  return inCoreGroup(await groups(connection, `id -nG -- ${user}`)) ? 'new-login' : 'missing';
}

/** `group` is the one the server's layout uses. */
export function coreGroupProblem(loginUser: string, group: string = CORE_GROUP): string {
  return `The server core runs here, but your login ${loginUser} cannot reach it: it is not in the ${group} group. Someone with sudo on this server can add it with "sudo usermod -aG ${group} ${loginUser}", then try again.`;
}
