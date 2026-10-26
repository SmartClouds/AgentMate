import { fileURLToPath } from 'node:url';
import {
  type HubConnection,
  HubConnectionState,
  type IStreamResult,
  type ISubscription,
} from '@microsoft/signalr';
import { expect } from 'vitest';
import type {
  JobInfo,
  JobStreamItem,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { SshConnectionPool } from '../../ssh/pool';
import { CoreSessions } from '../auth/coreSessions';
import { localArtifactSource } from '../bootstrap/releaseSource';
import { CoreHttpClient } from '../connection/coreHttp';
import { coreHub, createCoreHubConnection } from '../connection/coreHub';
import { streamLocalTransport } from '../connection/transport';
import { DeployService } from '../service';
import { DeployState } from '../state';
import { TEST_LOGINS, type TestServer } from './testServers';

/**
 * A real core on a test server for system tests: installed and this computer enrolled through
 * DeployService (from `pnpm server-core:publish linux-x64`), signed in, and the hub connected,
 * as the app does it. Also the job helpers those tests share.
 */

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url));
const ARTIFACTS = `${REPO}apps/server-core/artifacts/release`;

/** The owner account every system test signs in with. */
export const OWNER_PASSWORD = 'correct horse battery staple';

export function streamUntil<T>(
  stream: IStreamResult<T>,
  done: (items: T[]) => boolean,
  timeoutMs: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`The stream did not finish: ${JSON.stringify(items).slice(-3_000)}`));
    }, timeoutMs);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      subscription.dispose();
      if (error) reject(error);
      else resolve(items);
    };
    const subscription = stream.subscribe({
      next: (item) => {
        items.push(item);
        if (done(items)) finish();
      },
      error: (error) => finish(error),
      complete: () => (done(items) ? finish() : finish(new Error('The stream ended early.'))),
    });
  });
}

/** Follows a job to its end: its final state and every log line on the way. */
export async function runJob(hub: ICoreHub, job: JobInfo, timeoutMs: number) {
  const items = await streamUntil<JobStreamItem>(
    hub.streamJob(job.id, 0),
    (seen) => seen.some((item) => item.job && item.job.state !== 'running'),
    timeoutMs,
  );
  const final = [...items].reverse().find((item) => item.job)?.job;
  return { final, log: items.flatMap((item) => item.lines.map((line) => line.text)) };
}

export interface CoreSession {
  hub: ICoreHub;
  transport: ReturnType<typeof streamLocalTransport>;
  sessions: CoreSessions;
  stop: () => void;
}

/** Installs the core as root, enrolls this computer with an owner account, and connects the hub. */
export async function installAndConnect(
  server: TestServer,
  deviceName = 'System test',
): Promise<CoreSession> {
  const { username, password } = TEST_LOGINS.root;
  const pool = new SshConnectionPool({
    endpoint: async () => ({
      host: server.host,
      port: server.port,
      username,
      authMethod: 'password',
      password,
    }),
    trustHostKey: async () => undefined,
  });
  let file: unknown = null;
  const state = new DeployState({
    read: async () => file,
    write: async (value) => {
      file = value;
    },
  });
  const seal = async (plaintext: string) => ({
    mode: 'safeStorage' as const,
    ciphertext: Buffer.from(plaintext).toString('base64'),
  });
  const unseal = async (envelope: { ciphertext: string }) =>
    Buffer.from(envelope.ciphertext, 'base64').toString();
  const service = new DeployService({
    servers: async () => [
      {
        id: 'srv',
        nickname: 'Test server',
        host: server.host,
        port: server.port,
        username,
        authMethod: 'password',
        secretEnvelope: 'saved',
      },
    ],
    pool,
    state,
    releases: localArtifactSource(ARTIFACTS),
    seal,
    unseal,
    deviceName: () => deviceName,
    availableVersion: async () => '0.0.0-dev',
    devCorePort: null,
    progress: () => undefined,
  });
  const installed = await service.install({
    serverId: 'srv',
    sudoPassword: null,
    account: { userName: 'maria', password: OWNER_PASSWORD },
  });
  expect(installed.enrollmentError).toBeUndefined();

  const lease = await pool.acquire('srv');
  const transport = streamLocalTransport(lease.connection);
  const sessions = new CoreSessions({
    state,
    unseal,
    withCore: (_serverId, work) => work(new CoreHttpClient(transport)),
  });
  await sessions.signIn('srv', { password: OWNER_PASSWORD });

  // The core closes a hub connection when its access token runs out (15 minutes), as the app's
  // lasting link knows; a test that waits longer on a job connects again with a renewed token.
  let stopping = false;
  let connection: HubConnection;
  let typed: ICoreHub;
  let reconnecting: Promise<void> | null = null;
  // A new connection in place of `stale`, once, however many callers noticed it closed.
  const renew = (stale: HubConnection): Promise<void> => {
    if (connection === stale && !reconnecting) {
      reconnecting = open().finally(() => {
        reconnecting = null;
      });
    }
    return reconnecting ?? Promise.resolve();
  };
  const open = async () => {
    const next = createCoreHubConnection(transport, () => sessions.accessToken('srv'));
    await next.start();
    next.onclose(() => {
      if (!stopping) renew(next).catch(() => undefined);
    });
    connection = next;
    typed = coreHub(next);
  };
  await open();
  const ready = async () => {
    if (reconnecting) await reconnecting;
    else if (connection.state !== HubConnectionState.Connected) await renew(connection);
  };
  const hub = new Proxy({} as ICoreHub, {
    get: (_target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'streamJob') {
        return (...args: Parameters<ICoreHub['streamJob']>) =>
          resilientStream(() => {
            const used = connection;
            return { stream: () => typed.streamJob(...args), renew: () => renew(used) };
          }, ready);
      }
      return async (...args: unknown[]) => {
        await ready();
        const method = typed[name as keyof ICoreHub] as (...values: unknown[]) => unknown;
        return Reflect.apply(method, typed, args);
      };
    },
  });
  return {
    hub,
    transport,
    sessions,
    stop: () => {
      stopping = true;
      void connection.stop();
      lease.release();
      pool.closeAll();
    },
  };
}

const CLOSED = /connection (being|was) closed|not in the 'Connected' State/i;

/**
 * A stream that starts over on a new connection when the old one closed under it. Items come
 * again from the start then, which the tests here only read for a job's final state and its log.
 */
function resilientStream<T>(
  open: () => { stream: () => IStreamResult<T>; renew: () => Promise<void> },
  ready: () => Promise<void>,
): IStreamResult<T> {
  return {
    subscribe: (subscriber) => {
      let current: ISubscription<T> | null = null;
      let disposed = false;
      let retries = 0;
      const start = () => {
        if (disposed) return;
        let opened: ReturnType<typeof open> | null = null;
        const retry = (error: unknown) => {
          if (!disposed && CLOSED.test(String(error)) && retries++ < 5) {
            (opened ? opened.renew() : ready()).then(start, (failure) => subscriber.error(failure));
          } else {
            subscriber.error(error);
          }
        };
        try {
          opened = open();
          current = opened.stream().subscribe({
            next: (item) => subscriber.next(item),
            error: retry,
            complete: () => subscriber.complete(),
          });
        } catch (error) {
          retry(error);
        }
      };
      ready().then(start, (failure) => subscriber.error(failure));
      return {
        dispose: () => {
          disposed = true;
          current?.dispose();
        },
      } as ISubscription<T>;
    },
  };
}

/** Docker through the core's own install job; a slow network can time the repository out once. */
export async function installDocker(hub: ICoreHub): Promise<void> {
  let docker = await runJob(
    hub,
    await hub.installDocker({ removeConflictingPackages: true }),
    1_200_000,
  );
  for (let attempt = 1; attempt < 3 && docker.final?.state !== 'succeeded'; attempt++) {
    docker = await runJob(
      hub,
      await hub.installDocker({ removeConflictingPackages: true }),
      1_200_000,
    );
  }
  expect(docker.final?.state, docker.log.slice(-40).join('\n')).toBe('succeeded');
}
