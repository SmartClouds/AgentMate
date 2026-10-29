import type { IpcMainInvokeEvent } from 'electron';
import type {
  DockerActionResult,
  DockerHubPullInput,
  DockerHubRepository,
  DockerHubStatus,
  DockerHubTag,
  DockerPullAuth,
} from '../../shared/apiTypes';
import { DOCKER_HUB } from '../../shared/deploy/registries';
import { IPC } from '../../shared/ipcChannels';
import { type DeployRegistries, RegistryLockedError } from '../deploy/registry/service';
import type { DockerHubSignIn } from '../docker/dockerHub';
import { type DeployIpcRegistry, object } from './deploy';

/**
 * The Docker page's Hub channels. The account is the Docker Hub sign-in deploys already use, so
 * there is one place to add or replace it. Like Deploy they answer only the main window, and
 * every name is checked before it is put in a Hub URL or handed to `docker pull`.
 */

export interface DockerHubHandlerDeps {
  ipc: DeployIpcRegistry;
  registries: Pick<DeployRegistries, 'list' | 'authsForRegistries'>;
  hub: {
    repositories: () => Promise<DockerHubRepository[]>;
    tags: (namespace: string, name: string) => Promise<DockerHubTag[]>;
  };
  pull: (ref: string, auth?: DockerPullAuth) => Promise<DockerActionResult>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

/** Docker Hub's rules for user, organisation and repository names, lower case only. */
const HUB_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_NAME = 255;

function hubName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_NAME || !HUB_NAME.test(value)) {
    throw new Error(`That is not a Docker Hub ${what}.`);
  }
  return value;
}

function pullInput(value: unknown): DockerHubPullInput {
  const input = object(value, 'an image to pull');
  if (typeof input.tag !== 'string' || !TAG.test(input.tag)) {
    throw new Error('That is not an image tag.');
  }
  return {
    namespace: hubName(input.namespace, 'user name'),
    name: hubName(input.name, 'repository name'),
    tag: input.tag,
    isPrivate: input.isPrivate === true,
  };
}

/** The saved Docker Hub sign-in, unsealed, or null when there is none. */
export function dockerHubSignIn(
  registries: Pick<DeployRegistries, 'authsForRegistries'>,
): () => Promise<DockerHubSignIn | null> {
  return async () => {
    try {
      const [auth] = await registries.authsForRegistries([DOCKER_HUB]);
      return auth ? { username: auth.username, secret: auth.secret } : null;
    } catch (error) {
      if (error instanceof RegistryLockedError) {
        throw new Error('Unlock the Servers passkey to use your Docker Hub sign-in.');
      }
      throw error;
    }
  };
}

export function registerDockerHubHandlers(deps: DockerHubHandlerDeps): void {
  const { ipc, registries, hub, pull } = deps;
  const signIn = dockerHubSignIn(registries);
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Docker Hub is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.dockerHub.status, async (): Promise<DockerHubStatus> => {
    const credential = (await registries.list()).find((item) => item.kind === 'dockerhub');
    if (!credential) return { state: 'signedOut', username: null };
    return { state: credential.locked ? 'locked' : 'signedIn', username: credential.username };
  });

  handle(IPC.dockerHub.repositories, () => hub.repositories());

  handle(IPC.dockerHub.tags, (namespace, name) =>
    hub.tags(hubName(namespace, 'user name'), hubName(name, 'repository name')),
  );

  handle(IPC.dockerHub.pull, async (value) => {
    const input = pullInput(value);
    // Official images live under "library", which docker spells without a namespace.
    const repository =
      input.namespace === 'library' ? input.name : `${input.namespace}/${input.name}`;
    const auth = input.isPrivate ? ((await signIn()) ?? undefined) : undefined;
    return pull(`${repository}:${input.tag}`, auth);
  });
}
