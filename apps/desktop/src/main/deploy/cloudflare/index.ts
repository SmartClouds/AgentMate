import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { registerCloudflareHandlers } from '../../ipc/cloudflare';
import { registerCloudflareServerHandlers } from '../../ipc/cloudflareServer';
import { getMainWindow } from '../../mainWindow';
import {
  decryptSecret,
  encryptSecret,
  isLockedEnvelope,
  registerSealedSecretStore,
} from '../../ssh/vault';
import { store } from '../../store';
import { isE2E } from '../../testMode';
import { addressesFromCore, addressesOfHost, type ServerAddresses } from './pointDomain';
import { CloudflareServerOps } from './serverOps';
import { CloudflareService } from './service';
import { CloudflareState, cloudflareFilePort } from './state';

/**
 * Wires the Cloudflare dialog into Electron. The token is sealed with the Servers vault, so it moves
 * with a passkey change like the Deploy device keys. "Point domain to this server" takes the
 * public addresses the server's core reports, and the saved server's host when the core is not
 * there or knows of none. The server-side flows (origin lock, Origin CA, DNS-01 tokens) ride the
 * server's lasting core connection.
 */

export interface CloudflareCoreAccess {
  call: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
  roles: (serverId: string) => string[] | null;
  onLinkConnection: <T>(
    serverId: string,
    work: (sshConnection: string | undefined) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
}

/** How long point-domain waits for a core's addresses before using the saved host. */
const CORE_ADDRESS_TIMEOUT_MS = 8_000;

/**
 * The recorded Cloudflare fake for e2e runs, served on loopback by the test. Honoured only in an
 * e2e run of an unpackaged build: a packaged app always talks to api.cloudflare.com.
 */
function cloudflareApiBase(): string | undefined {
  const base = process.env.RUNOVA_E2E_CLOUDFLARE_API;
  if (!isE2E || app.isPackaged || !base) return undefined;
  return /^http:\/\/127\.0\.0\.1:\d{1,5}\/client\/v4$/.test(base) ? base : undefined;
}

async function savedServerAddresses(
  serverId: string,
  core: CloudflareCoreAccess | undefined,
): Promise<ServerAddresses> {
  if (core) {
    try {
      const info = await Promise.race([
        core.call(serverId, (hub) => hub.getSystemInfo()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CORE_ADDRESS_TIMEOUT_MS),
        ),
      ]);
      const reported = addressesFromCore(info.publicAddresses);
      if (reported) return reported;
    } catch {
      // No core on this server, or it is not answering: the saved host still says where it is.
    }
  }
  const server = (await store.getSshServers()).find((candidate) => candidate.id === serverId);
  if (!server) throw new Error('This saved server no longer exists.');
  return addressesOfHost(server.host, (host) => lookup(host, { all: true, verbatim: true }));
}

export function registerCloudflareIpc(core?: CloudflareCoreAccess): void {
  const state = new CloudflareState(
    cloudflareFilePort(join(app.getPath('userData'), 'data', 'cloudflare.json')),
  );
  registerSealedSecretStore(state.sealedKeys);
  const baseURL = cloudflareApiBase();
  const service = new CloudflareService({
    state,
    seal: encryptSecret,
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    addresses: (serverId) => savedServerAddresses(serverId, core),
    ...(baseURL ? { baseURL, maxRetries: 0 } : {}),
  });
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    const win = getMainWindow();
    return (
      !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
    );
  };
  registerCloudflareHandlers({ ipc: ipcMain, service, guard });
  if (core) {
    registerCloudflareServerHandlers({
      ipc: ipcMain,
      ops: new CloudflareServerOps({
        cloudflare: service,
        links: { call: core.call },
        roles: core.roles,
        onLinkConnection: core.onLinkConnection,
        serverName: core.serverName,
      }),
      guard,
    });
  }
}
