import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FtpTestServer, startFtpServer } from '../../../../e2e/ftpServer';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  serverExec,
  startSshServer,
} from '../../../../e2e/sshServer';
import type {
  FileSiteCustomLogin,
  FileSiteProtocol,
  FilesConflictChoice,
  FilesPlanChange,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
} from '../../../shared/deployFilesTypes';
import { setElectronPath } from '../../../test/main/electronMock';
import { openRemoteFiles, readHostKey } from './connect';
import { readHistory } from './history';
import { createPlanner, type FilesPlanner } from './plan';
import { createRunner, type FilesRunner } from './run';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * A deploy of an FTP or SFTP site end to end, the planner and the runner above the real
 * transports, against the servers in Docker: OpenSSH and ProFTPD's mod_sftp over SFTP with the
 * host key trusted, ProFTPD over FTPS with its self-signed certificate pinned, and vsftpd over
 * FTP with LIST only. Each server gets a site of its own, deployed step by step: a first deploy,
 * a plan with nothing to do, local edits, changes on the server, a cancelled run and its resume,
 * and the folder cleanup. The bases and the history live in a temporary userData folder.
 * Skipped without Docker.
 */

/** dockerAvailable gives up after 15 s, which a Docker busy with other work can need. */
function dockerDetected(): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (dockerAvailable()) return true;
  }
  return false;
}

const docker = dockerDetected();
const STEP_TIMEOUT = 180_000;
let openssh: SshTestServer | null = null;
let ftpServer: FtpTestServer | null = null;
let userData = '';

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'agentmate-deploy-int-'));
  if (!docker) return;
  [openssh, ftpServer] = await Promise.all([startSshServer(), startFtpServer()]);
}, 900_000);

afterAll(async () => {
  openssh?.stop();
  ftpServer?.stop();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}, STEP_TIMEOUT);

// The main setup clears every app.getPath override after each test, so point it again.
beforeEach(() => {
  setElectronPath('userData', userData);
});

interface Server {
  login: Omit<FileSiteCustomLogin, 'hostKeyFingerprint' | 'tlsPin'>;
  password: string;
  home: string;
  /** A shell command in the container as the login user; `args` arrive as $1, $2 and so on. */
  exec: (command: string, args?: string[]) => string;
}

interface Kind {
  name: string;
  slug: string;
  protocol: FileSiteProtocol;
  server: () => Server;
  /** What makes the login trusted: the host key the server presents, or the pinned certificate. */
  trust: (target: FilesConnectTarget) => Promise<Partial<FileSiteCustomLogin>>;
}

function loginOf(host: string, port: number, username: string): Server['login'] {
  return {
    kind: 'custom',
    host,
    port,
    username,
    authMethod: 'password',
    privateKeyPath: null,
    tlsServername: null,
  };
}

function ftpBox(): FtpTestServer {
  if (!ftpServer) throw new Error('The FTP server did not start.');
  return ftpServer;
}

function ftpExec(live: FtpTestServer): Server['exec'] {
  return (command, args = []) => live.exec(command, { args });
}

const trustHostKey: Kind['trust'] = async (target) => ({
  hostKeyFingerprint: await readHostKey(target),
});

const KINDS: Kind[] = [
  {
    name: 'OpenSSH SFTP, a login of its own with the host key trusted',
    slug: 'openssh',
    protocol: 'sftp',
    server: () => {
      if (!openssh) throw new Error('The SSH server did not start.');
      const live = openssh;
      return {
        login: loginOf(live.host, live.port, SSH_USER),
        password: SSH_PASSWORD,
        home: `/home/${SSH_USER}`,
        exec: (command, args = []) => serverExec(live, command, { args }),
      };
    },
    trust: trustHostKey,
  },
  {
    name: 'ProFTPD mod_sftp',
    slug: 'modsftp',
    protocol: 'sftp',
    server: () => {
      const live = ftpBox();
      return {
        login: loginOf(live.host, live.sftpPort, live.user),
        password: live.password,
        home: `/home/${live.user}`,
        exec: ftpExec(live),
      };
    },
    trust: trustHostKey,
  },
  {
    name: 'ProFTPD FTPS, self-signed certificate pinned',
    slug: 'ftps',
    protocol: 'ftps',
    server: () => {
      const live = ftpBox();
      return {
        login: loginOf(live.host, live.ftpsPort, live.user),
        password: live.password,
        home: `/home/${live.user}`,
        exec: ftpExec(live),
      };
    },
    trust: async () => ({ tlsPin: ftpBox().certFingerprint256 }),
  },
  {
    name: 'vsftpd FTP, LIST only',
    slug: 'vsftpd',
    protocol: 'ftp',
    server: () => {
      const live = ftpBox();
      return {
        login: loginOf(live.host, live.listOnlyPort, live.user),
        password: live.password,
        home: `/home/${live.user}`,
        exec: ftpExec(live),
      };
    },
    trust: async () => ({}),
  },
];

/** The first deploy: a nested folder, a name with spaces and non-ASCII letters, a folder of ours. */
const FIRST: Record<string, string> = {
  'index.html': '<h1>Hello</h1>',
  'css/site.css': 'body { color: red; }',
  'with space.txt': 'spaces in the name',
  'sub dir é/my file ü 日本.txt': 'unicode',
  'nested/deep/x.txt': 'two folders down',
  'theirs/kept.txt': 'in a folder the server already had',
};

const BULK_FILES = 10;
const BULK_BYTES = 2 * 1024 * 1024;

/** The parts of a planned change the steps check. */
function summary(changes: FilesPlanChange[]) {
  return changes
    .map((change) => ({
      path: change.path,
      local: change.local,
      action: change.action,
      conflict: change.conflict,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sorted(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function describeDeploy(kind: Kind): void {
  describe(kind.name, () => {
    const siteId = `int-${kind.slug}`;
    let server: Server;
    let site: StoredFileSite;
    let target: FilesConnectTarget;
    let planner: FilesPlanner;
    let runner: FilesRunner;
    let root = '';
    let local = '';
    let runs = 0;
    let onProgress: ((event: FilesProgressEvent) => void) | null = null;

    beforeAll(async () => {
      server = kind.server();
      root = `${server.home}/deploy-int-${kind.slug}`;
      server.exec('rm -rf "$1" && mkdir -p "$1/theirs"', [root]);
      local = await mkdtemp(join(tmpdir(), `agentmate-deploy-int-${kind.slug}-`));
      const untrusted: FilesConnectTarget = {
        protocol: kind.protocol,
        remoteRoot: root,
        login: {
          ...server.login,
          hostKeyFingerprint: null,
          tlsPin: null,
          secret: server.password,
        },
      };
      const trusted = await kind.trust(untrusted);
      const login: FileSiteCustomLogin = {
        ...server.login,
        hostKeyFingerprint: null,
        tlsPin: null,
        ...trusted,
      };
      target = {
        protocol: kind.protocol,
        remoteRoot: root,
        login: { ...login, secret: server.password },
      };
      site = {
        id: siteId,
        label: kind.name,
        protocol: kind.protocol,
        connection: { ...login, secretEnvelope: null },
        remoteRoot: root,
        localFolder: local,
        projectIds: [],
        deployOnSave: false,
        quietSeconds: 5,
        ignorePatterns: [],
        capabilities: null,
        lastDeploy: null,
        needsReview: null,
        createdAt: 1,
        updatedAt: 1,
      };
      const getSite = async (id: string) => (id === siteId ? site : null);
      const connectTarget = async () => target;
      planner = createPlanner({ getSite, connectTarget, openRemote: openRemoteFiles });
      runner = createRunner({
        takePlan: planner.take,
        getSite,
        connectTarget,
        openRemote: openRemoteFiles,
        onProgress: (event) => onProgress?.(event),
      });
    }, STEP_TIMEOUT);

    afterAll(async () => {
      try {
        server?.exec('rm -rf "$1"', [root]);
      } catch {
        // The container may already be gone.
      }
      if (local) await rm(local, { recursive: true, force: true }).catch(() => undefined);
    }, STEP_TIMEOUT);

    const localPath = (path: string) => join(local, ...path.split('/'));

    async function writeLocal(path: string, content: string | Buffer): Promise<void> {
      await mkdir(dirname(localPath(path)), { recursive: true });
      await writeFile(localPath(path), content);
    }

    /** The file on the server, null when it is not there. */
    function remoteText(path: string): string | null {
      const out = server.exec('[ -f "$1" ] && base64 -w0 "$1" || echo MISSING', [
        `${root}/${path}`,
      ]);
      return out === 'MISSING' ? null : Buffer.from(out, 'base64').toString('utf-8');
    }

    function remoteFiles(): string[] {
      const out = server.exec('cd "$1" && find . -type f', [root]);
      return sorted(
        out
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^\.\//, '')),
      );
    }

    function remoteDirExists(path: string): boolean {
      return server.exec('[ -d "$1" ] && echo yes || echo no', [`${root}/${path}`]) === 'yes';
    }

    function remoteMtime(path: string): number {
      return Number(server.exec('stat -c %Y "$1"', [`${root}/${path}`]));
    }

    async function plan(): Promise<FilesPlanView> {
      return planner.plan(siteId);
    }

    async function run(
      view: FilesPlanView,
      options: {
        /** The plan's paths to act on; all of them when left out. */
        paths?: string[];
        conflicts?: Record<string, FilesConflictChoice>;
        signal?: AbortSignal;
        progress?: (event: FilesProgressEvent) => void;
      } = {},
    ): Promise<FilesRunResult> {
      onProgress = options.progress ?? null;
      try {
        runs += 1;
        return await runner.run(
          {
            siteId,
            planId: view.planId,
            paths: options.paths ?? view.changes.map((change) => change.path),
            conflicts: options.conflicts ?? {},
            firstDeploy: null,
            reupload: [],
          },
          'user',
          options.signal,
        );
      } finally {
        onProgress = null;
      }
    }

    it(
      'sends every file on the first deploy, 0644 on SFTP, and writes the history',
      async () => {
        for (const [path, content] of Object.entries(FIRST)) await writeLocal(path, content);

        const view = await plan();
        expect(summary(view.changes)).toEqual(
          sorted(Object.keys(FIRST)).map((path) => ({
            path,
            local: 'added',
            action: 'upload',
            conflict: null,
          })),
        );
        expect(view.firstDeploy).toBeNull();

        const result = await run(view);
        expect(result).toMatchObject({
          state: 'done',
          uploaded: Object.keys(FIRST).length,
          deleted: 0,
          skipped: 0,
          failed: [],
          error: null,
        });
        expect(remoteFiles()).toEqual(sorted(Object.keys(FIRST)));
        for (const [path, content] of Object.entries(FIRST)) {
          expect(remoteText(path), path).toBe(content);
        }
        if (kind.protocol === 'sftp') {
          for (const path of Object.keys(FIRST)) {
            expect(server.exec('stat -c %a "$1"', [`${root}/${path}`]), path).toBe('644');
          }
        }

        const history = await readHistory(siteId);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          runId: result.runId,
          siteId,
          trigger: 'user',
          state: 'done',
          uploaded: Object.keys(FIRST).length,
        });
      },
      STEP_TIMEOUT,
    );

    it(
      'plans nothing to do right after a deploy, and a run of that plan sends nothing (AC1)',
      async () => {
        const view = await plan();
        expect(view.changes).toEqual([]);
        expect(view.missingOnServer).toEqual([]);
        expect(view.serverOnlyDrift).toEqual([]);
        expect(view.uploadBytes).toBe(0);

        const result = await run(view);
        expect(result).toMatchObject({ state: 'done', uploaded: 0, deleted: 0, skipped: 0 });
      },
      STEP_TIMEOUT,
    );

    it(
      'plans exactly the edited, deleted and added files, applies them, and leaves files only on the server alone (AC2)',
      async () => {
        server.exec(
          'printf %s "$2" > "$1/server-only.txt" && printf %s "$2" > "$1/sub dir é/theirs.txt"',
          [root, 'not from AgentMate'],
        );
        const serverOnlyTimes = [
          remoteMtime('server-only.txt'),
          remoteMtime('sub dir é/theirs.txt'),
        ];
        await writeLocal('with space.txt', 'spaces in the name, edited');
        await rm(localPath('sub dir é/my file ü 日本.txt'));
        await writeLocal('new file é.txt', 'brand new');

        const view = await plan();
        expect(summary(view.changes)).toEqual([
          { path: 'new file é.txt', local: 'added', action: 'upload', conflict: null },
          {
            path: 'sub dir é/my file ü 日本.txt',
            local: 'deleted',
            action: 'deleteRemote',
            conflict: null,
          },
          { path: 'with space.txt', local: 'modified', action: 'upload', conflict: null },
        ]);
        expect(view.deleteCount).toBe(1);

        const result = await run(view);
        expect(result).toMatchObject({
          state: 'done',
          uploaded: 2,
          deleted: 1,
          skipped: 0,
          failed: [],
        });
        expect(remoteText('sub dir é/my file ü 日本.txt')).toBeNull();
        expect(remoteText('with space.txt')).toBe('spaces in the name, edited');
        expect(remoteText('new file é.txt')).toBe('brand new');
        expect(remoteText('server-only.txt')).toBe('not from AgentMate');
        expect(remoteText('sub dir é/theirs.txt')).toBe('not from AgentMate');
        expect([remoteMtime('server-only.txt'), remoteMtime('sub dir é/theirs.txt')]).toEqual(
          serverOnlyTimes,
        );
        // AgentMate made this folder, but someone else's file in it keeps it.
        expect(remoteDirExists('sub dir é')).toBe(true);

        const after = await plan();
        expect(after.changes).toEqual([]);
      },
      STEP_TIMEOUT,
    );

    it(
      'reports a change on the server as a conflict, skips it without a choice and sends it on overwrite (AC3)',
      async () => {
        // A different size on the server.
        await writeLocal('index.html', '<h1>Hello, edited here</h1>');
        server.exec('printf %s "$2" > "$1"', [
          `${root}/index.html`,
          '<h1>Edited on the server</h1>!!',
        ]);
        // The same size, only a different time. One file only, so it cannot pass for a clock shift.
        const deployedCss = remoteText('css/site.css');
        await writeLocal('css/site.css', 'body { color: red;  }');
        const cssTime = remoteMtime('css/site.css');
        server.exec('touch -d "@$2" "$1"', [`${root}/css/site.css`, String(cssTime - 4321)]);
        expect(remoteText('css/site.css')).toBe(deployedCss);

        const conflicts = [
          {
            path: 'css/site.css',
            local: 'modified',
            action: 'conflict',
            conflict: 'changedOnServer',
          },
          {
            path: 'index.html',
            local: 'modified',
            action: 'conflict',
            conflict: 'changedOnServer',
          },
        ];
        const view = await plan();
        expect(summary(view.changes)).toEqual(conflicts);

        const skipped = await run(view);
        expect(skipped).toMatchObject({ state: 'done', uploaded: 0, skipped: 2, failed: [] });
        expect(remoteText('index.html')).toBe('<h1>Edited on the server</h1>!!');
        expect(remoteText('css/site.css')).toBe(deployedCss);
        expect(remoteMtime('css/site.css')).toBe(cssTime - 4321);

        const again = await plan();
        expect(summary(again.changes)).toEqual(conflicts);
        const sent = await run(again, {
          conflicts: { 'index.html': 'overwrite', 'css/site.css': 'overwrite' },
        });
        expect(sent).toMatchObject({ state: 'done', uploaded: 2, skipped: 0, failed: [] });
        expect(remoteText('index.html')).toBe('<h1>Hello, edited here</h1>');
        expect(remoteText('css/site.css')).toBe('body { color: red;  }');

        expect((await plan()).changes).toEqual([]);
      },
      STEP_TIMEOUT,
    );

    it(
      'resumes a cancelled run without sending the finished files again (AC5)',
      async () => {
        const bulk = Array.from(
          { length: BULK_FILES },
          (_, index) => `bulk/file-${String(index).padStart(2, '0')}.bin`,
        );
        for (const path of bulk) await writeLocal(path, randomBytes(BULK_BYTES));

        const first = await plan();
        expect(summary(first.changes).map((change) => change.path)).toEqual(bulk);

        const controller = new AbortController();
        const cancelled = await run(first, {
          signal: controller.signal,
          progress: (event) => {
            if (event.phase === 'uploading' && event.filesDone >= 1) controller.abort();
          },
        });
        expect(cancelled.state).toBe('cancelled');
        expect(cancelled.failed).toEqual([]);
        expect(cancelled.uploaded).toBeGreaterThan(0);
        expect(cancelled.uploaded).toBeLessThan(BULK_FILES);
        const remaining = BULK_FILES - cancelled.uploaded;

        const resumed = await plan();
        expect(resumed.changes).toHaveLength(remaining);
        // A file the cancelled run finished on the server but never recorded comes back as a
        // conflict here, its own upload taken for someone else's file.
        expect(
          resumed.changes
            .filter((change) => change.action !== 'upload')
            .map((change) => `${change.path}: ${change.action} ${change.conflict}`),
        ).toEqual([]);
        expect(resumed.uploadBytes).toBe(remaining * BULK_BYTES);

        const events: FilesProgressEvent[] = [];
        const done = await run(resumed, { progress: (event) => events.push(event) });
        expect(done).toMatchObject({
          state: 'done',
          uploaded: remaining,
          bytes: remaining * BULK_BYTES,
          failed: [],
        });
        expect(cancelled.uploaded + done.uploaded).toBe(BULK_FILES);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((event) => event.filesTotal === remaining)).toBe(true);
        expect(events.at(-1)).toMatchObject({ phase: 'done', filesDone: remaining });

        const sizes = server.exec(
          'cd "$1/bulk" && for f in *; do echo "$f $(stat -c %s "$f")"; done',
          [root],
        );
        expect(sorted(sizes.split('\n'))).toEqual(
          bulk.map((path) => `${path.slice('bulk/'.length)} ${BULK_BYTES}`),
        );
        expect(remoteFiles().filter((path) => path.endsWith('.part'))).toEqual([]);
        expect((await plan()).changes).toEqual([]);

        const history = await readHistory(siteId);
        expect(history).toHaveLength(runs);
        expect(history[1]).toMatchObject({ runId: cancelled.runId, state: 'cancelled' });
        expect(history[0]).toMatchObject({ runId: done.runId, state: 'done' });
      },
      STEP_TIMEOUT,
    );

    it(
      'removes the folders AgentMate made once their files are deleted here, never one it did not make',
      async () => {
        expect(remoteDirExists('nested/deep')).toBe(true);
        expect(remoteDirExists('theirs')).toBe(true);
        await rm(localPath('nested'), { recursive: true });
        await rm(localPath('theirs'), { recursive: true });

        // Only this step's paths, so a bulk file the step before left pending does not hide it.
        const own = (changes: FilesPlanChange[]) =>
          changes.filter((change) => !change.path.startsWith('bulk/'));
        const view = await plan();
        expect(summary(own(view.changes))).toEqual([
          { path: 'nested/deep/x.txt', local: 'deleted', action: 'deleteRemote', conflict: null },
          { path: 'theirs/kept.txt', local: 'deleted', action: 'deleteRemote', conflict: null },
        ]);
        const result = await run(view, { paths: own(view.changes).map((change) => change.path) });
        expect(result).toMatchObject({ state: 'done', deleted: 2, failed: [] });

        expect(remoteText('nested/deep/x.txt')).toBeNull();
        expect(remoteText('theirs/kept.txt')).toBeNull();
        expect(remoteDirExists('nested/deep')).toBe(false);
        expect(remoteDirExists('nested')).toBe(false);
        // The test made this one before the first deploy: it stays, empty.
        expect(remoteDirExists('theirs')).toBe(true);
        expect(remoteDirExists('sub dir é')).toBe(true);
        expect(remoteDirExists('css')).toBe(true);
        expect(remoteDirExists('')).toBe(true);
        expect(remoteText('server-only.txt')).toBe('not from AgentMate');
        expect(own((await plan()).changes)).toEqual([]);
      },
      STEP_TIMEOUT,
    );
  });
}

describe.skipIf(!docker)('Deploying an FTP or SFTP site against real servers', () => {
  for (const kind of KINDS) describeDeploy(kind);
});
