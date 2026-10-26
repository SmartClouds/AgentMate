import { HubConnectionState } from '@microsoft/signalr';
import { afterEach, describe, expect, it } from 'vitest';
import { coreHub, createCoreHubConnection } from './coreHub';
import { type FakeHubServer, startFakeHubServer } from './testing/fakeHubServer';
import { devTcpTransport } from './transport';

/**
 * The hub connection rides the same transport as REST: the WebSocket upgrade goes through the
 * tunnel, names the core's host and carries the access token as a header, and the typed client
 * generated from the C# contract talks to it.
 */

let server: FakeHubServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function fakeHub(options: { refuseWith?: number } = {}): Promise<FakeHubServer> {
  server = await startFakeHubServer(options);
  return server;
}

describe('createCoreHubConnection', () => {
  it('reaches the hub through the transport and calls it through the generated client', async () => {
    const { port, upgrades } = await fakeHub();
    const connection = createCoreHubConnection(devTcpTransport(port), () => 't0k');

    try {
      await connection.start();
      const pong = await coreHub(connection).ping();

      expect(pong).toEqual({ serverTimeUnixMs: 123 });
      expect(upgrades[0].url).toBe('/hubs/core');
      expect(upgrades[0].headers.host).toBe('runova-core');
      expect(upgrades[0].headers.authorization).toBe('Bearer t0k');
      expect(upgrades[0].headers.origin).toBeUndefined();
    } finally {
      await connection.stop();
    }
  });

  it('fails to start when the transport cannot connect', async () => {
    const connection = createCoreHubConnection(devTcpTransport(1), () => 't0k');

    await expect(connection.start()).rejects.toThrow();
  });

  it('reports the status the core refused the upgrade with, which SignalR leaves out', async () => {
    const { port } = await fakeHub({ refuseWith: 401 });
    const statuses: number[] = [];
    const connection = createCoreHubConnection(devTcpTransport(port), () => 'stale', undefined, {
      onUpgradeStatus: (status) => statuses.push(status),
    });

    await expect(connection.start()).rejects.toThrow();

    expect(statuses).toEqual([401]);
  });

  it('closes for good when the core drops it and reconnecting was turned off', async () => {
    const { port, drop } = await fakeHub();
    const connection = createCoreHubConnection(devTcpTransport(port), () => 't0k', undefined, {
      reconnect: false,
    });
    const closed = new Promise<Error | undefined>((resolve) => connection.onclose(resolve));
    let reconnecting = false;
    connection.onreconnecting(() => {
      reconnecting = true;
    });

    await connection.start();
    drop();

    expect(await closed).toBeInstanceOf(Error);
    expect(reconnecting).toBe(false);
    expect(connection.state).toBe(HubConnectionState.Disconnected);
  });
});
