import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { sshErrorCode } from '../../../shared/sshErrors';
import { tempDir } from '../../../test/main/fixtures';
import { TunnelRefusedError } from '../../ssh/connection';
import type { CoreTransportKind } from '../connection/transport';
import { type InstallerDeps, type InstallProgress, installCore, uninstallCore } from './installer';
import { CHECKSUM_MISMATCH_EXIT, releaseDirectory } from './installPlan';
import type { CoreRelease, ReleaseSource } from './releaseSource';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './testing/scriptedServer';

/**
 * Installing the core from the app: look at the server, fetch the verified release, upload it,
 * run the install as root step by step, log in again so a new group applies, and prove the core
 * answers through the tunnel. Anything that goes wrong stops the install with a reason, and a
 * release that will not start or answer hands the server back to the one before it.
 */

const SHA = 'ab'.repeat(32);
const STAGING = '/tmp/agentmate.Test123456';
const PREVIOUS = '/opt/agentmate-core/releases/1.52.0-cdcdcdcdcdcd';

/**
 * A source like the packaged build's, whose servers may fetch the release themselves (`remote`),
 * or like a development build's, which only has a local copy to upload.
 */
function releaseSource(
  version = '1.53.0',
  { remote = false, releaseError }: { remote?: boolean; releaseError?: Error } = {},
) {
  const localPath = join(tempDir(), `agentmate-core-${version}-linux-x64.tar.gz`);
  writeFileSync(localPath, 'tarball bytes');
  const file = (rid: string) => `agentmate-core-${version}-${rid}.tar.gz`;
  const release = vi.fn(async (rid: CoreRelease['rid']): Promise<CoreRelease> => {
    if (releaseError) throw releaseError;
    return { version, rid, file: file(rid), sha256: SHA, localPath };
  });
  const source: ReleaseSource = {
    release,
    ...(remote
      ? {
          remote: (rid) => ({
            version,
            rid,
            file: file(rid),
            sha256: SHA,
            url: `https://github.com/SmartClouds/AgentMate/releases/download/v${version}/${file(rid)}`,
          }),
        }
      : {}),
  };
  return { source, release };
}

interface SetupOptions {
  healthVersion?: string;
  healthError?: Error;
  /** Only these transports reach the core; the others fail the way a refused tunnel does. */
  reachableBy?: CoreTransportKind[];
  /** The release source names a public address, as a packaged build's does. */
  remote?: boolean;
  /** The app cannot get its own copy of the release. */
  releaseError?: Error;
}

function setup(machine: Partial<ScriptedMachine> = {}, options: SetupOptions = {}) {
  const server = new ScriptedConnection(scriptedMachine(machine));
  const connect = vi.fn(async (_serverId: string, _options?: { fresh?: boolean }) => ({
    connection: server,
    release: () => undefined,
  }));
  const health = vi.fn(
    async (_connection: unknown, _transport: CoreTransportKind): Promise<HealthResponse> => {
      if (options.healthError) throw options.healthError;
      if (options.reachableBy && !options.reachableBy.includes(_transport)) {
        throw new TunnelRefusedError('Could not open a tunnel: open failed', 2);
      }
      return {
        status: 'ok',
        version: options.healthVersion ?? '1.53.0',
        apiVersion: 1,
        startedAtUnixMs: 1,
      };
    },
  );
  const { source, release } = releaseSource('1.53.0', options);
  const deps: InstallerDeps = { connect, releases: source, health };
  const progress: InstallProgress[] = [];
  return {
    server,
    connect,
    health,
    release,
    progress,
    install: (sudoPassword: string | null = null) =>
      installCore(deps, {
        serverId: 'srv-1',
        sudoPassword,
        onProgress: (event) => progress.push(event),
      }),
  };
}

const ran = (server: ScriptedConnection, fragment: string): boolean =>
  server.rootCommands.some((command) => command.includes(fragment));

describe('installCore', () => {
  it('installs on a non-root login and proves the core answers', async () => {
    const { server, connect, health, install } = setup();

    const result = await install('deployer-pw');

    expect(result).toEqual({
      version: '1.53.0',
      release: releaseDirectory('1.53.0', SHA),
      transport: 'streamlocal',
      previousVersion: null,
      os: 'Ubuntu 24.04.1 LTS',
      architecture: 'x86_64',
    });
    expect(server.uploads).toEqual([
      { path: `${STAGING}/agentmate-core-1.53.0-linux-x64.tar.gz`, bytes: 13, mode: 0o600 },
    ]);
    const order = [
      'sha256sum -c',
      'groupadd',
      'tar -xzf',
      'agentmate-core.service /etc/systemd',
      'current.new',
      'systemctl restart',
      'for release in *',
    ];
    const positions = order.map((fragment) =>
      server.rootCommands.findIndex((command) => command.includes(fragment)),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The group only applies to new logins, so the health check logs in again.
    expect(connect).toHaveBeenLastCalledWith('srv-1', { fresh: true });
    expect(health).toHaveBeenCalledWith(server, 'streamlocal');
    expect(server.commands).toContain(`rm -rf ${STAGING}`);
  });

  it('keeps the same login for a root login', async () => {
    const { connect, install } = setup({ uid: 0 });

    await install();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('uses the saved login password for sudo when none is given', async () => {
    const { server, install } = setup();

    await install(null);

    expect(ran(server, 'systemctl restart')).toBe(true);
  });

  it('stops before running anything as root when the server cannot take the core', async () => {
    const { server, install } = setup({
      osRelease: 'ID=alpine\nVERSION_ID=3.20\nPRETTY_NAME="Alpine 3.20"\n',
    });

    await expect(install('deployer-pw')).rejects.toThrow(/not supported/);
    expect(server.rootCommands).toEqual([]);
    expect(server.uploads).toEqual([]);
  });

  it('stops with a sudo error before uploading anything when the password is wrong', async () => {
    const { server, install } = setup();

    await expect(install('wrong')).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'sudo-password-rejected',
    );
    expect(server.uploads).toEqual([]);
  });

  it('refuses a download that does not match its checksum before unpacking it', async () => {
    const { server, install } = setup({
      failures: [{ match: 'sha256sum -c', stderr: '', exitCode: CHECKSUM_MISMATCH_EXIT }],
    });

    await expect(install('deployer-pw')).rejects.toThrow(/does not match its published checksum/);
    expect(ran(server, 'tar -xzf')).toBe(false);
    expect(ran(server, 'systemctl restart')).toBe(false);
  });

  it('tells a failed copy apart from a checksum mismatch', async () => {
    const { install } = setup({
      failures: [{ match: 'sha256sum -c', stderr: 'cp: error writing: No space left on device' }],
    });

    const failure = await install('deployer-pw').catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/No space left on device/);
    expect((failure as Error).message).not.toMatch(/does not match/);
  });

  it('removes the staging folder even when the install fails', async () => {
    const { server, install } = setup({ failures: [{ match: 'tar -xzf', stderr: 'broken' }] });

    await expect(install('deployer-pw')).rejects.toThrow();
    expect(server.commands).toContain(`rm -rf ${STAGING}`);
  });

  it('goes back to the previous release when the new one will not start', async () => {
    const { server, install } = setup({
      installed: { release: PREVIOUS, version: '1.52.0' },
      failures: [
        { match: 'enable agentmate-core', stderr: 'Job for agentmate-core.service failed' },
      ],
    });

    await expect(install('deployer-pw')).rejects.toThrow(/did not start.*back to 1\.52\.0/s);
    expect(server.rootCommands.some((command) => command.startsWith(`ln -sfn ${PREVIOUS} `))).toBe(
      true,
    );
  });

  it('says so when going back fails too', async () => {
    const { progress, install } = setup({
      installed: { release: PREVIOUS, version: '1.52.0' },
      failures: [
        { match: 'enable agentmate-core', stderr: 'failed' },
        { match: `ln -sfn ${PREVIOUS}`, stderr: 'ln: Read-only file system' },
      ],
    });

    await expect(install('deployer-pw')).rejects.toThrow(
      /Going back to 1\.52\.0 failed too: ln: Read-only file system/,
    );
    expect(progress.at(-1)).toMatchObject({ phase: 'rollback', status: 'failed' });
  });

  it('shows what the core logged when a first install will not start', async () => {
    const { install } = setup({ failures: [{ match: 'enable agentmate-core', stderr: 'failed' }] });

    await expect(install('deployer-pw')).rejects.toThrow(/Unhandled exception\. Boom\./);
  });

  it('does not try to go back to the release it just reinstalled', async () => {
    const { server, install } = setup({
      installed: { release: releaseDirectory('1.53.0', SHA), version: '1.53.0' },
      failures: [{ match: 'enable agentmate-core', stderr: 'failed' }],
    });

    const failure = await install('deployer-pw').catch((error: Error) => error);

    expect((failure as Error).message).not.toMatch(/went back/);
    // Only the switch itself.
    expect(server.rootCommands.filter((command) => command.includes('ln -sfn'))).toHaveLength(1);
  });

  it('ignores a current link that points outside the releases folder', async () => {
    const { server, install } = setup({
      installed: { release: '/usr/local/agentmate', version: '0.9.0' },
    });

    const result = await install('deployer-pw');

    expect(result.previousVersion).toBe('0.9.0');
    expect(ran(server, '/usr/local/agentmate')).toBe(false);
  });

  it('goes back to the previous release when the new one does not answer', async () => {
    const { server, connect, install } = setup(
      { installed: { release: PREVIOUS, version: '1.52.0' } },
      { healthError: new Error('The server core did not answer GET /api/v1/health in time.') },
    );

    await expect(install('deployer-pw')).rejects.toThrow(
      /cannot reach it: The server core did not answer.*back to 1\.52\.0/s,
    );
    // Going back needs root again, on the new login.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(server.rootCommands.at(-1)).toMatch(new RegExp(`^ln -sfn ${PREVIOUS} `));
  });

  it('checks health through the bridge when sshd forbids tunnels', async () => {
    const { health, server, install } = setup({ streamLocal: false });

    const result = await install('deployer-pw');

    expect(result.transport).toBe('bridge');
    expect(health).toHaveBeenCalledWith(server, 'bridge');
  });

  it('falls back to the bridge when sshd refuses the tunnel to the real socket', async () => {
    // OpenSSH gives the same answer to a forbidden tunnel as to a missing socket, so only a
    // try after the install can tell.
    const { health, server, install } = setup({}, { reachableBy: ['bridge'] });

    const result = await install('deployer-pw');

    expect(result.transport).toBe('bridge');
    expect(health.mock.calls.map(([, transport]) => transport)).toEqual(['streamlocal', 'bridge']);
    expect(health).toHaveBeenLastCalledWith(server, 'bridge');
  });

  it('says why when neither way reaches the core', async () => {
    const { install } = setup({}, { reachableBy: [] });

    await expect(install('deployer-pw')).rejects.toThrow(/cannot reach it/);
  });

  it('refuses a core that answers with a different version', async () => {
    const { install } = setup({}, { healthVersion: '1.0.0' });

    await expect(install('deployer-pw')).rejects.toThrow(/answers as 1\.0\.0, not 1\.53\.0/);
  });

  it('finishes when old files cannot be removed, and says so', async () => {
    const { progress, install } = setup({
      failures: [{ match: 'for release in *', stderr: 'rm: cannot remove' }],
    });

    await install('deployer-pw');

    const cleanup = progress.find(
      (event) => event.phase === 'cleanup' && event.status !== 'running',
    );
    expect(cleanup).toMatchObject({
      status: 'done',
      detail: expect.stringMatching(/cannot remove/),
    });
  });

  it('reports each step as it goes', async () => {
    const { progress, install } = setup({ selinux: 'Enforcing' });

    await install('deployer-pw');

    const phases = progress.filter((event) => event.status === 'done').map((event) => event.phase);
    expect(phases).toEqual([
      'preflight',
      'download',
      'upload',
      'verify',
      'group',
      'extract',
      'selinux',
      'unit',
      'switch',
      'start',
      'cleanup',
      'health',
    ]);
  });

  it('reports upload progress in whole percent', async () => {
    const { progress, install } = setup();

    await install('deployer-pw');

    const percents = progress.filter(
      (event) => event.phase === 'upload' && event.percent !== undefined,
    );
    expect(percents.map((event) => event.percent)).toEqual([100]);
  });

  it('marks the step that failed', async () => {
    const { progress, install } = setup({
      failures: [{ match: 'tar -xzf', stderr: 'tar: disk full' }],
    });

    await expect(install('deployer-pw')).rejects.toThrow(/disk full/);
    expect(progress.at(-1)).toMatchObject({ phase: 'extract', status: 'failed' });
  });
});

/**
 * A server that can reach GitHub fetches the core itself, so the app downloads and uploads
 * nothing. The login user does it into the staging folder, and the root step checks the
 * checksum again either way. If the server's download fails on the day, the app does what it
 * always did.
 */
describe('installCore, when the server can fetch the core itself', () => {
  const doneIn = (progress: InstallProgress[]) =>
    progress.filter((event) => event.status === 'done').map((event) => event.phase);

  it('has the server download it, and the app downloads and uploads nothing', async () => {
    const { server, release, progress, install } = setup(
      { serverDownload: 'curl' },
      { remote: true },
    );

    const result = await install('deployer-pw');

    expect(result.version).toBe('1.53.0');
    expect(server.uploads).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(server.downloads).toHaveLength(1);
    expect(server.downloads[0]).toContain('curl');
    expect(server.downloads[0]).toContain(
      `https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-linux-x64.tar.gz`,
    );
    expect(server.downloads[0]).toContain(`${STAGING}/agentmate-core-1.53.0-linux-x64.tar.gz`);
    expect(doneIn(progress)).toEqual([
      'preflight',
      'fetch',
      'verify',
      'group',
      'extract',
      'unit',
      'switch',
      'start',
      'cleanup',
      'health',
    ]);
    expect(progress.some((event) => event.phase === 'download' || event.phase === 'upload')).toBe(
      false,
    );
  });

  it('checks the download again as root, from a folder only root can write to', async () => {
    const { server, install } = setup({ serverDownload: 'curl' }, { remote: true });

    await install('deployer-pw');

    const verify = server.rootCommands.find((command) => command.includes('sha256sum -c'));
    expect(verify).toContain(`cp -- ${STAGING}/agentmate-core-1.53.0-linux-x64.tar.gz `);
    expect(verify).toContain(SHA);
  });

  it('runs the download as the login user, never as root', async () => {
    const { server, install } = setup({ serverDownload: 'curl' }, { remote: true });

    await install('deployer-pw');

    expect(server.rootCommands.some((command) => command.includes('/releases/download/'))).toBe(
      false,
    );
  });

  it('does the same for a root login', async () => {
    const { server, install } = setup({ uid: 0, serverDownload: 'curl' }, { remote: true });

    await install();

    expect(server.downloads).toHaveLength(1);
    expect(server.uploads).toEqual([]);
    expect(server.rootCommands.some((command) => command.includes('/releases/download/'))).toBe(
      false,
    );
  });

  it('uses wget when that is what the server has', async () => {
    const { server, install } = setup({ serverDownload: 'wget' }, { remote: true });

    await install('deployer-pw');

    expect(server.downloads[0]).toContain('wget');
    expect(server.downloads[0]).not.toContain('curl');
  });

  it('removes the staging folder after the server downloaded into it', async () => {
    const { server, install } = setup({ serverDownload: 'curl' }, { remote: true });

    await install('deployer-pw');

    expect(server.commands).toContain(`rm -rf ${STAGING}`);
  });

  it('has the app get and upload the core when the server could not reach GitHub', async () => {
    const { server, release, progress, install } = setup(
      { serverDownload: null },
      { remote: true },
    );

    await install('deployer-pw');

    expect(server.downloads).toEqual([]);
    expect(server.uploads).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(doneIn(progress).slice(0, 4)).toEqual(['preflight', 'download', 'upload', 'verify']);
    expect(progress.some((event) => event.phase === 'fetch')).toBe(false);
  });

  it('does not ask the server about GitHub for a source with no public address', async () => {
    const { server, install } = setup({ serverDownload: 'curl' });

    await install('deployer-pw');

    expect(server.probes).toEqual([]);
    expect(server.downloads).toEqual([]);
    expect(server.uploads).toHaveLength(1);
  });

  it('falls back to the upload when the server fails to download, and says why', async () => {
    const { server, release, progress, install } = setup(
      {
        serverDownload: 'curl',
        downloadFailure: { stderr: 'curl: (6) Could not resolve host: github.com\n', exitCode: 6 },
      },
      { remote: true },
    );

    const result = await install('deployer-pw');

    expect(result.version).toBe('1.53.0');
    expect(server.downloads).toHaveLength(1);
    expect(server.uploads).toEqual([
      { path: `${STAGING}/agentmate-core-1.53.0-linux-x64.tar.gz`, bytes: 13, mode: 0o600 },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    const fetched = progress.find((event) => event.phase === 'fetch' && event.status === 'done');
    expect(fetched?.detail).toMatch(/Could not resolve host: github\.com.*sends it instead/);
    expect(doneIn(progress).slice(0, 5)).toEqual([
      'preflight',
      'fetch',
      'download',
      'upload',
      'verify',
    ]);
  });

  it('falls back when what the server downloaded does not match the checksum', async () => {
    const { server, progress, install } = setup(
      { serverDownload: 'curl', downloadFailure: { stderr: '', exitCode: CHECKSUM_MISMATCH_EXIT } },
      { remote: true },
    );

    await install('deployer-pw');

    expect(server.uploads).toHaveLength(1);
    const fetched = progress.find((event) => event.phase === 'fetch' && event.status === 'done');
    expect(fetched?.detail).toMatch(/does not match the published checksum/);
  });

  it('keeps one staging folder when it falls back, and removes it', async () => {
    const { server, install } = setup(
      { serverDownload: 'curl', downloadFailure: { stderr: 'curl: (28) timed out', exitCode: 28 } },
      { remote: true },
    );

    const staging = vi.spyOn(server, 'createStagingDirectory');

    await install('deployer-pw');

    expect(staging).toHaveBeenCalledTimes(1);
    expect(server.commands).toContain(`rm -rf ${STAGING}`);
  });

  it('stops with the app-side reason when neither the server nor the app can get the core', async () => {
    const { progress, install } = setup(
      { serverDownload: 'curl', downloadFailure: { stderr: 'curl: (22) 404', exitCode: 22 } },
      { remote: true, releaseError: new Error('github.com did not answer.') },
    );

    await expect(install('deployer-pw')).rejects.toThrow(/github\.com did not answer/);
    expect(progress.at(-1)).toMatchObject({ phase: 'download', status: 'failed' });
  });

  it('still refuses a mismatch that only the root check sees', async () => {
    const { server, install } = setup(
      {
        serverDownload: 'curl',
        failures: [{ match: 'sha256sum -c', stderr: '', exitCode: CHECKSUM_MISMATCH_EXIT }],
      },
      { remote: true },
    );

    await expect(install('deployer-pw')).rejects.toThrow(/does not match its published checksum/);
    expect(ran(server, 'tar -xzf')).toBe(false);
  });

  it('goes back to the previous release the same way after a server download', async () => {
    const { server, install } = setup(
      {
        serverDownload: 'curl',
        installed: { release: PREVIOUS, version: '1.52.0' },
        failures: [{ match: 'enable agentmate-core', stderr: 'failed' }],
      },
      { remote: true },
    );

    await expect(install('deployer-pw')).rejects.toThrow(/did not start.*back to 1\.52\.0/s);
    expect(server.rootCommands.some((command) => command.startsWith(`ln -sfn ${PREVIOUS} `))).toBe(
      true,
    );
  });
});

describe('uninstallCore', () => {
  function uninstallSetup(machine: Partial<ScriptedMachine> = {}) {
    const server = new ScriptedConnection(scriptedMachine(machine));
    const connect = vi.fn(async () => ({ connection: server, release: () => undefined }));
    const progress: InstallProgress[] = [];
    return {
      server,
      progress,
      uninstall: (keepData: boolean, sudoPassword: string | null = 'deployer-pw') =>
        uninstallCore(
          { connect },
          {
            serverId: 'srv-1',
            sudoPassword,
            keepData,
            onProgress: (event) => progress.push(event),
          },
        ),
    };
  }

  it('removes the service and the program, and keeps the data when asked', async () => {
    const { server, progress, uninstall } = uninstallSetup();

    await uninstall(true);

    expect(ran(server, 'systemctl disable --now agentmate-core')).toBe(true);
    expect(ran(server, 'rm -rf /opt/agentmate-core')).toBe(true);
    expect(ran(server, '/var/lib/agentmate-core')).toBe(false);
    expect(progress.filter((event) => event.status === 'done').map((event) => event.phase)).toEqual(
      ['stop', 'remove'],
    );
  });

  it('removes the data and the agentmate group when asked', async () => {
    const { server, uninstall } = uninstallSetup();

    await uninstall(false);

    expect(ran(server, 'rm -rf /var/lib/agentmate-core /etc/agentmate-core')).toBe(true);
    expect(ran(server, 'groupdel agentmate')).toBe(true);
  });

  it('needs root the same way an install does', async () => {
    const { server, uninstall } = uninstallSetup();

    await expect(uninstall(true, 'wrong')).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'sudo-password-rejected',
    );
    expect(server.rootCommands).toEqual([]);
  });

  it('stops at a step that fails and says why', async () => {
    const { progress, uninstall } = uninstallSetup({
      failures: [{ match: 'rm -rf /opt/agentmate-core', stderr: 'rm: Device or resource busy' }],
    });

    await expect(uninstall(true)).rejects.toThrow(/Device or resource busy/);
    expect(progress.at(-1)).toMatchObject({ phase: 'remove', status: 'failed' });
  });
});
