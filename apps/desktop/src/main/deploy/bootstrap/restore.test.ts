import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployRestoreProgress } from '../../../shared/deployHardeningTypes';
import { tempDir } from '../../../test/main/fixtures';
import { restoreCore } from './restore';
import { PREVIOUS } from './restorePlan';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './testing/scriptedServer';

/**
 * A restore over SSH as root: the backup is staged and checked beside the running core, with the
 * passphrase on stdin; only an Owner of the backup can be signed in as; the state folder is swapped
 * only after that; a core that will not start or answer on the restored state goes back to the
 * state from before; and this computer enrolls on the restored core.
 */

const PASSPHRASE = 'orange tractor bicycle lamp';

function setup(
  machine: Partial<ScriptedMachine> = {},
  health?: () => Promise<HealthResponse>,
  onServer?: string,
) {
  const server = new ScriptedConnection(scriptedMachine(machine));
  const file = onServer ?? join(tempDir(), 'web.ambackup');
  if (!onServer) writeFileSync(file, 'AMBACKUP ciphertext');
  const progress: DeployRestoreProgress[] = [];
  const run = (userName = 'maria') =>
    restoreCore(
      {
        connect: async () => ({ connection: server, release: () => undefined }),
        health: vi.fn(
          health ??
            (async () => ({ status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 1 })),
        ),
      },
      {
        serverId: 'srv',
        file,
        ...(onServer ? { fileOnServer: true } : {}),
        passphrase: PASSPHRASE,
        sudoPassword: null,
        userName,
        password: 'correct horse battery staple',
        deviceName: 'Laptop',
        onProgress: (event) => progress.push(event),
      },
    );
  const phases = () =>
    progress
      .filter((event) => event.status !== 'running')
      .map((event) => `${event.phase}:${event.status}`);
  return { server, run, phases };
}

describe('restoreCore', () => {
  it('stages, swaps, checks and enrolls, with the passphrase on stdin only', async () => {
    const { server, run, phases } = setup({ coreUsers: [{ userName: 'maria', roles: ['owner'] }] });

    const restored = await run('Maria');

    expect(restored.backup).toMatchObject({
      coreVersion: '1.52.0',
      hostName: 'old-web',
      owners: ['maria'],
    });
    expect(restored.enrollment.userName).toBe('maria');
    expect(restored.previousStateFolder).toBe(PREVIOUS);
    expect(server.uploads).toEqual([
      { path: '/tmp/runova.Test123456/backup.rnbackup', bytes: 19, mode: 0o600 },
    ]);
    const stage = server.rootStdin.find((entry) => entry.command.includes('admin restore-stage'));
    expect(stage?.stdin).toBe(`${PASSPHRASE}\n`);
    expect(server.commands.join('\n')).not.toContain(PASSPHRASE.split(' ')[1]);
    const order = server.rootCommands
      .map((command) =>
        command.includes('restore-stage')
          ? 'stage'
          : command === 'systemctl stop runova-core'
            ? 'stop'
            : command.startsWith('rm -rf /var/lib/runova-core-restore/previous')
              ? 'swap'
              : command === 'systemctl start runova-core'
                ? 'start'
                : command.includes('enroll-device')
                  ? 'enroll'
                  : null,
      )
      .filter(Boolean);
    expect(order).toEqual(['stage', 'stop', 'swap', 'start', 'enroll']);
    expect(phases()).toEqual([
      'upload:done',
      'stage:done',
      'stop:done',
      'swap:done',
      'start:done',
      'health:done',
      'enroll:done',
      'enroll:done',
      'cleanup:done',
    ]);
    expect(server.commands.some((command) => command.startsWith('rm -rf /tmp/runova.'))).toBe(true);
  });

  it('stages a backup the core already fetched onto the server, without an upload (E28)', async () => {
    const fetched = '/var/lib/runova-core/backups/0f8b0f8b0f8b0f8b0f8b0f8b0f8b0f8b.ambackup';
    const { server, run, phases } = setup(
      { coreUsers: [{ userName: 'maria', roles: ['owner'] }] },
      undefined,
      fetched,
    );

    await run();

    expect(server.uploads).toEqual([]);
    const stage = server.rootStdin.find((entry) => entry.command.includes('admin restore-stage'));
    expect(stage?.command).toContain(fetched);
    expect(stage?.stdin).toBe(`${PASSPHRASE}
`);
    expect(phases()[0]).toBe('stage:done');
  });

  it('refuses a fetched file outside the folder the core fetches into', async () => {
    const { server, run } = setup({}, undefined, '/etc/shadow');
    await expect(run()).rejects.toThrow(/not where/);
    expect(server.rootCommands).toEqual([]);
  });

  it('changes nothing when the backup refuses its passphrase', async () => {
    const { server, run } = setup({
      failures: [
        {
          match: 'admin restore-stage',
          stderr: 'The passphrase is wrong, or the backup file is damaged.',
        },
      ],
    });

    await expect(run()).rejects.toThrow('The passphrase is wrong, or the backup file is damaged.');
    expect(server.rootCommands.some((command) => command.includes('systemctl stop'))).toBe(false);
  });

  it('changes nothing while a firewall or SSH change on the server waits to be kept', async () => {
    const refusal =
      'This server has a change waiting to be kept or reverted: SSH change "SSH password login off" (c1). Keep or revert it on this server first, then restore.';
    const { server, run, phases } = setup({
      failures: [{ match: 'admin restore-stage', stderr: refusal }],
    });

    await expect(run()).rejects.toThrow('Keep or revert it on this server first');
    expect(phases()).toContain('stage:failed');
    expect(server.rootCommands.some((command) => command.includes('systemctl stop'))).toBe(false);
    expect(server.rootCommands.some((command) => command.includes('mv -T'))).toBe(false);
  });

  it('changes nothing when the account is not one of the backup Owners', async () => {
    const { server, run } = setup();

    await expect(run('zoe')).rejects.toThrow(
      'zoe is not an Owner in this backup, so nothing was changed. Its Owners: maria.',
    );
    expect(server.rootCommands.some((command) => command.includes('systemctl stop'))).toBe(false);
  });

  it('goes back to the state from before when the restored core does not answer', async () => {
    const { server, run, phases } = setup({}, async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await expect(run()).rejects.toThrow(
      /ECONNREFUSED The server went back to the state it had before/,
    );
    expect(server.rootCommands.at(-1)).toContain(
      'mv -T /var/lib/runova-core-restore/previous /var/lib/runova-core',
    );
    expect(phases()).toContain('rollback:done');
    expect(server.rootCommands.some((command) => command.includes('enroll-device'))).toBe(false);
  });

  it('says so when going back fails too', async () => {
    const { run } = setup({
      failures: [
        {
          match: 'systemctl start runova-core',
          stderr: 'Job for runova-core.service failed.',
        },
      ],
    });

    await expect(run()).rejects.toThrow(/Going back to the state from before failed too/);
  });
});
