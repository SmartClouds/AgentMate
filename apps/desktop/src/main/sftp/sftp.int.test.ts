import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  startSshServer,
} from '../../../e2e/sshServer';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import type { SftpBatchFinished, SftpQueueSnapshot } from '../../shared/sftpTypes';
import { SshConnection } from '../ssh/connection';
import type { SftpPool } from './client';
import { LocalBrowseRegistry } from './localBrowse';
import { SftpService } from './service';
import { describeSftpClientContract } from './testing/contract';

/**
 * The SFTP file manager (E25) against a real OpenSSH server in Docker (e2e/ssh-server): the
 * client contract on a real `SshConnection`, then the service the app runs, with a pool that
 * opens real connections, for folder round trips, deletes next to links, recursive chmod and the
 * remote editor's save. Skipped without Docker.
 */

/** dockerAvailable gives up after 15 s, which a Docker busy with other work can need. */
function dockerDetected(): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (dockerAvailable()) return true;
  }
  return false;
}

const docker = dockerDetected();
const TIMEOUT = 60_000;
const HOME = `/home/${SSH_USER}`;
const OWNER = 7;
const SERVER_ID = 'int-server';

let server: SshTestServer | null = null;
let shared: SshConnection | null = null;
let scratch = '';
let folders = 0;

function live(): SshTestServer {
  if (!server) throw new Error('The SSH server did not start.');
  return server;
}

/**
 * A shell command in the container, as the login user unless `user` says otherwise; `args` arrive
 * as $1, $2 and so on. serverExec keeps Node's 1 MB output limit, too small for some read backs.
 */
function exec(
  command: string,
  args: string[] = [],
  options: { user?: string; input?: string } = {},
) {
  return execFileSync(
    'docker',
    ['exec', '-i', '-u', options.user ?? SSH_USER, live().name, 'sh', '-c', command, 'sh', ...args],
    {
      encoding: 'utf-8',
      timeout: 30_000,
      input: options.input ?? '',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();
}

/** Read as root, so a folder the test locked its owner out of still answers. */
function modeOf(path: string): number {
  return Number.parseInt(exec('stat -c %a "$1"', [path], { user: 'root' }), 8);
}

function remoteSha256(path: string): string {
  return exec('sha256sum "$1" | cut -d" " -f1', [path]);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function open(): Promise<SshConnection> {
  const { host, port } = live();
  // No stored fingerprint: the key is trusted on first use, as for a newly saved server.
  return SshConnection.open({
    host,
    port,
    username: SSH_USER,
    authMethod: 'password',
    password: SSH_PASSWORD,
  });
}

/** A fresh folder under the login user's home, for one test. */
function freshRoot(prefix: string): string {
  folders += 1;
  const root = `${HOME}/${prefix}-${folders}`;
  exec('rm -rf "$1" && mkdir -p "$1"', [root]);
  return root;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentmate-sftp-int-'));
  if (!docker) return;
  server = await startSshServer();
  shared = await open();
}, 900_000);

afterAll(async () => {
  shared?.close();
  server?.stop();
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!docker)('the SFTP file manager against OpenSSH', () => {
  describeSftpClientContract(
    'SshConnection on OpenSSH',
    async () => {
      if (!shared?.isOpen) shared = await open();
      const root = freshRoot('contract');
      return {
        client: shared,
        root,
        seed: {
          dir: async (path, mode) => {
            exec('mkdir -p "$1" && chmod "$2" "$1"', [path, (mode ?? 0o755).toString(8)]);
          },
          file: async (path, content, options = {}) => {
            const bytes = typeof content === 'string' ? Buffer.from(content) : content;
            exec('base64 -d > "$1"', [path], { input: bytes.toString('base64') });
            if (options.mode !== undefined)
              exec('chmod "$2" "$1"', [path, options.mode.toString(8)]);
            if (options.mtimeMs !== undefined) {
              exec('touch -d "@$2" "$1"', [path, String(Math.floor(options.mtimeMs / 1000))]);
            }
          },
          link: async (path, target) => {
            exec('ln -s "$2" "$1"', [path, target]);
          },
        },
        read: async (path) => {
          const out = exec('[ -f "$1" ] && base64 -w0 "$1" || echo MISSING', [path]);
          return out === 'MISSING' ? null : Buffer.from(out, 'base64');
        },
        cleanup: async () => {
          exec('rm -rf "$1"', [root]);
        },
      };
    },
    { timeoutMs: TIMEOUT },
  );

  describe('through the service, on connections of its own', () => {
    let service: SftpService;
    let localBrowse: LocalBrowseRegistry;
    let sessionId = '';
    const opened: SshConnection[] = [];
    const finished: SftpBatchFinished[] = [];
    const waiters = new Map<string, (event: SftpBatchFinished) => void>();

    beforeAll(async () => {
      const pool: SftpPool = {
        acquire: async () => {
          const connection = await open();
          opened.push(connection);
          return { client: connection, release: () => connection.close() };
        },
        openSeparate: async () => {
          const connection = await open();
          opened.push(connection);
          return { client: connection, release: () => connection.close() };
        },
      };
      localBrowse = new LocalBrowseRegistry();
      service = new SftpService({
        pool,
        findServer: async () => ({
          nickname: 'Int server',
          host: live().host,
          port: live().port,
          username: SSH_USER,
        }),
        send: (_owner, channel, payload) => {
          if (channel !== IPC.sftp.onBatchFinished) return;
          const event = payload as SftpBatchFinished;
          finished.push(event);
          waiters.get(event.batchId)?.(event);
        },
        keepAwake: () => undefined,
        tempDir: () => join(scratch, 'edit-temp'),
        localBrowse,
      });
      sessionId = (await service.open(OWNER, SERVER_ID)).sessionId;
    }, TIMEOUT);

    afterAll(async () => {
      await service?.closeAll();
      for (const connection of opened) connection.close();
    }, TIMEOUT);

    /** Resolves with the batch's finished event, which may already have come. */
    function done(batchId: string): Promise<SftpBatchFinished> {
      const already = finished.find((event) => event.batchId === batchId);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.set(batchId, resolve));
    }

    async function batchOf(batchId: string): Promise<SftpQueueSnapshot['batches'][number]> {
      const snapshot = await service.queue(OWNER, sessionId);
      const batch = snapshot.batches.find((one) => one.batchId === batchId);
      if (!batch) throw new Error(`No batch ${batchId} in the queue.`);
      return batch;
    }

    it(
      'opens in the home folder and lists it',
      async () => {
        const listing = await service.list(OWNER, sessionId, '~');

        expect(listing.path).toBe(HOME);
        expect(listing.parent).toBe('/home');
      },
      TIMEOUT,
    );

    it('uploads a folder tree and downloads it back, byte for byte, never following a folder link', async () => {
      const remoteDir = freshRoot('roundtrip');
      const source = join(scratch, 'up');
      const big = randomBytes(5 * 1024 * 1024);
      const files: Record<string, Buffer> = {
        'site/index.html': Buffer.from('<h1>hello</h1>\n'),
        'site/assets/app.js': Buffer.from('console.log("hi");\n'),
        'site/assets/big.bin': big,
        'site/deep/a/b/c.txt': Buffer.from('deep'),
      };
      for (const [rel, bytes] of Object.entries(files)) {
        await mkdir(join(source, ...rel.split('/').slice(0, -1)), { recursive: true });
        await writeFile(join(source, ...rel.split('/')), bytes);
      }
      await mkdir(join(source, 'site', 'empty'), { recursive: true });

      const up = await service.upload(OWNER, sessionId, {
        localPaths: [join(source, 'site')],
        remoteDir,
      });
      const upEvent = await done(up.batchId);

      expect(upEvent).toMatchObject({ kind: 'upload', side: 'remote', ok: true, failed: 0 });
      expect(await batchOf(up.batchId)).toMatchObject({
        state: 'done',
        totalBytes: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
        failures: [],
      });
      for (const [rel, bytes] of Object.entries(files)) {
        expect(remoteSha256(`${remoteDir}/${rel}`)).toBe(sha256(bytes));
      }
      expect(exec('[ -d "$1" ] && echo dir', [`${remoteDir}/site/empty`])).toBe('dir');
      expect(exec('ls -A "$1"', [remoteDir])).toBe('site');

      // A link on the server to a folder outside the tree, which a download must not follow.
      exec('ln -s /etc "$1"', [`${remoteDir}/site/etc-link`]);
      const target = join(scratch, 'down');
      await mkdir(target, { recursive: true });
      localBrowse.record(OWNER, target);

      const down = await service.download(OWNER, sessionId, {
        remotePaths: [`${remoteDir}/site`],
        localDir: target,
      });
      const downEvent = await done(down.batchId);

      expect(downEvent).toMatchObject({ kind: 'download', side: 'local', ok: true, failed: 0 });
      expect(await batchOf(down.batchId)).toMatchObject({ skippedItems: 1, failures: [] });
      for (const [rel, bytes] of Object.entries(files)) {
        expect(sha256(await readFile(join(target, ...rel.split('/'))))).toBe(sha256(bytes));
      }
      expect((await stat(join(target, 'site', 'empty'))).isDirectory()).toBe(true);
      expect((await readdir(join(target, 'site'))).sort()).toEqual([
        'assets',
        'deep',
        'empty',
        'index.html',
      ]);
      const leftovers = (await readdir(target, { recursive: true })).filter((name) =>
        String(name).endsWith('.part'),
      );
      expect(leftovers).toEqual([]);
      exec('rm -rf "$1"', [remoteDir]);
    }, 180_000);

    it(
      'deletes a folder holding links to folders without touching what they point at',
      async () => {
        const root = freshRoot('delete');
        exec(
          [
            'mkdir -p "$1/victim/sub" "$1/keep"',
            'echo kept > "$1/keep/file.txt"',
            'echo gone > "$1/victim/sub/x.txt"',
            'ln -s /etc "$1/victim/linkdir"',
            'ln -s "$1/keep" "$1/victim/keeplink"',
            'ln -s "$1/keep/file.txt" "$1/victim/filelink"',
          ].join(' && '),
          [root],
        );
        const etcBefore = exec('ls -A /etc | wc -l');

        const { batchId } = await service.remove(OWNER, sessionId, [`${root}/victim`]);
        const event = await done(batchId);

        expect(event).toMatchObject({ kind: 'delete', ok: true, failed: 0 });
        expect(exec('ls -A "$1"', [root])).toBe('keep');
        expect(exec('cat "$1"', [`${root}/keep/file.txt`])).toBe('kept');
        expect(exec('ls -A /etc | wc -l')).toBe(etcBefore);
        expect(exec('[ -f /etc/passwd ] && echo there')).toBe('there');
        exec('rm -rf "$1"', [root]);
      },
      TIMEOUT,
    );

    it(
      'changes modes recursively, by scope, and skips links',
      async () => {
        const root = freshRoot('chmod');
        exec(
          [
            'mkdir -p "$1/tree/sub" "$1/outside"',
            'echo a > "$1/tree/a.txt"',
            'echo b > "$1/tree/sub/b.txt"',
            'echo o > "$1/outside/o.txt"',
            'chmod 644 "$1/tree/a.txt" "$1/tree/sub/b.txt" "$1/outside/o.txt"',
            'chmod 755 "$1/tree" "$1/tree/sub" "$1/outside"',
            'ln -s "$1/outside/o.txt" "$1/tree/o-link"',
            'ln -s "$1/outside" "$1/tree/outside-link"',
          ].join(' && '),
          [root],
        );

        const all = await service.chmod(OWNER, sessionId, {
          paths: [`${root}/tree`],
          mode: 0o700,
          recursive: 'all',
        });
        expect(await done(all.batchId)).toMatchObject({ kind: 'chmod', ok: true, failed: 0 });
        expect(modeOf(`${root}/tree`)).toBe(0o700);
        expect(modeOf(`${root}/tree/sub`)).toBe(0o700);
        expect(modeOf(`${root}/tree/a.txt`)).toBe(0o700);
        expect(modeOf(`${root}/tree/sub/b.txt`)).toBe(0o700);

        const filesOnly = await service.chmod(OWNER, sessionId, {
          paths: [`${root}/tree`],
          mode: 0o600,
          recursive: 'files',
        });
        expect(await done(filesOnly.batchId)).toMatchObject({ ok: true, failed: 0 });
        // Files only: no folder changes, the selected one included, so 600 cannot lock it.
        expect(modeOf(`${root}/tree`)).toBe(0o700);
        expect(modeOf(`${root}/tree/sub`)).toBe(0o700);
        expect(modeOf(`${root}/tree/a.txt`)).toBe(0o600);
        expect(modeOf(`${root}/tree/sub/b.txt`)).toBe(0o600);

        // Neither the linked file nor the linked folder was changed through its link.
        expect(modeOf(`${root}/outside/o.txt`)).toBe(0o644);
        expect(modeOf(`${root}/outside`)).toBe(0o755);
        exec('rm -rf "$1"', [root], { user: 'root' });
      },
      TIMEOUT,
    );

    it(
      'saves an edited text file in place, keeping its mode, and refuses a file changed meanwhile',
      async () => {
        const root = freshRoot('edit');
        const path = `${root}/index.html`;
        exec('printf "%s" "$2" > "$1" && chmod 640 "$1"', [path, 'Hello from the server\n']);

        const opened = await service.readText(OWNER, sessionId, path);
        expect(opened).toMatchObject({
          content: 'Hello from the server\n',
          mode: 0o640,
          bom: false,
        });

        const saved = await service.writeText(OWNER, sessionId, {
          path,
          content: 'Edited in AgentMate\n',
          bom: false,
          base: { size: opened.size, mtimeMs: opened.mtimeMs },
          force: false,
        });
        expect(saved).toMatchObject({ path, size: 20, mode: 0o640, owner: SSH_USER });
        expect(exec('cat "$1"', [path])).toBe('Edited in AgentMate');
        expect(modeOf(path)).toBe(0o640);
        expect(exec('ls -A "$1"', [root])).toBe('index.html');

        const reopened = await service.readText(OWNER, sessionId, path);
        expect(reopened.content).toBe('Edited in AgentMate\n');
        // SFTP mtimes are whole seconds; a change of size is seen whenever it happens.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        exec('echo "changed on the server" >> "$1"', [path]);

        const refused = await service
          .writeText(OWNER, sessionId, {
            path,
            content: 'Mine\n',
            bom: false,
            base: { size: reopened.size, mtimeMs: reopened.mtimeMs },
            force: false,
          })
          .catch((error: unknown) => error);
        expect(filesErrorCode(refused)).toBe('changedOnServer');
        expect(exec('tail -n 1 "$1"', [path])).toBe('changed on the server');

        await service.writeText(OWNER, sessionId, {
          path,
          content: 'Mine\n',
          bom: false,
          base: { size: reopened.size, mtimeMs: reopened.mtimeMs },
          force: true,
        });
        expect(exec('cat "$1"', [path])).toBe('Mine');
        expect(modeOf(path)).toBe(0o640);
        exec('rm -rf "$1"', [root]);
      },
      TIMEOUT,
    );
  });
});
