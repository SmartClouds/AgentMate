import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileTarget } from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { describeSftpClientContract, type SftpClientHarness } from '../../sftp/testing/contract';
import type { ReleaseSource } from '../bootstrap/releaseSource';
import { CORE_HOST } from '../connection/coreHttp';
import { DEV_SERVER_ID, DeployService } from '../service';
import { DeployState } from '../state';
import { type DevHostCore, dotnetAvailable, startDevHostCore } from '../testing/devHostCore';
import { DockerFileClient, type DockerFilesBackend } from './client';
import { createDockerFilePool } from './pool';

/**
 * The Docker file client (E27) against a real server core: the DevHost, with its in-memory
 * Docker engine, signed in through DeployService the way the app does it, so the hub calls and
 * the REST transfers are the real ones. The E25 client contract runs on a running container with
 * a shell (toolbox) and on a volume (shop_uploads).
 *
 * The contract puts files, folders and links in place behind the client's back. The core has no
 * call for links or for setting an mtime, so the DevHost's loopback-only `POST /dev/files/seed`
 * does it, like its `/dev/enroll`: `{ kind, id, path, type: 'dir' | 'file' | 'link', mode?,
 * contentBase64?, mtimeUnixMs?, linkTarget? }`, parents made as needed, 204. Reads behind the
 * back go through a second file session.
 *
 * Skipped without the .NET SDK.
 */

const enabled = dotnetAvailable();
/** The DevHost's fixed development owner (see its DevHost.cs). */
const DEV_PASSWORD = 'agentmate-local-password';
const TIMEOUT = 60_000;

let devHost: DevHostCore | null = null;
let backend: DockerFilesBackend | null = null;
let folders = 0;

function seedOn(port: number, body: Record<string, unknown>): Promise<void> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dev/files/seed',
        headers: {
          host: CORE_HOST,
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else {
            reject(
              new Error(
                `The DevHost refused to seed ${String(body.path)} (${status}): ${Buffer.concat(chunks).toString()}`,
              ),
            );
          }
        });
      },
    );
    call.once('error', reject);
    call.end(payload);
  });
}

async function signedIn(port: number): Promise<DeployService> {
  let file: unknown = null;
  const state = new DeployState({
    read: async () => file,
    write: async (value) => {
      file = value;
    },
  });
  const service = new DeployService({
    servers: async () => [],
    pool: {
      acquire: async () => {
        throw new Error('The DevHost has no SSH.');
      },
      reset: () => undefined,
    },
    state,
    releases: {} as ReleaseSource,
    availableVersion: async () => null,
    devCorePort: port,
    progress: () => undefined,
    seal: async (plaintext) => ({
      mode: 'safeStorage' as const,
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
  });
  await service.access(DEV_SERVER_ID);
  await service.signIn({ serverId: DEV_SERVER_ID, password: DEV_PASSWORD });
  return service;
}

function live(): { port: number; backend: DockerFilesBackend } {
  if (!devHost || !backend) throw new Error('The DevHost did not start.');
  return { port: devHost.port, backend };
}

async function harness(target: FileTarget): Promise<SftpClientHarness> {
  const { port, backend: core } = live();
  const pool = createDockerFilePool({ backend: () => core });
  const id = `docker~${DEV_SERVER_ID}~${target.kind}~${target.id}`;
  const lease = await pool.acquire(id);
  // Reads behind the client's back go through a session of their own.
  const reader = await pool.acquire(id);
  folders += 1;
  const root = `/agentmate-contract-${process.pid}-${folders}`;
  const seed = (body: Record<string, unknown>) =>
    seedOn(port, { kind: target.kind, id: target.id, ...body });
  await seed({ path: root, type: 'dir' });
  return {
    client: lease.client,
    root,
    seed: {
      dir: (path, mode) => seed({ path, type: 'dir', ...(mode === undefined ? {} : { mode }) }),
      file: (path, content, options = {}) =>
        seed({
          path,
          type: 'file',
          contentBase64: Buffer.from(content).toString('base64'),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.mtimeMs === undefined ? {} : { mtimeUnixMs: options.mtimeMs }),
        }),
      link: (path, linkTarget) => seed({ path, type: 'link', linkTarget }),
    },
    read: async (path) => {
      const found = await reader.client.sftpStat(path);
      if (!found) return null;
      return reader.client.sftpReadRange(path, 0, Math.max(found.size, 1));
    },
    cleanup: async () => {
      lease.release();
      reader.release();
    },
  };
}

describe.skipIf(!enabled)('Docker files against the DevHost core', () => {
  beforeAll(async () => {
    devHost = await startDevHostCore();
    backend = asBackend(await signedIn(devHost.port));
  }, 300_000);

  afterAll(() => {
    devHost?.stop();
  });

  it(
    'opens a session on a container and says what it allows',
    async () => {
      const pool = createDockerFilePool({ backend: () => live().backend });
      const lease = await pool.acquire(`docker~${DEV_SERVER_ID}~container~toolbox`);
      const client = lease.client as DockerFileClient;

      expect(client.session).toMatchObject({
        target: { kind: 'container', id: 'toolbox' },
        displayName: 'toolbox',
      });
      expect(client.capabilities()).toEqual({
        rename: true,
        remove: true,
        chmod: true,
        edit: true,
      });
      lease.release();
    },
    TIMEOUT,
  );

  describeSftpClientContract(
    'DevHost container',
    () => harness({ kind: 'container', id: 'toolbox' }),
    {
      timeoutMs: TIMEOUT,
    },
  );
  describeSftpClientContract(
    'DevHost volume',
    () => harness({ kind: 'volume', id: 'shop_uploads' }),
    {
      timeoutMs: TIMEOUT,
    },
  );
});

/** DeployService.withHub and withCoreHttp are what the app hands the file manager. */
function asBackend(service: DeployService): DockerFilesBackend {
  return {
    withHub: (serverId, work) => service.withHub(serverId, work),
    withCoreHttp: (serverId, work) => service.withCoreHttp(serverId, work),
  };
}
