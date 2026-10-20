import { describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { chmodRecursive, type RemoteOpEvent, removeRecursive } from './remoteOps';
import { FakeSftpServer, SFTP_STATUS } from './testing/fakeSftpClient';

/**
 * Recursive delete and chmod on the server (E25). Delete goes bottom up and unlinks links
 * without ever following them, so `ln -s /etc linkdir` leaves /etc alone; chmod never touches a
 * link or what it points at. A failure is reported and the rest carries on; abort stops both.
 */

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function site(): FakeSftpServer {
  return new FakeSftpServer()
    .file('/srv/site/a.txt', 'a')
    .file('/srv/site/css/x.css', 'x')
    .file('/srv/site/css/deep/y.css', 'y')
    .dir('/srv/site/empty')
    .file('/etc/passwd', 'root:x:0:0', { mode: 0o644 })
    .dir('/etc/conf', { mode: 0o755 })
    .link('/srv/site/etc', '/etc')
    .link('/srv/site/passwd', '/etc/passwd')
    .link('/srv/site/broken', '/nowhere');
}

function recorder(): { events: RemoteOpEvent[]; onItem: (event: RemoteOpEvent) => void } {
  const events: RemoteOpEvent[] = [];
  return { events, onItem: (event) => events.push(event) };
}

describe('removeRecursive', () => {
  it('removes a folder bottom up, each folder only after everything in it', async () => {
    const server = site();
    const { events, onItem } = recorder();
    const result = await removeRecursive(server.connect(), '/srv/site', { onItem });
    expect(server.exists('/srv/site')).toBe(false);
    expect(result).toMatchObject({ failed: 0, skipped: 0, firstError: null });
    expect(result.done).toBe(events.length);
    const order = server.calls
      .filter((call) => call.op === 'sftpUnlink' || call.op === 'sftpRmdir')
      .map((call) => call.path);
    for (const [index, path] of order.entries()) {
      for (const later of order.slice(index + 1)) {
        expect(later.startsWith(`${path}/`)).toBe(false);
      }
    }
    expect(order[order.length - 1]).toBe('/srv/site');
    expect(events.find((event) => event.path === '/srv/site/css')).toMatchObject({
      isDirectory: true,
      outcome: 'done',
    });
  });

  it('unlinks a link to a folder and leaves its target alone', async () => {
    const server = site();
    await removeRecursive(server.connect(), '/srv/site', {});
    expect(server.read('/etc/passwd')?.toString()).toBe('root:x:0:0');
    expect(server.exists('/etc/conf')).toBe(true);
    expect(server.callsOf('sftpListDetailed')).not.toContain('/srv/site/etc');
    expect(server.callsOf('sftpUnlink')).toEqual(
      expect.arrayContaining(['/srv/site/etc', '/srv/site/passwd', '/srv/site/broken']),
    );
  });

  it('removes a selected link itself, never what it points at', async () => {
    const server = site();
    const result = await removeRecursive(server.connect(), '/srv/site/etc', {});
    expect(result.done).toBe(1);
    expect(server.exists('/srv/site/etc')).toBe(false);
    expect(server.read('/etc/passwd')).not.toBeNull();
  });

  it('removes a single file', async () => {
    const server = site();
    const { events, onItem } = recorder();
    await removeRecursive(server.connect(), '/srv/site/a.txt', { onItem });
    expect(server.exists('/srv/site/a.txt')).toBe(false);
    expect(events).toEqual([
      { path: '/srv/site/a.txt', isDirectory: false, outcome: 'done', error: null },
    ]);
  });

  it('reports one failure and carries on with the rest, keeping the folder that still holds it', async () => {
    const server = site();
    server.failNext('sftpUnlink', '/srv/site/css/x.css', SFTP_STATUS.permissionDenied);
    const { events, onItem } = recorder();
    const result = await removeRecursive(server.connect(), '/srv/site', { onItem });
    expect(result.failed).toBe(1);
    expect(filesErrorCode(result.firstError)).toBe('permissionDenied');
    const failure = events.find((event) => event.outcome === 'failed');
    expect(failure).toMatchObject({ path: '/srv/site/css/x.css', isDirectory: false });
    expect(filesErrorCode(failure?.error)).toBe('permissionDenied');
    expect(server.exists('/srv/site/css/x.css')).toBe(true);
    expect(server.exists('/srv/site/css/deep')).toBe(false);
    expect(server.exists('/srv/site/a.txt')).toBe(false);
    expect(server.exists('/srv/site')).toBe(true);
    expect(server.callsOf('sftpRmdir')).not.toContain('/srv/site');
  });

  it('reports a folder it cannot list', async () => {
    const server = site();
    server.failNext('sftpListDetailed', '/srv/site/css', SFTP_STATUS.permissionDenied);
    const result = await removeRecursive(server.connect(), '/srv/site', {});
    expect(result.failed).toBe(1);
    expect(server.exists('/srv/site/css/x.css')).toBe(true);
    expect(server.exists('/srv/site/a.txt')).toBe(false);
  });

  it('reports a folder the server will not remove', async () => {
    const server = site();
    server.failNext('sftpRmdir', '/srv/site/empty', SFTP_STATUS.failure);
    const result = await removeRecursive(server.connect(), '/srv/site', {});
    expect(result.failed).toBe(1);
    expect(filesErrorCode(result.firstError)).toBe('server');
  });

  it('counts a path that is already gone as done', async () => {
    const server = site();
    const result = await removeRecursive(server.connect(), '/srv/site/none', {});
    expect(result).toEqual({ done: 0, failed: 0, skipped: 0, firstError: null });
  });

  it('refuses the root folder', async () => {
    const server = site();
    expect(filesErrorCode(await caught(removeRecursive(server.connect(), '/', {})))).toBe(
      'invalidInput',
    );
  });

  it('stops when aborted', async () => {
    const server = site();
    const controller = new AbortController();
    const gate = server.gate('sftpUnlink');
    const removing = caught(
      removeRecursive(server.connect(), '/srv/site', { signal: controller.signal }),
    );
    await gate.waitFor(1);
    controller.abort();
    gate.open();
    expect(filesErrorCode(await removing)).toBe('cancelled');
    expect(server.exists('/srv/site')).toBe(true);
  });

  it('passes on a failure to look the path up', async () => {
    const server = site();
    server.failNext('sftpListDetailed', '/srv/site', SFTP_STATUS.permissionDenied);
    const error = await caught(removeRecursive(server.connect(), '/srv/site/a.txt', {}));
    expect(filesErrorCode(error)).toBe('permissionDenied');
  });
});

describe('chmodRecursive', () => {
  it('changes only the folder itself without a scope', async () => {
    const server = site();
    const result = await chmodRecursive(server.connect(), '/srv/site', 0o750, 'none', {});
    expect(result).toMatchObject({ done: 1, failed: 0, skipped: 0 });
    expect(server.modeOf('/srv/site')).toBe(0o750);
    expect(server.modeOf('/srv/site/a.txt')).toBe(0o644);
  });

  it('changes a single file', async () => {
    const server = site();
    await chmodRecursive(server.connect(), '/srv/site/a.txt', 0o600, 'all', {});
    expect(server.modeOf('/srv/site/a.txt')).toBe(0o600);
  });

  it('changes everything inside with all, and skips every link', async () => {
    const server = site();
    const { events, onItem } = recorder();
    const result = await chmodRecursive(server.connect(), '/srv/site', 0o700, 'all', { onItem });
    for (const path of [
      '/srv/site',
      '/srv/site/a.txt',
      '/srv/site/css',
      '/srv/site/css/deep/y.css',
    ]) {
      expect(server.modeOf(path)).toBe(0o700);
    }
    expect(server.modeOf('/etc/passwd')).toBe(0o644);
    expect(server.modeOf('/etc')).toBe(0o755);
    expect(result).toMatchObject({ done: 7, skipped: 3, failed: 0 });
    expect(
      events
        .filter((event) => event.outcome === 'skipped')
        .map((event) => event.path)
        .sort(),
    ).toEqual(['/srv/site/broken', '/srv/site/etc', '/srv/site/passwd']);
    expect(server.callsOf('sftpChmod')).not.toContain('/srv/site/etc');
  });

  it('changes the files inside only with files', async () => {
    const server = site();
    await chmodRecursive(server.connect(), '/srv/site', 0o640, 'files', {});
    expect(server.modeOf('/srv/site')).toBe(0o755);
    expect(server.modeOf('/srv/site/a.txt')).toBe(0o640);
    expect(server.modeOf('/srv/site/css/deep/y.css')).toBe(0o640);
    expect(server.modeOf('/srv/site/css')).toBe(0o755);
  });

  it('changes the folders inside only with dirs', async () => {
    const server = site();
    await chmodRecursive(server.connect(), '/srv/site', 0o711, 'dirs', {});
    expect(server.modeOf('/srv/site/css')).toBe(0o711);
    expect(server.modeOf('/srv/site/css/deep')).toBe(0o711);
    expect(server.modeOf('/srv/site/empty')).toBe(0o711);
    expect(server.modeOf('/srv/site/a.txt')).toBe(0o644);
  });

  it('changes a folder before going in when the mode lets the owner in, after otherwise', async () => {
    const open = site();
    await chmodRecursive(open.connect(), '/srv/site/css', 0o755, 'dirs', {});
    expect(open.callsOf('sftpChmod')[0]).toBe('/srv/site/css');

    const closed = site();
    await chmodRecursive(closed.connect(), '/srv/site/css', 0o600, 'dirs', {});
    const calls = closed.callsOf('sftpChmod');
    expect(calls[calls.length - 1]).toBe('/srv/site/css');
    expect(calls.indexOf('/srv/site/css/deep')).toBeLessThan(calls.indexOf('/srv/site/css'));
  });

  it('skips a selected link and leaves its target alone', async () => {
    const server = site();
    const result = await chmodRecursive(server.connect(), '/srv/site/passwd', 0o777, 'none', {});
    expect(result).toMatchObject({ done: 0, skipped: 1 });
    expect(server.modeOf('/etc/passwd')).toBe(0o644);
  });

  it('reports a failure and carries on', async () => {
    const server = site();
    server.failNext('sftpChmod', '/srv/site/a.txt', SFTP_STATUS.permissionDenied);
    server.failNext('sftpListDetailed', '/srv/site/empty', SFTP_STATUS.permissionDenied);
    const result = await chmodRecursive(server.connect(), '/srv/site', 0o700, 'all', {});
    expect(result.failed).toBe(2);
    expect(filesErrorCode(result.firstError)).toBe('permissionDenied');
    expect(server.modeOf('/srv/site/css/x.css')).toBe(0o700);
  });

  it('fails when the path is not there', async () => {
    const server = site();
    const error = await caught(chmodRecursive(server.connect(), '/srv/none', 0o700, 'all', {}));
    expect(filesErrorCode(error)).toBe('remoteFolderMissing');
  });

  it('stops when aborted', async () => {
    const server = site();
    const controller = new AbortController();
    controller.abort();
    const error = await caught(
      chmodRecursive(server.connect(), '/srv/site', 0o700, 'all', { signal: controller.signal }),
    );
    expect(filesErrorCode(error)).toBe('cancelled');
    expect(server.modeOf('/srv/site')).toBe(0o755);
  });
});
