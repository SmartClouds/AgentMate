import type { StoredSshServer } from '../../shared/apiTypes';
import { orderById } from '../../shared/orderById';
import { store } from '../store';
import type { SshEndpoint } from './connectConfig';
import type { PoolSource } from './pool';
import { decryptSecret } from './vault';

/**
 * Saved SSH servers (the Remote section's list) as connection endpoints, and the one write queue
 * for `ssh-servers.json`. Terminal sessions and Deploy connections both record host keys and
 * connect times here; without a shared queue their read-modify-write cycles could interleave and
 * one would silently lose the other's change.
 */

let updateQueue: Promise<void> = Promise.resolve();

export function updateSshServer(
  id: string,
  update: (server: StoredSshServer) => StoredSshServer,
): Promise<void> {
  const next = updateQueue.then(async () => {
    const servers = await store.getSshServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index < 0) return;
    const updated = [...servers];
    updated[index] = update(updated[index]);
    await store.setSshServers(updated);
  });
  updateQueue = next.catch(() => undefined);
  return next;
}

/**
 * Saves the servers in the order the Remote page's list was dragged into and returns them. It runs
 * on the same queue as `updateSshServer`, so a connect finishing mid-drop can't lose either write.
 */
export function reorderSshServers(orderedIds: string[]): Promise<StoredSshServer[]> {
  let reordered: StoredSshServer[] = [];
  const next = updateQueue.then(async () => {
    reordered = orderById(await store.getSshServers(), orderedIds);
    await store.setSshServers(reordered);
  });
  updateQueue = next.catch(() => undefined);
  return next.then(() => reordered);
}

export async function findSavedServer(serverId: string): Promise<StoredSshServer> {
  const server = (await store.getSshServers()).find((s) => s.id === serverId);
  if (!server) throw new Error('This saved server no longer exists.');
  return server;
}

/** The endpoint for a saved server with its password or key passphrase decrypted. */
export async function savedServerEndpoint(serverId: string): Promise<SshEndpoint> {
  const server = await findSavedServer(serverId);
  let password: string | undefined;
  let passphrase: string | undefined;
  if (server.secretEnvelope) {
    const secret = await decryptSecret(server.secretEnvelope);
    if (server.authMethod === 'password') password = secret;
    else passphrase = secret;
  }
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    authMethod: server.authMethod,
    password,
    privateKeyPath: server.privateKeyPath,
    passphrase,
    storedFingerprint: server.hostKeyFingerprint,
  };
}

/** Where the Deploy connection pool gets its endpoints and records what it learned. */
export const savedServerPoolSource: PoolSource = {
  endpoint: savedServerEndpoint,
  // First use only: never replace a key that was already trusted.
  trustHostKey: (serverId, fingerprint) =>
    updateSshServer(serverId, (s) => ({
      ...s,
      hostKeyFingerprint: s.hostKeyFingerprint ?? fingerprint,
    })),
  connected: (serverId) => {
    void updateSshServer(serverId, (s) => ({ ...s, lastConnectedAt: Date.now() }));
  },
};
