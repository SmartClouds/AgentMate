import { FakeCore } from '../../../../shared/deploy/testing/fakeCore';
import type { FakeCoreConnection } from '../../../../shared/deploy/testing/fakeCoreConnection';
import { CoreHttpClient } from '../../connection/coreHttp';
import { hubMessage } from '../../connection/hubErrors';
import type { DockerFilesBackend } from '../client';
import { type FakeFilesHttp, startFakeFilesHttp } from './fakeFilesHttp';

/**
 * A `DockerFilesBackend` on a `FakeCore` (E27): hub calls on one fake connection, made again
 * when it has dropped, with errors worded the way `DeployService.withHub` words them, and REST
 * calls to the fake's loopback endpoint with the session token the core wants.
 */

export const FAKE_FILES_TOKEN = 'files-token-1';

export interface FakeDockerFiles {
  core: FakeCore;
  http: FakeFilesHttp;
  backend: DockerFilesBackend;
  /** The hub connection the next call uses (a new one once this one has dropped). */
  connection(): FakeCoreConnection;
  /** Hub calls made, by method name order. */
  hubCalls: number;
  close(): Promise<void>;
}

export async function startFakeDockerFiles(now?: () => number): Promise<FakeDockerFiles> {
  const core = new FakeCore(now);
  core.files.token = FAKE_FILES_TOKEN;
  const http = await startFakeFilesHttp(core);
  let current = core.connect();
  const fixture: FakeDockerFiles = {
    core,
    http,
    hubCalls: 0,
    connection: () => {
      if (current.closed) current = core.connect();
      return current;
    },
    backend: {
      withHub: async (_serverId, work) => {
        fixture.hubCalls += 1;
        try {
          return await work(fixture.connection());
        } catch (error) {
          throw new Error(hubMessage(error));
        }
      },
      withCoreHttp: (_serverId, work) => work(new CoreHttpClient(http.transport), FAKE_FILES_TOKEN),
    },
    close: () => http.close(),
  };
  return fixture;
}
